/**
 * Dashboard Routes - Web UI for managing MCP Gateway
 */

import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BackendManager } from '../backend/index.js';
import ConfigManager from '../config.js';
import { ServerConfigSchema, ServerConfig } from '../types.js';
import { logger } from '../logger.js';
import {
  getCachedUsageData,
  getUsageByDateRange,
  getCurrentSessionUsage,
  clearUsageCache,
} from '../services/claude-usage.js';
import {
  getAntigravitySummary,
  clearAntigravityCache,
  hasAntigravityAccounts,
} from '../services/antigravity-usage.js';

// Helper to find which backend a tool belongs to based on prefix
function findBackendIdForTool(toolName: string, backendManager: BackendManager): string | null {
  // Build prefix map dynamically from connected backends
  const backends = backendManager.getBackends();

  // First, try to match by tool prefix from config
  for (const [id, backend] of backends) {
    const prefix = backend.config.toolPrefix;
    if (prefix && toolName.startsWith(prefix + '_')) {
      return id;
    }
  }

  // Fallback: check backends directly for exact tool match
  for (const [id, backend] of backends) {
    if (backend.tools.some(t => t.name === toolName)) {
      return id;
    }
  }

  return null;
}

// Helper to persist current UI state
function persistUIState(backendManager: BackendManager): void {
  const configManager = ConfigManager.getInstance();
  configManager.saveUIState({
    disabledTools: Array.from(backendManager.getDisabledTools()),
    disabledBackends: Array.from(backendManager.getDisabledBackends()),
  });
}

export function createDashboardRoutes(backendManager: BackendManager): Router {
  const router = Router();

  // Serve the dashboard HTML
  router.get('/', (_req: Request, res: Response) => {
    res.send(getDashboardHTML());
  });

  // API: Get all tools with their enabled status (including from disabled backends)
  router.get('/api/tools', (_req: Request, res: Response) => {
    const tools = backendManager.getAllToolsIncludingDisabled();
    const disabledTools = backendManager.getDisabledTools();
    const disabledBackends = backendManager.getDisabledBackends();

    const toolsWithStatus = tools.map(tool => {
      // Prefer authoritative mapping from backend manager; fall back to prefix heuristic
      const backendId =
        typeof backendManager.getBackendForTool === 'function'
          ? backendManager.getBackendForTool(tool.name)
          : findBackendIdForTool(tool.name, backendManager);

      const backendDisabled = backendId ? disabledBackends.has(backendId) : false;

      return {
        ...tool,
        backendId,
        enabled: !disabledTools.has(tool.name) && !backendDisabled,
        backendDisabled,
      };
    });

    res.json({ tools: toolsWithStatus });
  });

  // API: Get backends status
  router.get('/api/backends', (_req: Request, res: Response) => {
    const status = backendManager.getStatus();
    const disabledBackends = backendManager.getDisabledBackends();
    const backends = backendManager.getBackends();

    const backendsWithStatus = Object.entries(status).map(([id, info]) => {
      const backend = backends.get(id);
      return {
        id,
        ...info,
        enabled: !disabledBackends.has(id),
        toolPrefix: backend?.config.toolPrefix || id, // Include tool prefix for frontend
      };
    });

    res.json({ backends: backendsWithStatus });
  });

  // API: Get feature flags (optional features that can be enabled/disabled)
  router.get('/api/feature-flags', (_req: Request, res: Response) => {
    const configManager = ConfigManager.getInstance();
    res.json({
      features: configManager.getFeatureFlags(),
    });
  });

  // API: Toggle tool
  router.post('/api/tools/:name/toggle', (req: Request, res: Response) => {
    const { name } = req.params;
    const { enabled } = req.body;

    if (enabled) {
      // If enabling a tool, also enable its backend if disabled
      const backendId = findBackendIdForTool(name, backendManager);
      if (backendId && backendManager.getDisabledBackends().has(backendId)) {
        backendManager.enableBackend(backendId);
      }
      backendManager.enableTool(name);
    } else {
      backendManager.disableTool(name);
    }

    // Persist state to file
    persistUIState(backendManager);

    res.json({ success: true, name, enabled });
  });

  // API: Toggle backend
  router.post('/api/backends/:id/toggle', (req: Request, res: Response) => {
    const { id } = req.params;
    const { enabled } = req.body;

    if (enabled) {
      backendManager.enableBackend(id);
    } else {
      backendManager.disableBackend(id);
    }

    // Persist state to file
    persistUIState(backendManager);

    res.json({ success: true, id, enabled });
  });

  // API: Bulk enable/disable tools
  router.post('/api/tools/bulk', (req: Request, res: Response) => {
    const { tools, enabled } = req.body as { tools: string[]; enabled: boolean };

    for (const name of tools) {
      if (enabled) {
        backendManager.enableTool(name);
      } else {
        backendManager.disableTool(name);
      }
    }

    // Persist state to file
    persistUIState(backendManager);

    res.json({ success: true, count: tools.length, enabled });
  });

  // API: Get stats
  router.get('/api/stats', (_req: Request, res: Response) => {
    const allTools = backendManager.getAllTools();
    const enabledTools = backendManager.getEnabledTools();
    const disabledTools = backendManager.getDisabledTools();

    res.json({
      totalTools: allTools.length,
      enabledTools: enabledTools.length,
      disabledTools: disabledTools.size,
      backends: backendManager.getStatus(),
    });
  });

  // API: Trigger Fabric login (az login with Fabric scope)
  router.post('/api/fabric/login', async (_req: Request, res: Response) => {
    try {
      const scriptCandidates = [
        path.resolve(process.cwd(), 'scripts/fabric-login.sh'),
        path.resolve(process.cwd(), '../scripts/fabric-login.sh'),
      ];

      const scriptPath = scriptCandidates.find(p => fs.existsSync(p));
      const command =
        process.env.FABRIC_LOGIN_CMD ||
        (scriptPath ? `"${scriptPath}"` : 'az login --scope https://api.fabric.microsoft.com/.default');

      // Run the login command with a timeout; stream output is not returned to client
      await new Promise<void>((resolve, reject) => {
        exec(
          command,
          {
            timeout: 120_000,
          },
          (error, _stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message));
            } else {
              resolve();
            }
          }
        );
      });

      res.json({
        success: true,
        message: scriptPath
          ? `Fabric login started via script: ${scriptPath}`
          : 'Fabric login started (az login with Fabric scope)',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start Fabric login',
      });
    }
  });

  // API: Check Fabric token validity by fetching workspaces
  router.post('/api/fabric/check', async (_req: Request, res: Response) => {
    try {
      // Get token JSON for expiresOn and access token
      const tokenJson = await new Promise<string>((resolve, reject) => {
        exec(
          'az account get-access-token --resource https://api.fabric.microsoft.com',
          { timeout: 15000 },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message));
            } else {
              resolve(stdout);
            }
          }
        );
      });

      const tokenData = JSON.parse(tokenJson);
      const accessToken = tokenData.accessToken;
      const expiresOn = tokenData.expiresOn || tokenData.expires_on;

      if (!accessToken) {
        throw new Error('No access token returned by az CLI');
      }

      // Probe Fabric workspaces to validate the token
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let workspaceOk = false;
      let workspaceError: string | undefined;
      try {
        const resp = await fetch('https://api.fabric.microsoft.com/v1/workspaces', {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        workspaceOk = resp.ok;
        if (!resp.ok) {
          const body = await resp.text();
          workspaceError = `HTTP ${resp.status}: ${body}`;
        }
      } catch (e) {
        workspaceError = e instanceof Error ? e.message : 'Unknown error';
      } finally {
        clearTimeout(timeout);
      }

      res.json({
        success: true,
        expiresOn,
        workspaceProbe: workspaceOk ? 'ok' : 'failed',
        workspaceError,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check Fabric token',
      });
    }
  });

  // API: Restart server
  // Requires confirmation token to prevent accidental restarts
  router.post('/api/restart', (req: Request, res: Response) => {
    const { confirm } = req.body;

    // Require explicit confirmation
    if (confirm !== 'restart-confirmed') {
      res.status(400).json({
        success: false,
        error: 'Restart requires confirmation',
        message: 'Send { "confirm": "restart-confirmed" } to confirm the restart',
      });
      return;
    }

    logger.warn('Server restart requested via dashboard API');

    res.json({ success: true, message: 'Server restarting...' });

    // Give time for the response to be sent, then exit gracefully
    // The process manager (pm2, systemd, etc.) or npm script should restart it
    setTimeout(async () => {
      // Attempt graceful shutdown
      logger.info('Initiating graceful restart...');
      try {
        await backendManager.disconnectAll();
      } catch (error) {
        logger.error('Error during graceful shutdown', { error });
      }
      process.exit(0);
    }, 500);
  });

  // API: Get a specific server configuration
  router.get('/api/servers/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const configManager = ConfigManager.getInstance();
    const server = configManager.getServer(id);

    if (!server) {
      res.status(404).json({ error: `Server '${id}' not found` });
      return;
    }

    res.json({ server });
  });

  // API: Add a new server
  router.post('/api/servers', async (req: Request, res: Response) => {
    try {
      // Validate the server configuration
      const parseResult = ServerConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid server configuration',
          details: parseResult.error.errors,
        });
        return;
      }

      const serverConfig: ServerConfig = parseResult.data;
      const configManager = ConfigManager.getInstance();

      // Check if server ID already exists
      if (configManager.getServer(serverConfig.id)) {
        res.status(409).json({ error: `Server with ID '${serverConfig.id}' already exists` });
        return;
      }

      // Add to config file
      configManager.addServer(serverConfig);

      // If enabled, add to backend manager and connect
      if (serverConfig.enabled) {
        await backendManager.addBackend(serverConfig);
      }

      res.json({ success: true, server: serverConfig });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to add server',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Update an existing server
  router.put('/api/servers/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const configManager = ConfigManager.getInstance();

      // Check if server exists
      const existingServer = configManager.getServer(id);
      if (!existingServer) {
        res.status(404).json({ error: `Server '${id}' not found` });
        return;
      }

      // Validate the new server configuration
      const parseResult = ServerConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid server configuration',
          details: parseResult.error.errors,
        });
        return;
      }

      const serverConfig: ServerConfig = parseResult.data;

      // Update config file
      configManager.updateServer(id, serverConfig);

      // Update backend manager (disconnect old, connect new if enabled)
      await backendManager.updateBackend(id, serverConfig);

      res.json({ success: true, server: serverConfig });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to update server',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Delete a server
  router.delete('/api/servers/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const configManager = ConfigManager.getInstance();

      // Check if server exists
      const existingServer = configManager.getServer(id);
      if (!existingServer) {
        res.status(404).json({ error: `Server '${id}' not found` });
        return;
      }

      // Remove from backend manager first (disconnect)
      await backendManager.removeBackend(id);

      // Remove from config file
      configManager.deleteServer(id);

      res.json({ success: true, id });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to delete server',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Test server connection
  router.post('/api/servers/test', async (req: Request, res: Response) => {
    try {
      // Validate the server configuration
      const parseResult = ServerConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid server configuration',
          details: parseResult.error.errors,
        });
        return;
      }

      const serverConfig: ServerConfig = parseResult.data;

      // Test the connection
      const result = await backendManager.testBackendConnection(serverConfig);

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to test connection',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Export server configuration
  router.get('/api/config/export', (_req: Request, res: Response) => {
    try {
      const configManager = ConfigManager.getInstance();
      const config = configManager.getServersConfig();

      // Set headers for file download
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="mcp-gateway-config-${new Date().toISOString().split('T')[0]}.json"`
      );

      res.json({
        exportedAt: new Date().toISOString(),
        version: '1.0',
        servers: config.servers,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to export configuration',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Import server configuration
  router.post('/api/config/import', async (req: Request, res: Response) => {
    try {
      const { servers, merge = false } = req.body;

      if (!servers || !Array.isArray(servers)) {
        res.status(400).json({ error: 'Invalid import data: servers array required' });
        return;
      }

      // Validate each server configuration
      const validatedServers: ServerConfig[] = [];
      const errors: Array<{ index: number; error: string }> = [];

      for (let i = 0; i < servers.length; i++) {
        const parseResult = ServerConfigSchema.safeParse(servers[i]);
        if (parseResult.success) {
          validatedServers.push(parseResult.data);
        } else {
          errors.push({
            index: i,
            error: parseResult.error.errors.map(e => e.message).join(', '),
          });
        }
      }

      if (errors.length > 0 && !merge) {
        res.status(400).json({
          error: 'Invalid server configurations',
          details: errors,
        });
        return;
      }

      const configManager = ConfigManager.getInstance();
      let imported = 0;
      let skipped = 0;

      if (!merge) {
        // Full replace: disconnect all existing backends first
        await backendManager.disconnectAll();
      }

      for (const server of validatedServers) {
        const existing = configManager.getServer(server.id);

        if (existing) {
          if (merge) {
            // In merge mode, skip existing servers
            skipped++;
            continue;
          } else {
            // In replace mode, update existing
            configManager.updateServer(server.id, server);
            if (server.enabled) {
              await backendManager.addBackend(server);
            }
          }
        } else {
          // Add new server
          configManager.addServer(server);
          if (server.enabled) {
            await backendManager.addBackend(server);
          }
        }
        imported++;
      }

      res.json({
        success: true,
        imported,
        skipped,
        total: validatedServers.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to import configuration',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================
  // Gateway Settings API Routes
  // ==========================================

  // API: Get gateway settings
  router.get('/api/gateway-settings', (_req: Request, res: Response) => {
    try {
      const configManager = ConfigManager.getInstance();
      const settings = configManager.getGatewaySettings();
      const isLiteModeFromEnv = process.env.GATEWAY_LITE_MODE === '1' || process.env.GATEWAY_LITE_MODE === 'true';

      res.json({
        ...settings,
        liteModeSource: isLiteModeFromEnv ? 'env' : 'ui',
        effectiveLiteMode: configManager.isLiteModeEnabled(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get gateway settings',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Update gateway settings
  router.post('/api/gateway-settings', (req: Request, res: Response) => {
    try {
      const { liteMode } = req.body;
      const configManager = ConfigManager.getInstance();

      configManager.updateGatewaySettings({ liteMode: Boolean(liteMode) });

      res.json({
        success: true,
        settings: configManager.getGatewaySettings(),
        message: 'Settings saved. Restart the gateway for changes to take effect.',
        requiresRestart: true,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to update gateway settings',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================
  // Claude Usage API Routes
  // ==========================================

  // Helper to check if Claude usage feature is enabled
  const requireClaudeUsageEnabled = (res: Response): boolean => {
    if (!configManager.isClaudeUsageEnabled()) {
      res.status(404).json({
        error: 'Feature disabled',
        message: 'Claude Usage feature is not enabled. Set ENABLE_CLAUDE_USAGE=1 in your environment to enable it.',
      });
      return false;
    }
    return true;
  };

  // API: Get Claude usage summary
  router.get('/api/claude-usage', async (_req: Request, res: Response) => {
    if (!requireClaudeUsageEnabled(res)) return;
    try {
      const usageData = await getCachedUsageData();
      if (!usageData) {
        res.status(503).json({
          error: 'Usage data not available',
          message: 'Could not fetch Claude usage data. Make sure ccusage is installed (npx ccusage@latest)',
        });
        return;
      }
      res.json(usageData);
    } catch (error) {
      res.status(500).json({
        error: 'Failed to fetch usage data',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Get Claude usage by date range
  router.get('/api/claude-usage/range', async (req: Request, res: Response) => {
    if (!requireClaudeUsageEnabled(res)) return;
    try {
      const { since, until } = req.query;
      const usageData = await getUsageByDateRange(
        since as string | undefined,
        until as string | undefined
      );
      if (!usageData) {
        res.status(503).json({
          error: 'Usage data not available',
          message: 'Could not fetch Claude usage data for the specified range',
        });
        return;
      }
      res.json(usageData);
    } catch (error) {
      res.status(500).json({
        error: 'Failed to fetch usage data',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Get current session usage (live monitoring)
  router.get('/api/claude-usage/current', async (_req: Request, res: Response) => {
    if (!requireClaudeUsageEnabled(res)) return;
    try {
      const sessionUsage = await getCurrentSessionUsage();
      if (!sessionUsage) {
        res.json({ active: false, message: 'No active session found' });
        return;
      }
      res.json({ active: true, session: sessionUsage });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to fetch current session',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Refresh usage cache
  router.post('/api/claude-usage/refresh', async (_req: Request, res: Response) => {
    if (!requireClaudeUsageEnabled(res)) return;
    try {
      clearUsageCache();
      const usageData = await getCachedUsageData(true);
      if (!usageData) {
        res.status(503).json({
          error: 'Usage data not available',
          message: 'Could not refresh Claude usage data',
        });
        return;
      }
      res.json({ success: true, data: usageData });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to refresh usage data',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================
  // Cipher Memory API Routes
  // ==========================================
  const configManager = ConfigManager.getInstance();
  const CIPHER_API_URL = process.env.CIPHER_API_URL || 'http://localhost:8082';

  // Helper to check if cipher feature is enabled
  const requireCipherEnabled = (res: Response): boolean => {
    if (!configManager.isCipherEnabled()) {
      res.status(404).json({
        error: 'Feature disabled',
        message: 'Cipher Memory feature is not enabled. Set ENABLE_CIPHER=1 in your environment to enable it.',
      });
      return false;
    }
    return true;
  };

  // API: Get Cipher memory sessions
  router.get('/api/cipher/sessions', async (_req: Request, res: Response) => {
    if (!requireCipherEnabled(res)) return;
    try {
      const response = await fetch(`${CIPHER_API_URL}/api/sessions`);
      if (!response.ok) {
        throw new Error(`Cipher API returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: 'Cipher memory not available',
        message: error instanceof Error ? error.message : 'Could not connect to Cipher. Make sure cipher-memory is running.',
      });
    }
  });

  // API: Get Cipher session history
  router.get('/api/cipher/sessions/:sessionId/history', async (req: Request, res: Response) => {
    if (!requireCipherEnabled(res)) return;
    try {
      const { sessionId } = req.params;
      const response = await fetch(`${CIPHER_API_URL}/api/sessions/${sessionId}/history`);
      if (!response.ok) {
        throw new Error(`Cipher API returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: 'Failed to fetch session history',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Ask Cipher (send message to memory)
  router.post('/api/cipher/ask', async (req: Request, res: Response) => {
    if (!requireCipherEnabled(res)) return;
    try {
      const { message } = req.body;
      if (!message) {
        res.status(400).json({ error: 'Message is required' });
        return;
      }
      const response = await fetch(`${CIPHER_API_URL}/api/message/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) {
        throw new Error(`Cipher API returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: 'Failed to communicate with Cipher',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Search Cipher memory
  router.get('/api/cipher/search', async (req: Request, res: Response) => {
    if (!requireCipherEnabled(res)) return;
    try {
      const { q } = req.query;
      if (!q) {
        res.status(400).json({ error: 'Search query (q) is required' });
        return;
      }
      // Search by asking Cipher
      const response = await fetch(`${CIPHER_API_URL}/api/message/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Search memory for: ${q}` }),
      });
      if (!response.ok) {
        throw new Error(`Cipher API returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: 'Failed to search Cipher memory',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Get Qdrant memory stats (actual persistent memories)
  const QDRANT_URL = process.env.QDRANT_URL;
  const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
  const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'cipher_knowledge';
  const QDRANT_TIMEOUT_MS = parseInt(process.env.QDRANT_TIMEOUT_MS ?? '8000', 10);
  const qdrantTimeoutMs = Number.isFinite(QDRANT_TIMEOUT_MS)
    ? Math.max(QDRANT_TIMEOUT_MS, 1000)
    : 8000;

  const qdrantFetch = async (url: string, options: RequestInit = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), qdrantTimeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const ensureQdrantConfigured = (res: Response): boolean => {
    if (!QDRANT_URL || !QDRANT_API_KEY) {
      res.status(503).json({
        error: 'Qdrant not configured',
        message: 'Set QDRANT_URL and QDRANT_API_KEY in the environment to enable Cipher memory stats.',
      });
      return false;
    }
    return true;
  };

  router.get('/api/cipher/qdrant-stats', async (_req: Request, res: Response) => {
    if (!requireCipherEnabled(res)) return;
    try {
      if (!ensureQdrantConfigured(res)) {
        return;
      }
      // Get collection info
      const collectionRes = await qdrantFetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`, {
        headers: { 'api-key': QDRANT_API_KEY! },
      });
      if (!collectionRes.ok) {
        throw new Error(`Qdrant returned ${collectionRes.status}`);
      }
      const collectionData = (await collectionRes.json()) as { result?: { points_count?: number } };
      const totalMemories = collectionData.result?.points_count || 0;

      // Get all memories and sort client-side (Qdrant scroll doesn't guarantee order)
      // Fetch more points to ensure we get recent ones
      const scrollRes = await qdrantFetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/scroll`, {
        method: 'POST',
        headers: {
          'api-key': QDRANT_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: 500,
          with_payload: true,
          with_vector: false,
        }),
      });

      let decisions = 0;
      let learnings = 0;
      let patterns = 0;
      let insights = 0;
      const recentMemories: any[] = [];

      if (scrollRes.ok) {
        const scrollData = (await scrollRes.json()) as { result?: { points?: any[] } };
        const points = scrollData.result?.points || [];

        // Categorize memories based on content
        for (const point of points) {
          const text = (point.payload?.text || '').toLowerCase();
          const tags = point.payload?.tags || [];

          if (text.includes('decision') || text.includes('store decision') || tags.includes('decision')) {
            decisions++;
          } else if (text.includes('learning') || text.includes('learned') || tags.includes('learning')) {
            learnings++;
          } else if (text.includes('pattern') || tags.includes('pattern')) {
            patterns++;
          } else if (text.includes('insight') || tags.includes('insight')) {
            insights++;
          }
        }

        // Get 50 most recent memories
        const sortedPoints = points.sort((a: any, b: any) => {
          const timeA = new Date(a.payload?.timestamp || 0).getTime();
          const timeB = new Date(b.payload?.timestamp || 0).getTime();
          return timeB - timeA;
        });

        for (const point of sortedPoints.slice(0, 50)) {
          recentMemories.push({
            id: point.id,
            text: point.payload?.text?.substring(0, 200) + (point.payload?.text?.length > 200 ? '...' : ''),
            timestamp: point.payload?.timestamp,
            tags: point.payload?.tags,
            projectPath: point.payload?.projectPath,
          });
        }
      }

      res.json({
        success: true,
        stats: {
          totalMemories,
          decisions,
          learnings,
          patterns,
          insights,
        },
        recentMemories,
        collection: QDRANT_COLLECTION,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        error: 'Failed to fetch Qdrant stats',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Get single memory by ID from Qdrant
  router.get('/api/cipher/memory/:id', async (req: Request, res: Response) => {
    if (!requireCipherEnabled(res)) return;
    const { id } = req.params;

    try {
      if (!ensureQdrantConfigured(res)) {
        return;
      }
      const pointRes = await qdrantFetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/${id}`, {
        method: 'GET',
        headers: {
          'api-key': QDRANT_API_KEY!,
          'Content-Type': 'application/json',
        },
      });

      if (!pointRes.ok) {
        return res.status(404).json({ error: 'Memory not found' });
      }

      const pointData = (await pointRes.json()) as { result?: { id?: string; payload?: any } };
      const point = pointData.result;

      if (!point) {
        return res.status(404).json({ error: 'Memory not found' });
      }

      return res.json({
        success: true,
        memory: {
          id: point.id,
          text: point.payload?.text || '',
          timestamp: point.payload?.timestamp,
          tags: point.payload?.tags || [],
          projectPath: point.payload?.projectPath,
          metadata: point.payload?.metadata || {},
        },
      });
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to fetch memory',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================
  // Antigravity Usage API Routes
  // ==========================================

  // Helper to check if antigravity feature is enabled
  const requireAntigravityEnabled = (res: Response): boolean => {
    if (!configManager.isAntigravityEnabled()) {
      res.status(404).json({
        error: 'Feature disabled',
        message: 'Antigravity Usage feature is not enabled. Set ENABLE_ANTIGRAVITY=1 in your environment to enable it.',
      });
      return false;
    }
    return true;
  };

  // API: Check if Antigravity accounts exist
  router.get('/api/antigravity/available', async (_req: Request, res: Response) => {
    if (!requireAntigravityEnabled(res)) return;
    try {
      const available = await hasAntigravityAccounts();
      res.json({ available });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to check Antigravity availability',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Get Antigravity usage summary
  router.get('/api/antigravity/summary', async (_req: Request, res: Response) => {
    if (!requireAntigravityEnabled(res)) return;
    try {
      const summary = await getAntigravitySummary();
      res.json(summary);
    } catch (error) {
      res.status(500).json({
        error: 'Failed to fetch Antigravity summary',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // API: Refresh Antigravity cache
  router.post('/api/antigravity/refresh', async (_req: Request, res: Response) => {
    if (!requireAntigravityEnabled(res)) return;
    try {
      clearAntigravityCache();
      const summary = await getAntigravitySummary(true);
      res.json({ success: true, data: summary });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to refresh Antigravity data',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================
  // Skills API Proxy (for dashboard overview)
  // ==========================================

  // Helper to check if skills feature is enabled
  const requireSkillsEnabled = (res: Response): boolean => {
    if (!configManager.isSkillsEnabled()) {
      res.status(404).json({
        error: 'Feature disabled',
        message: 'Skills feature is not enabled. Set ENABLE_SKILLS=1 in your environment to enable it.',
      });
      return false;
    }
    return true;
  };

  // Proxy route for dashboard to fetch skills list
  router.get('/api/skills', async (_req: Request, res: Response) => {
    if (!requireSkillsEnabled(res)) return;
    try {
      // Proxy to the code-execution skills endpoint
      const response = await fetch(`http://localhost:${process.env.PORT || 3010}/api/code/skills`);
      if (!response.ok) {
        throw new Error(`Skills API returned ${response.status}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(503).json({
        error: 'Skills service unavailable',
        message: error instanceof Error ? error.message : String(error),
        skills: [], // Return empty array as fallback
      });
    }
  });

  return router;
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Gateway Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      /* Refined dark palette - less purple, more sophisticated */
      --bg-primary: #09090b;
      --bg-secondary: rgba(17, 17, 21, 0.98);
      --bg-tertiary: rgba(24, 24, 32, 0.95);
      --bg-card: rgba(20, 20, 28, 0.9);
      --bg-glass: rgba(255, 255, 255, 0.03);
      --bg-elevated: rgba(30, 30, 42, 0.95);

      /* Accent colors - more balanced */
      --accent: #7c3aed;
      --accent-secondary: #06b6d4;
      --accent-tertiary: #ec4899;
      --accent-glow: rgba(124, 58, 237, 0.4);
      --accent-hover: #8b5cf6;

      /* Status colors with softer glows */
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.25);
      --warning: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.25);
      --error: #ef4444;
      --error-glow: rgba(239, 68, 68, 0.25);

      /* Text hierarchy */
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --text-dimmed: #52525b;

      /* Borders */
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(255, 255, 255, 0.15);
      --border-active: rgba(124, 58, 237, 0.5);

      /* Gradients - more subtle */
      --gradient-1: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%);
      --gradient-2: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
      --gradient-3: linear-gradient(180deg, rgba(124, 58, 237, 0.08) 0%, transparent 100%);
      --gradient-subtle: linear-gradient(135deg, rgba(124, 58, 237, 0.05) 0%, rgba(6, 182, 212, 0.03) 100%);

      /* Shadows */
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
      --shadow-glow: 0 0 40px rgba(124, 58, 237, 0.15);

      /* Radius */
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-xl: 20px;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: 
        radial-gradient(ellipse 80% 50% at 50% -20%, rgba(124, 58, 237, 0.15), transparent),
        radial-gradient(ellipse 60% 40% at 100% 0%, rgba(6, 182, 212, 0.1), transparent),
        radial-gradient(ellipse 50% 30% at 0% 100%, rgba(236, 72, 153, 0.08), transparent);
      pointer-events: none;
      z-index: -1;
    }
    
    .container {
      max-width: 1500px;
      margin: 0 auto;
      padding: 2rem 2.5rem;
    }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      padding: 1.5rem 2rem;
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
      position: relative;
    }

    header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(124, 58, 237, 0.3), transparent);
    }

    .logo-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-icon {
      width: 44px;
      height: 44px;
      background: var(--gradient-1);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.375rem;
      box-shadow: var(--shadow-md);
    }

    h1 {
      font-size: 1.375rem;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }

    .header-subtitle {
      font-size: 0.75rem;
      color: var(--text-dimmed);
      margin-top: 0.125rem;
      letter-spacing: 0.01em;
    }
    
    .stats {
      display: flex;
      gap: 0.75rem;
    }

    .stat {
      background: rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 0.875rem 1.25rem;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
      min-width: 100px;
      text-align: center;
    }

    .stat:hover {
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-2px);
      background: rgba(255, 255, 255, 0.06);
    }

    .stat::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--gradient-1);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .stat:hover::before {
      opacity: 1;
    }

    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      line-height: 1.2;
      color: #fff;
    }

    .stat:nth-child(1) .stat-value { 
      background: linear-gradient(135deg, #34d399, #10b981);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .stat:nth-child(2) .stat-value { 
      background: linear-gradient(135deg, #8b5cf6, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .stat:nth-child(3) .stat-value { 
      background: linear-gradient(135deg, #22d3ee, #67e8f9);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stat-label {
      font-size: 0.65rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 500;
      margin-top: 0.2rem;
    }
    
    .controls {
      display: flex;
      gap: 1rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin: 0 0 1rem 0;
      gap: 1rem;
    }

    .section-title {
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text-primary);
    }

    .section-subtitle {
      color: var(--text-secondary);
      font-size: 0.9rem;
      margin-top: 0.35rem;
      line-height: 1.4;
    }

    .section-hint {
      color: var(--text-muted);
      font-size: 0.85rem;
      padding: 0.5rem 0.75rem;
      background: var(--bg-glass);
      border: 1px solid var(--border);
      border-radius: 10px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    
    .search-box {
      flex: 1;
      min-width: 280px;
      position: relative;
    }
    
    .search-box input {
      width: 100%;
      padding: 0.875rem 1.25rem 0.875rem 3rem;
      background: var(--bg-glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 14px;
      color: var(--text-primary);
      font-size: 0.9rem;
      font-family: inherit;
      transition: all 0.3s ease;
    }
    
    .search-box input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-glow);
    }

    .search-box input::placeholder {
      color: var(--text-muted);
    }
    
    .search-box::before {
      content: "";
      position: absolute;
      left: 1.1rem;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'/%3E%3C/svg%3E");
      background-size: contain;
      opacity: 0.6;
    }
    
    .btn {
      padding: 0.625rem 1.25rem;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      position: relative;
    }

    .btn-primary {
      background: var(--accent);
      color: white;
      box-shadow: var(--shadow-sm);
    }

    .btn-primary:hover {
      background: var(--accent-hover);
      box-shadow: var(--shadow-md);
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      background: var(--bg-elevated);
      border-color: var(--border-hover);
      color: var(--text-primary);
    }
    
    .backend-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: 0.75rem;
      overflow: hidden;
      transition: all 0.2s ease;
      position: relative;
    }

    .backend-card:hover {
      border-color: var(--border-hover);
      box-shadow: var(--shadow-md);
    }
    
    .backend-card.backend-disabled {
      opacity: 0.7;
    }
    
    .backend-card.backend-disabled .backend-name {
      color: var(--text-secondary);
    }
    
    .disabled-badge {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
      padding: 0.25rem 0.625rem;
      border-radius: var(--radius-sm);
      font-size: 0.6875rem;
      font-weight: 500;
      margin-left: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .disconnected-badge {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning);
      padding: 0.25rem 0.625rem;
      border-radius: var(--radius-sm);
      font-size: 0.6875rem;
      font-weight: 500;
      margin-left: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .no-tools-badge {
      background: rgba(113, 113, 122, 0.15);
      color: var(--text-muted);
      padding: 0.25rem 0.625rem;
      border-radius: var(--radius-sm);
      font-size: 0.6875rem;
      font-weight: 500;
      margin-left: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .backend-card.backend-disconnected {
      opacity: 0.85;
      border-color: rgba(245, 158, 11, 0.3);
    }

    .backend-card.backend-no-tools {
      opacity: 0.75;
    }

    .backend-disabled-tool {
      opacity: 0.7;
    }

    .backend-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.25rem;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .backend-header:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .backend-info {
      display: flex;
      align-items: center;
      gap: 0.875rem;
    }

    .backend-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      position: relative;
    }

    .backend-status.connected {
      background: var(--success);
      box-shadow: 0 0 8px var(--success-glow);
    }
    
    .backend-status.error {
      background: var(--error);
      box-shadow: 0 0 6px var(--error-glow);
    }

    .backend-status.disconnected {
      background: var(--text-dimmed);
    }

    .backend-name {
      font-weight: 500;
      font-size: 0.9375rem;
      color: var(--text-primary);
    }

    .backend-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.125rem;
    }

    .backend-error {
      color: var(--error);
      font-size: 0.75rem;
      font-weight: 400;
      margin-top: 0.25rem;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .backend-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .toggle {
      position: relative;
      width: 44px;
      height: 24px;
    }

    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--bg-tertiary);
      border-radius: 24px;
      transition: all 0.2s ease;
      border: 1px solid var(--border);
    }

    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 2px;
      bottom: 2px;
      background: var(--text-muted);
      border-radius: 50%;
      transition: all 0.2s ease;
    }

    .toggle input:checked + .toggle-slider {
      background: var(--accent);
      border-color: var(--accent);
    }

    .toggle input:checked + .toggle-slider:before {
      transform: translateX(20px);
      background: white;
    }
    
    .tools-list {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease;
      background: rgba(0, 0, 0, 0.15);
    }

    .tools-list.expanded {
      max-height: 9999px;
    }

    .tool-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem 1.25rem;
      border-top: 1px solid var(--border);
      transition: background 0.15s ease;
    }

    .tool-item:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .tool-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--accent-secondary);
      padding: 0.1875rem 0.5rem;
      background: rgba(6, 182, 212, 0.08);
      border-radius: var(--radius-sm);
      border: 1px solid rgba(6, 182, 212, 0.15);
    }

    .tool-name.disabled {
      color: var(--text-muted);
      background: rgba(113, 113, 122, 0.1);
      border-color: rgba(113, 113, 122, 0.15);
      text-decoration: line-through;
    }

    .tool-desc {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.375rem;
      max-width: 500px;
      line-height: 1.5;
    }

    .expand-icon {
      transition: transform 0.2s ease;
      color: var(--text-dimmed);
    }

    .expanded .expand-icon {
      transform: rotate(180deg);
    }

    .toast {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 0.875rem 1.25rem;
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.25s ease;
      font-size: 0.875rem;
      font-weight: 500;
      z-index: 9999;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .filter-pills {
      display: flex;
      gap: 0.375rem;
      flex-wrap: wrap;
    }

    .pill {
      padding: 0.375rem 0.875rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .pill:hover, .pill.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .pill.disconnected {
      border-color: rgba(245, 158, 11, 0.3);
      opacity: 0.85;
    }

    .pill.disabled {
      border-color: rgba(239, 68, 68, 0.3);
      opacity: 0.75;
    }

    .pill.no-tools {
      border-color: rgba(113, 113, 122, 0.3);
      opacity: 0.65;
    }

    .loading {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .loading::after {
      content: "";
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin-left: 0.625rem;
      vertical-align: middle;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .stat {
      position: relative;
    }

    .quick-actions {
      display: flex;
      gap: 0.375rem;
      margin-left: auto;
    }

    .badge {
      background: rgba(124, 58, 237, 0.15);
      color: var(--accent);
      padding: 0.125rem 0.375rem;
      border-radius: var(--radius-sm);
      font-size: 0.625rem;
      font-weight: 500;
    }

    .btn-restart {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-weight: 500;
      border: 1px solid var(--border);
    }

    .btn-restart:hover {
      background: var(--bg-elevated);
      border-color: var(--border-hover);
      color: var(--text-primary);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn-success {
      background: var(--success);
      color: white;
      font-weight: 500;
      border: none;
    }

    .btn-success:hover {
      background: #059669;
    }

    .btn-danger {
      background: var(--error);
      color: white;
      font-weight: 500;
      border: none;
    }

    .btn-danger:hover {
      background: #dc2626;
    }

    .btn-small {
      padding: 0.5rem 0.875rem;
      font-size: 0.75rem;
      border-radius: 10px;
    }

    /* Modal styles */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 1000;
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s ease;
    }

    .modal-overlay.show {
      opacity: 1;
      visibility: visible;
    }

    .modal {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      width: 90%;
      max-width: 560px;
      max-height: 85vh;
      overflow-y: auto;
      transform: translateY(-10px);
      opacity: 0;
      transition: all 0.2s ease;
      box-shadow: var(--shadow-lg);
    }

    .modal-overlay.show .modal {
      transform: translateY(0);
      opacity: 1;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .modal-header h2 {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }

    .modal-close:hover {
      color: var(--text-primary);
      background: var(--bg-tertiary);
    }

    .modal-body {
      padding: 1.5rem;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      padding: 1.25rem 2rem;
      border-top: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.1);
    }

    .form-group {
      margin-bottom: 1.25rem;
    }

    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .form-group input,
    .form-group select,
    .form-group textarea {
      width: 100%;
      padding: 0.625rem 0.875rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 0.8125rem;
      font-family: inherit;
      transition: all 0.15s ease;
    }

    .form-group input:focus,
    .form-group select:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.15);
    }

    .form-group input::placeholder,
    .form-group textarea::placeholder {
      color: var(--text-dimmed);
    }

    .form-group select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2371717a'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.75rem center;
      background-size: 14px;
      padding-right: 2rem;
    }

    .form-group textarea {
      resize: vertical;
      min-height: 80px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      line-height: 1.5;
    }

    .form-group small {
      display: block;
      margin-top: 0.375rem;
      font-size: 0.6875rem;
      color: var(--text-dimmed);
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
    }

    .transport-fields {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.25rem;
      margin-top: 0.75rem;
    }

    .test-result {
      margin-top: 1.25rem;
      padding: 1.125rem;
      border-radius: 12px;
      font-size: 0.875rem;
      font-weight: 500;
    }

    .test-result.success {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid var(--success);
      color: var(--success);
    }

    .test-result.error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid var(--error);
      color: var(--error);
    }

    .test-result.loading {
      background: rgba(124, 58, 237, 0.1);
      border: 1px solid var(--accent);
      color: var(--accent);
    }

    .backend-buttons {
      display: flex;
      gap: 0.5rem;
    }

    .confirm-dialog {
      text-align: center;
      padding: 1.5rem;
    }

    .confirm-dialog p {
      margin-bottom: 1.5rem;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .confirm-dialog strong {
      color: var(--error);
    }

    /* Checkbox styling */
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 0.875rem;
      padding: 1rem 1.25rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .checkbox-group:hover {
      border-color: var(--accent);
    }

    .checkbox-group input[type="checkbox"] {
      width: 20px;
      height: 20px;
      accent-color: var(--accent);
      cursor: pointer;
      border-radius: 4px;
    }

    .checkbox-group span {
      font-size: 0.9rem;
      color: var(--text-primary);
      font-weight: 500;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: var(--text-secondary);
    }

    .empty-state-icon {
      font-size: 4rem;
      margin-bottom: 1.5rem;
      opacity: 0.3;
    }

    .empty-state h3 {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 0.5rem;
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--border-hover);
    }

    /* Responsive */
/* Tab Navigation */
    .tab-nav {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0;
    }

    .tab-btn {
      padding: 0.875rem 1.5rem;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      font-size: 0.9rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .tab-btn:hover {
      color: var(--text-primary);
    }

    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* Claude Usage Section */
    .usage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .usage-stat {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 1.25rem;
      border-radius: 16px;
      border: 1px solid var(--border);
      position: relative;
      overflow: hidden;
    }

    .usage-stat::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--gradient-1);
    }

    .usage-stat.success::before {
      background: var(--success);
    }

    .usage-stat.warning::before {
      background: var(--warning);
    }

    .usage-stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      background: var(--gradient-1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      line-height: 1.2;
    }

    .usage-stat-value.large {
      font-size: 2.25rem;
    }

    .usage-stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 500;
      margin-top: 0.5rem;
    }

    .usage-stat-sublabel {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .charts-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    @media (max-width: 1200px) {
      .charts-grid {
        grid-template-columns: 1fr;
      }
    }

    .chart-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 1.5rem;
      border-radius: 20px;
      border: 1px solid var(--border);
    }

    .chart-card h3 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
    }

    .chart-container {
      position: relative;
      height: 300px;
    }

    .top-days-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .top-days-list li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--border);
    }

    .top-days-list li:last-child {
      border-bottom: none;
    }

    .top-day-date {
      font-size: 0.9rem;
      color: var(--text-secondary);
    }

    .top-day-cost {
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--accent);
    }

    .model-breakdown {
      margin-top: 1rem;
    }

    .model-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .model-color {
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }

    .model-name {
      flex: 1;
      font-size: 0.85rem;
      color: var(--text-secondary);
    }

    .model-cost {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .model-percent {
      font-size: 0.8rem;
      color: var(--text-muted);
      min-width: 45px;
      text-align: right;
    }

    .live-session {
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(34, 211, 238, 0.1));
      border: 1px solid var(--accent);
      border-radius: 16px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .live-indicator {
      width: 10px;
      height: 10px;
      background: var(--success);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    .live-session-info {
      flex: 1;
    }

    .live-session-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .live-session-meta {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }

    .live-session-cost {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--accent);
    }

    .usage-loading {
      text-align: center;
      padding: 3rem;
      color: var(--text-muted);
    }

    .usage-error {
      text-align: center;
      padding: 2rem;
      color: var(--error);
      background: rgba(248, 113, 113, 0.1);
      border-radius: 12px;
      border: 1px solid var(--error);
    }

    .refresh-btn {
      background: var(--bg-glass);
      border: 1px solid var(--border);
      padding: 0.5rem 1rem;
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .refresh-btn:hover {
      background: var(--bg-tertiary);
      border-color: var(--border-hover);
    }

    /* Memory Tab Styles */
    .memory-search-container {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
      align-items: stretch;
    }

    .memory-search {
      flex: 1;
    }

    .memory-loading {
      text-align: center;
      padding: 2rem;
      color: var(--text-muted);
    }

    .memory-stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .memory-stat {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 1.25rem;
      border-radius: 16px;
      border: 1px solid var(--border);
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .memory-stat::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%);
    }

    .memory-stat:hover {
      border-color: var(--border-hover);
      transform: translateY(-2px);
    }

    .memory-stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      background: linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      line-height: 1.2;
    }

    .memory-stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 500;
      margin-top: 0.5rem;
    }

    .memory-sessions-section {
      margin-top: 1.5rem;
    }

    .memory-sessions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1rem;
    }

    .memory-session-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.25rem;
      cursor: pointer;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .memory-session-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, #06b6d4, #8b5cf6, #ec4899);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .memory-session-card:hover {
      border-color: var(--accent);
      transform: translateY(-3px);
      box-shadow: 0 12px 40px rgba(139, 92, 246, 0.2);
    }

    .memory-session-card:hover::before {
      opacity: 1;
    }

    .memory-session-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.75rem;
    }

    .memory-session-title {
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.3;
    }

    .memory-session-meta {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }

    .memory-session-preview {
      font-size: 0.85rem;
      color: var(--text-secondary);
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .memory-badge {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .memory-badge.decision { background: rgba(139, 92, 246, 0.2); color: #a78bfa; }
    .memory-badge.learning { background: rgba(34, 211, 153, 0.2); color: #34d399; }
    .memory-badge.pattern { background: rgba(34, 211, 238, 0.2); color: #22d3ee; }
    .memory-badge.insight { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
    .memory-badge.blocker { background: rgba(248, 113, 113, 0.2); color: #f87171; }
    .memory-badge.milestone { background: rgba(236, 72, 153, 0.2); color: #ec4899; }

    .memory-detail-panel {
      position: fixed;
      top: 0;
      right: 0;
      width: 50%;
      max-width: 700px;
      height: 100vh;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      z-index: 1000;
      transform: translateX(100%);
      transition: transform 0.3s ease;
      display: flex;
      flex-direction: column;
    }

    .memory-detail-panel.active {
      transform: translateX(0);
    }

    .memory-detail-panel.hidden {
      display: none;
    }

    .memory-detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .memory-detail-header h3 {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    #memory-detail-content {
      flex: 1;
      overflow-y: auto;
      padding: 1.5rem;
    }

    .memory-message {
      margin-bottom: 1.5rem;
      padding: 1rem;
      background: var(--bg-glass);
      border-radius: 12px;
      border: 1px solid var(--border);
    }

    .memory-message.user {
      border-left: 3px solid var(--accent);
    }

    .memory-message.assistant {
      border-left: 3px solid var(--success);
    }

    .memory-message-role {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }

    .memory-message-content {
      font-size: 0.9rem;
      color: var(--text-secondary);
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .memory-error {
      text-align: center;
      padding: 2rem;
      color: var(--warning);
      background: rgba(251, 191, 36, 0.1);
      border-radius: 12px;
      border: 1px solid var(--warning);
    }

    .memory-empty {
      text-align: center;
      padding: 3rem;
      color: var(--text-muted);
    }

    .memory-empty svg {
      width: 64px;
      height: 64px;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    .memory-search-results {
      margin-top: 1.5rem;
    }

    .memory-search-result {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem;
      margin-bottom: 1rem;
    }

    .memory-search-result-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 0.5rem;
    }

    .memory-search-result-content {
      font-size: 0.85rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    /* Antigravity Tab Styles */
    .antigravity-loading {
      padding: 2rem;
      text-align: center;
      color: var(--text-muted);
    }

    .antigravity-status {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      background: var(--bg-card);
      border-radius: 12px;
      border: 1px solid var(--border);
      margin-bottom: 1.5rem;
    }

    .antigravity-status-indicator {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--error);
      box-shadow: 0 0 8px var(--error-glow);
    }

    .antigravity-status-indicator.running {
      background: var(--success);
      box-shadow: 0 0 8px var(--success-glow);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .antigravity-status-text {
      flex: 1;
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .antigravity-status-text strong {
      color: var(--text-primary);
    }

    .antigravity-accounts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .antigravity-account-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem;
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .antigravity-account-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(135deg, #f472b6 0%, #8b5cf6 100%);
    }

    .antigravity-account-card.techgravity::before {
      background: linear-gradient(135deg, #22d3ee 0%, #10b981 100%);
    }

    .antigravity-account-card:hover {
      border-color: var(--border-hover);
      transform: translateY(-2px);
      box-shadow: 0 8px 32px rgba(139, 92, 246, 0.15);
    }

    .antigravity-account-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
    }

    .antigravity-account-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #f472b6 0%, #8b5cf6 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .antigravity-account-card.techgravity .antigravity-account-icon {
      background: linear-gradient(135deg, #22d3ee 0%, #10b981 100%);
    }

    .antigravity-account-icon svg {
      width: 24px;
      height: 24px;
      stroke: white;
    }

    .antigravity-account-name {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .antigravity-account-email {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }

    .antigravity-stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
    }

    .antigravity-stat {
      background: var(--bg-glass);
      padding: 1rem;
      border-radius: 10px;
      text-align: center;
    }

    .antigravity-stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #8b5cf6 0%, #22d3ee 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .antigravity-stat-label {
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-top: 0.25rem;
    }

    .antigravity-quota-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }

    .antigravity-quota-title {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.75rem;
    }

    .antigravity-quota-bars {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .antigravity-quota-bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .antigravity-quota-model {
      width: 110px;
      font-size: 0.8rem;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .antigravity-quota-progress {
      flex: 1;
      height: 8px;
      background: var(--bg-glass);
      border-radius: 4px;
      overflow: hidden;
    }

    .antigravity-quota-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.5s ease;
    }

    .antigravity-quota-fill.high {
      background: linear-gradient(90deg, #10b981, #34d399);
    }

    .antigravity-quota-fill.medium {
      background: linear-gradient(90deg, #f59e0b, #fbbf24);
    }

    .antigravity-quota-fill.low {
      background: linear-gradient(90deg, #ef4444, #f87171);
    }

    .antigravity-quota-percent {
      width: 45px;
      font-size: 0.8rem;
      font-weight: 600;
      text-align: right;
    }

    .antigravity-quota-percent.high { color: var(--success); }
    .antigravity-quota-percent.medium { color: var(--warning); }
    .antigravity-quota-percent.low { color: var(--error); }

    .antigravity-empty {
      padding: 3rem;
      text-align: center;
      color: var(--text-muted);
    }

    .antigravity-empty svg {
      width: 48px;
      height: 48px;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    /* Skills Tab Styles */
    .skills-actions {
      display: flex;
      gap: 0.75rem;
    }

    .skills-stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .skills-stat {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 1rem 1.25rem;
      border-radius: 14px;
      border: 1px solid var(--border);
      transition: all 0.3s ease;
      text-align: center;
    }

    .skills-stat:hover {
      border-color: var(--border-hover);
      transform: translateY(-2px);
    }

    .skills-stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      background: var(--gradient-1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .skills-stat-label {
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 500;
      margin-top: 0.25rem;
    }

    .skills-categories-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .skill-category-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1rem;
      cursor: pointer;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .skill-category-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--gradient-1);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .skill-category-card:hover {
      border-color: var(--accent);
      transform: translateY(-3px);
    }

    .skill-category-card:hover::before {
      opacity: 1;
    }

    .skill-category-card.selected {
      border-color: var(--accent);
      background: rgba(139, 92, 246, 0.1);
    }

    .skill-category-card.selected::before {
      opacity: 1;
    }

    .skill-category-name {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 0.35rem;
    }

    .skill-category-desc {
      font-size: 0.75rem;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .skill-category-count {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      background: var(--accent);
      color: white;
      font-size: 0.65rem;
      font-weight: 600;
      padding: 0.15rem 0.5rem;
      border-radius: 10px;
    }

    .skills-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 1rem;
    }

    .skill-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.25rem;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .skill-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, #8b5cf6, #22d3ee);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .skill-card:hover {
      border-color: var(--border-hover);
      transform: translateY(-3px);
      box-shadow: 0 12px 40px rgba(139, 92, 246, 0.15);
    }

    .skill-card:hover::before {
      opacity: 1;
    }

    .skill-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.75rem;
    }

    .skill-name {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .skill-source-badge {
      font-size: 0.6rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      border-radius: 8px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .skill-source-badge.external {
      background: rgba(34, 211, 238, 0.15);
      color: #22d3ee;
      border: 1px solid rgba(34, 211, 238, 0.3);
    }

    .skill-source-badge.workspace {
      background: rgba(139, 92, 246, 0.15);
      color: #a78bfa;
      border: 1px solid rgba(139, 92, 246, 0.3);
    }

    .skill-description {
      font-size: 0.85rem;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: 0.75rem;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .skill-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }

    .skill-category-tag {
      font-size: 0.65rem;
      font-weight: 500;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      background: rgba(139, 92, 246, 0.15);
      color: var(--accent);
      border: 1px solid rgba(139, 92, 246, 0.2);
    }

    .skill-tag {
      font-size: 0.65rem;
      font-weight: 500;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      background: var(--bg-glass);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .skill-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    .skill-action-btn {
      flex: 1;
      padding: 0.5rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--bg-glass);
      color: var(--text-secondary);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
    }

    .skill-action-btn:hover {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .skill-action-btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .skill-action-btn.primary:hover {
      background: var(--accent-hover);
    }

    .skills-templates-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }

    .template-card {
      background: var(--bg-glass);
      border: 1px dashed var(--border);
      border-radius: 14px;
      padding: 1.25rem;
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .template-card:hover {
      border-color: var(--accent);
      border-style: solid;
      background: rgba(139, 92, 246, 0.05);
    }

    .template-name {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 0.35rem;
    }

    .template-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .template-category {
      display: inline-block;
      font-size: 0.65rem;
      font-weight: 500;
      padding: 0.15rem 0.4rem;
      border-radius: 6px;
      background: rgba(34, 211, 238, 0.15);
      color: #22d3ee;
      margin-top: 0.5rem;
    }

    .source-filter select {
      background: var(--bg-glass);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.5rem 1rem;
      color: var(--text-primary);
      font-size: 0.85rem;
      cursor: pointer;
    }

    .source-filter select:focus {
      outline: none;
      border-color: var(--accent);
    }

    .skills-empty {
      text-align: center;
      padding: 3rem;
      color: var(--text-muted);
    }

    @media (max-width: 1024px) {
      .header-actions {
        flex-wrap: wrap;
      }
      
      .stats {
        gap: 0.75rem;
      }

      .stat {
        padding: 0.75rem 1rem;
      }

      .stat-value {
        font-size: 1.35rem;
      }
    }

    @media (max-width: 768px) {
      .container {
        padding: 1.5rem;
      }

      header {
        flex-direction: column;
        gap: 1.5rem;
        align-items: flex-start;
      }

      .header-actions {
        width: 100%;
        justify-content: space-between;
      }

      .form-row {
        grid-template-columns: 1fr;
      }

      .backend-buttons {
        flex-wrap: wrap;
      }
    }

    /* Settings Tab Styles */
    .settings-section {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .settings-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    .settings-card-header {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
    }

    .settings-card-header h3 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
    }

    .settings-card-body {
      padding: 1.5rem;
    }

    .settings-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }

    .settings-label {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .settings-label span:first-child {
      font-weight: 500;
      color: var(--text);
    }

    .settings-label small {
      color: var(--text-secondary);
      font-size: 0.85rem;
    }

    /* Toggle Switch */
    .toggle-switch {
      position: relative;
      width: 52px;
      height: 28px;
      cursor: pointer;
    }

    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: var(--border);
      border-radius: 28px;
      transition: 0.3s;
    }

    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 20px;
      width: 20px;
      left: 4px;
      bottom: 4px;
      background-color: white;
      border-radius: 50%;
      transition: 0.3s;
    }

    .toggle-switch input:checked + .toggle-slider {
      background-color: var(--success);
    }

    .toggle-switch input:checked + .toggle-slider:before {
      transform: translateX(24px);
    }

    .toggle-switch input:disabled + .toggle-slider {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Settings Info */
    .settings-info {
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
    }

    .settings-info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
    }

    .info-item {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .info-item .info-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
    }

    .info-item .info-value {
      font-weight: 500;
      color: var(--text);
    }

    .info-item .info-value.success {
      color: var(--success);
    }

    .info-item .info-value.warning {
      color: var(--warning);
    }

    /* Settings Notice */
    .settings-notice {
      margin-top: 1rem;
      padding: 1rem;
      background: rgba(var(--warning-rgb, 255, 193, 7), 0.1);
      border: 1px solid var(--warning);
      border-radius: 8px;
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
    }

    .settings-notice.hidden {
      display: none;
    }

    .settings-notice-icon {
      font-size: 1.25rem;
      flex-shrink: 0;
    }

    .settings-notice-content {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .settings-notice-content strong {
      color: var(--warning);
    }

    .settings-notice-content small {
      color: var(--text-secondary);
    }

    .settings-description {
      margin-top: 1rem;
      padding: 1rem;
      background: rgba(59, 130, 246, 0.1);
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .settings-description ul {
      margin: 0.5rem 0 0 0;
      padding-left: 1.25rem;
    }

    .settings-description li {
      margin-bottom: 0.25rem;
    }

    .restart-notice {
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid var(--primary);
      border-radius: 8px;
      display: none;
      align-items: center;
      gap: 0.5rem;
      color: var(--primary);
      font-size: 0.9rem;
    }

    .restart-notice.show {
      display: flex;
    }

    /* ========================================
       OVERVIEW TAB - Professional Dashboard
       ======================================== */
    .overview-hero {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      padding: 2rem 2.5rem;
      margin-bottom: 1.5rem;
      border: 1px solid var(--border);
    }

    .overview-hero-content {
      position: relative;
    }

    .overview-hero h2 {
      font-size: 1.375rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 0.375rem;
      letter-spacing: -0.01em;
    }

    .overview-hero p {
      color: var(--text-muted);
      font-size: 0.875rem;
      max-width: 500px;
      line-height: 1.5;
    }

    .overview-quick-stats {
      display: flex;
      gap: 0.75rem;
      margin-top: 1.5rem;
      flex-wrap: wrap;
    }

    .overview-quick-stat {
      background: var(--bg-tertiary);
      padding: 0.75rem 1rem;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 0.625rem;
      transition: all 0.15s ease;
      min-width: 120px;
    }

    .overview-quick-stat:hover {
      border-color: var(--border-hover);
    }

    .overview-quick-stat-icon {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .overview-quick-stat-icon.servers { background: rgba(124, 58, 237, 0.12); }
    .overview-quick-stat-icon.servers svg { stroke: var(--accent); }
    .overview-quick-stat-icon.tools { background: rgba(6, 182, 212, 0.12); }
    .overview-quick-stat-icon.tools svg { stroke: var(--accent-secondary); }
    .overview-quick-stat-icon.skills { background: rgba(236, 72, 153, 0.12); }
    .overview-quick-stat-icon.skills svg { stroke: var(--accent-tertiary); }
    .overview-quick-stat-icon.memory { background: rgba(16, 185, 129, 0.12); }
    .overview-quick-stat-icon.memory svg { stroke: var(--success); }

    .overview-quick-stat-icon svg {
      width: 16px;
      height: 16px;
    }

    .overview-quick-stat-value {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }

    .overview-quick-stat-label {
      font-size: 0.625rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 0.125rem;
    }

    /* Overview Grid Layout */
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.25rem;
      margin-bottom: 2rem;
    }

    @media (max-width: 1200px) {
      .overview-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 768px) {
      .overview-grid { grid-template-columns: 1fr; }
    }

    .overview-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 1.25rem;
      position: relative;
      transition: all 0.15s ease;
    }

    .overview-card:hover {
      border-color: var(--border-hover);
    }

    .overview-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
    }

    .overview-card-title {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }

    .overview-card-title svg {
      width: 16px;
      height: 16px;
      stroke: var(--text-muted);
    }

    .overview-card-badge {
      font-size: 0.65rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      font-weight: 500;
      letter-spacing: 0.02em;
    }

    .overview-card-badge.warning {
      background: rgba(245, 158, 11, 0.1);
      color: var(--warning);
    }

    .overview-card-badge.error {
      background: rgba(239, 68, 68, 0.1);
      color: var(--error);
    }

    .overview-card-content {
      font-size: 0.85rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    /* Backend health list in Overview */
    .health-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .health-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.625rem 0.75rem;
      background: var(--bg-glass);
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }

    .health-item:hover {
      border-color: var(--border);
      background: var(--bg-tertiary);
    }

    .health-item-name {
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .health-item-status {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .health-item-status.healthy { background: var(--success); }
    .health-item-status.warning { background: var(--warning); }
    .health-item-status.error { background: var(--error); }

    .health-item-tools {
      font-size: 0.7rem;
      color: var(--text-dimmed);
      font-variant-numeric: tabular-nums;
    }

    /* Recent activity in Overview */
    .activity-list {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }

    .activity-item {
      display: flex;
      align-items: flex-start;
      gap: 0.625rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }

    .activity-item:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .activity-icon {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      flex-shrink: 0;
      margin-top: 0.125rem;
    }

    .activity-icon.memory { background: rgba(16, 185, 129, 0.1); }
    .activity-icon.tool { background: rgba(124, 58, 237, 0.1); }
    .activity-icon.backend { background: rgba(6, 182, 212, 0.1); }

    .activity-content {
      flex: 1;
      min-width: 0;
    }

    .activity-text {
      font-size: 0.75rem;
      color: var(--text-secondary);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .activity-time {
      font-size: 0.65rem;
      color: var(--text-dimmed);
      margin-top: 0.125rem;
    }

    /* Quick Actions in Overview */
    .quick-action-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.5rem;
    }

    .quick-action-btn {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .quick-action-btn:hover {
      background: var(--bg-tertiary);
      border-color: var(--border-hover);
      color: var(--text-primary);
    }

    .quick-action-btn:active {
      transform: scale(0.98);
    }

    .quick-action-btn svg {
      width: 14px;
      height: 14px;
      stroke: var(--text-muted);
      flex-shrink: 0;
    }

    .quick-action-btn:hover svg {
      stroke: var(--accent);
    }

    /* Professional Tab Navigation */
    .tab-nav {
      display: flex;
      gap: 0.125rem;
      margin-bottom: 1.5rem;
      background: var(--bg-secondary);
      padding: 0.375rem;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
    }

    .tab-btn {
      padding: 0.625rem 1rem;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      font-size: 0.8rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .tab-btn:hover {
      color: var(--text-secondary);
      background: var(--bg-glass);
    }

    .tab-btn.active {
      color: var(--text-primary);
      background: var(--bg-tertiary);
      box-shadow: var(--shadow-sm);
    }

    .tab-btn svg {
      width: 14px;
      height: 14px;
      opacity: 0.6;
    }

    .tab-btn:hover svg,
    .tab-btn.active svg {
      opacity: 0.9;
    }

    /* Staggered animations for all cards */
    .backend-card {
      animation: cardEntrance 0.4s ease-out backwards;
    }

    #backends-container .backend-card:nth-child(1) { animation-delay: 0.05s; }
    #backends-container .backend-card:nth-child(2) { animation-delay: 0.1s; }
    #backends-container .backend-card:nth-child(3) { animation-delay: 0.15s; }
    #backends-container .backend-card:nth-child(4) { animation-delay: 0.2s; }
    #backends-container .backend-card:nth-child(5) { animation-delay: 0.25s; }
    #backends-container .backend-card:nth-child(6) { animation-delay: 0.3s; }
    #backends-container .backend-card:nth-child(7) { animation-delay: 0.35s; }
    #backends-container .backend-card:nth-child(8) { animation-delay: 0.4s; }
    #backends-container .backend-card:nth-child(9) { animation-delay: 0.45s; }
    #backends-container .backend-card:nth-child(10) { animation-delay: 0.5s; }

    /* Skill cards animation */
    .skill-card {
      animation: cardEntrance 0.4s ease-out backwards;
    }

    #skills-grid .skill-card:nth-child(1) { animation-delay: 0.05s; }
    #skills-grid .skill-card:nth-child(2) { animation-delay: 0.1s; }
    #skills-grid .skill-card:nth-child(3) { animation-delay: 0.15s; }
    #skills-grid .skill-card:nth-child(4) { animation-delay: 0.2s; }
    #skills-grid .skill-card:nth-child(5) { animation-delay: 0.25s; }
    #skills-grid .skill-card:nth-child(6) { animation-delay: 0.3s; }

    /* Overview empty state */
    .overview-empty {
      text-align: center;
      padding: 2rem;
      color: var(--text-muted);
    }

    .overview-empty svg {
      width: 48px;
      height: 48px;
      margin-bottom: 1rem;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-section">
        <div class="logo-icon">⚡</div>
        <div>
          <h1>MCP Gateway</h1>
          <div class="header-subtitle">Unified AI Tool Orchestration Platform</div>
        </div>
      </div>
      <div class="header-actions">
        <div class="stats">
          <div class="stat">
            <div class="stat-value" id="enabled-count">-</div>
            <div class="stat-label">Enabled Tools</div>
          </div>
          <div class="stat">
            <div class="stat-value" id="total-count">-</div>
            <div class="stat-label">Total Tools</div>
          </div>
          <div class="stat">
            <div class="stat-value" id="backends-count">-</div>
            <div class="stat-label">Backends</div>
          </div>
        </div>
        <button class="btn btn-success" onclick="openAddServerModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          Add Server
        </button>
        <button class="btn btn-restart" onclick="restartServer()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          Restart
        </button>
      </div>
    </header>

    <!-- Tab Navigation -->
    <div class="tab-nav">
      <button class="tab-btn active" onclick="switchTab('overview')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
        Overview
      </button>
      <button class="tab-btn" onclick="switchTab('servers')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
        Servers & Tools
      </button>
      <button class="tab-btn" onclick="switchTab('memory')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4l3 3"></path></svg>
        Memory
      </button>
      <button class="tab-btn" onclick="switchTab('usage')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>
        Claude Usage
      </button>
      <button class="tab-btn" onclick="switchTab('antigravity')" id="antigravity-tab-btn" style="display: none;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path></svg>
        Antigravity
      </button>
      <button class="tab-btn" onclick="switchTab('skills')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
        Skills
      </button>
      <button class="tab-btn" onclick="switchTab('settings')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        Settings
      </button>
    </div>

    <!-- Overview Tab -->
    <div id="tab-overview" class="tab-content active">
      <!-- Hero Section -->
      <div class="overview-hero">
        <div class="overview-hero-content">
          <h2>Welcome to MCP Gateway</h2>
          <p>Your unified command center for managing MCP servers, AI tools, skills, and persistent memory across all your development environments.</p>
          <div class="overview-quick-stats" id="overview-quick-stats">
            <!-- Populated by JavaScript -->
          </div>
        </div>
      </div>

      <!-- Overview Grid -->
      <div class="overview-grid" id="overview-grid">
        <!-- Backend Health Card -->
        <div class="overview-card">
          <div class="overview-card-header">
            <div class="overview-card-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
              Backend Health
            </div>
            <span class="overview-card-badge" id="health-badge">All Connected</span>
          </div>
          <div class="overview-card-content">
            <div class="health-list" id="health-list">
              <div class="overview-empty">Loading backend status...</div>
            </div>
          </div>
        </div>

        <!-- Recent Memories Card -->
        <div class="overview-card">
          <div class="overview-card-header">
            <div class="overview-card-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
              Recent Memories
            </div>
          </div>
          <div class="overview-card-content">
            <div class="activity-list" id="recent-memories-list">
              <div class="overview-empty">Loading memories...</div>
            </div>
          </div>
        </div>

        <!-- Quick Actions Card -->
        <div class="overview-card">
          <div class="overview-card-header">
            <div class="overview-card-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              Quick Actions
            </div>
          </div>
          <div class="overview-card-content">
            <div class="quick-action-grid">
              <button class="quick-action-btn" onclick="switchTab('servers')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect></svg>
                Manage Servers
              </button>
              <button class="quick-action-btn" onclick="switchTab('skills')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline></svg>
                Browse Skills
              </button>
              <button class="quick-action-btn" onclick="switchTab('memory')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4l3 3"></path></svg>
                View Memory
              </button>
              <button class="quick-action-btn" onclick="switchTab('usage')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>
                Usage Stats
              </button>
            </div>
          </div>
        </div>

        <!-- Top Skills Card -->
        <div class="overview-card">
          <div class="overview-card-header">
            <div class="overview-card-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
              Available Skills
            </div>
            <span class="overview-card-badge" id="skills-count-badge">0 skills</span>
          </div>
          <div class="overview-card-content">
            <div class="health-list" id="top-skills-list">
              <div class="overview-empty">Loading skills...</div>
            </div>
          </div>
        </div>

        <!-- System Info Card -->
        <div class="overview-card">
          <div class="overview-card-header">
            <div class="overview-card-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              System Info
            </div>
          </div>
          <div class="overview-card-content" id="system-info">
            <div class="health-list">
              <div class="health-item">
                <div class="health-item-name">
                  <span class="health-item-status healthy"></span>
                  Gateway Status
                </div>
                <span class="health-item-tools">Running</span>
              </div>
              <div class="health-item">
                <div class="health-item-name">
                  <span class="health-item-status healthy"></span>
                  API Endpoint
                </div>
                <span class="health-item-tools">:3010</span>
              </div>
              <div class="health-item">
                <div class="health-item-name">
                  <span class="health-item-status healthy"></span>
                  Transport Mode
                </div>
                <span class="health-item-tools">SSE</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Usage Summary Card -->
        <div class="overview-card">
          <div class="overview-card-header">
            <div class="overview-card-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>
              Usage Today
            </div>
          </div>
          <div class="overview-card-content" id="usage-summary">
            <div class="health-list">
              <div class="health-item">
                <div class="health-item-name">API Calls</div>
                <span class="health-item-tools" id="usage-api-calls">--</span>
              </div>
              <div class="health-item">
                <div class="health-item-name">Input Tokens</div>
                <span class="health-item-tools" id="usage-input-tokens">--</span>
              </div>
              <div class="health-item">
                <div class="health-item-name">Output Tokens</div>
                <span class="health-item-tools" id="usage-output-tokens">--</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Servers Tab -->
    <div id="tab-servers" class="tab-content">
      <div class="controls">
        <div class="search-box">
          <input type="text" id="search" placeholder="Search tools by name or description..." />
        </div>
        <div class="filter-pills" id="backend-filters"></div>
        <div class="quick-actions">
          <button class="btn btn-secondary" onclick="enableAll()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            Enable All
          </button>
          <button class="btn btn-secondary" onclick="disableAll()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            Disable All
          </button>
        </div>
      </div>

      <div class="section-header">
        <div>
          <div class="section-title">Servers &amp; tools</div>
          <div class="section-subtitle">Toggle connections, filter by backend, and expand to view every tool/subtool.</div>
        </div>
        <div class="section-hint">Tip: click a server card to expand all tools</div>
      </div>

      <div id="backends-container">
        <div class="loading">Loading backends</div>
      </div>
    </div>

    <!-- Memory Tab -->
    <div id="tab-memory" class="tab-content">
      <div class="section-header">
        <div>
          <div class="section-title">Cipher Memory</div>
          <div class="section-subtitle">Persistent AI memory across all IDEs - decisions, learnings, patterns, and insights.</div>
        </div>
        <div class="memory-actions">
          <button class="refresh-btn" onclick="refreshMemoryData()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
            Refresh
          </button>
        </div>
      </div>

      <!-- Memory Search -->
      <div class="memory-search-container">
        <div class="search-box memory-search">
          <input type="text" id="memory-search" placeholder="Search memories (decisions, learnings, patterns)..." />
        </div>
        <button class="btn btn-primary" onclick="searchMemory()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          Search
        </button>
      </div>

      <!-- Memory Stats -->
      <div id="memory-stats-container">
        <div class="memory-loading">Connecting to Cipher Memory...</div>
      </div>

      <!-- Memory Sessions -->
      <div class="memory-sessions-section">
        <div class="section-title" style="margin-bottom: 1rem;">Memory Sessions</div>
        <div id="memory-sessions-container">
          <div class="memory-loading">Loading sessions...</div>
        </div>
      </div>

      <!-- Memory Detail Panel -->
      <div id="memory-detail-panel" class="memory-detail-panel hidden">
        <div class="memory-detail-header">
          <h3 id="memory-detail-title">Session Details</h3>
          <button class="modal-close" onclick="closeMemoryDetail()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div id="memory-detail-content"></div>
      </div>
    </div>

    <!-- Claude Usage Tab -->
    <div id="tab-usage" class="tab-content">
      <div class="section-header">
        <div>
          <div class="section-title">Claude Code Usage Analytics</div>
          <div class="section-subtitle">Track your Claude API usage, costs, and efficiency metrics.</div>
        </div>
        <button class="refresh-btn" onclick="refreshUsageData()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          Refresh
        </button>
      </div>

      <!-- Live Session -->
      <div id="live-session-container"></div>

      <!-- Usage Stats -->
      <div id="usage-stats-container">
        <div class="usage-loading">Loading usage data...</div>
      </div>

      <!-- Charts -->
      <div id="usage-charts-container"></div>
    </div>

    <!-- Antigravity Tab -->
    <div id="tab-antigravity" class="tab-content">
      <div class="section-header">
        <div>
          <div class="section-title">Antigravity Usage</div>
          <div class="section-subtitle">Monitor your Antigravity IDE quota and usage across all accounts.</div>
        </div>
        <button class="refresh-btn" onclick="refreshAntigravityData()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          Refresh
        </button>
      </div>

      <!-- Connection Status -->
      <div id="antigravity-status-container">
        <div class="antigravity-loading">Checking Antigravity status...</div>
      </div>

      <!-- Account Cards -->
      <div id="antigravity-accounts-container"></div>

      <!-- Quota Overview -->
      <div id="antigravity-quota-container"></div>
    </div>

    <!-- Skills Tab -->
    <div id="tab-skills" class="tab-content">
      <div class="section-header">
        <div>
          <div class="section-title">Skills Library</div>
          <div class="section-subtitle">Reusable AI workflows and expertise patterns. Skills encode procedural knowledge for consistent, high-quality outputs.</div>
        </div>
        <div class="skills-actions">
          <button class="btn btn-secondary" onclick="syncExternalSkills()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
            Sync External Skills
          </button>
          <button class="refresh-btn" onclick="refreshSkillsData()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
            Refresh
          </button>
        </div>
      </div>

      <!-- Skills Search & Filter -->
      <div class="controls">
        <div class="search-box">
          <input type="text" id="skills-search" placeholder="Search skills by name, description, or tags..." onkeyup="filterSkills()" />
        </div>
        <div class="filter-pills" id="skills-category-filters"></div>
      </div>

      <!-- Skills Stats -->
      <div class="skills-stats-row" id="skills-stats-container">
        <div class="loading">Loading skills...</div>
      </div>

      <!-- Skills Categories Grid -->
      <div id="skills-categories-container"></div>

      <!-- Skills List -->
      <div class="section-header" style="margin-top: 2rem;">
        <div>
          <div class="section-title">All Skills</div>
          <div class="section-subtitle" id="skills-count-subtitle">Loading...</div>
        </div>
        <div class="source-filter">
          <select id="skills-source-filter" onchange="filterSkills()">
            <option value="all">All Sources</option>
            <option value="external">External Skills</option>
            <option value="workspace">Workspace</option>
          </select>
        </div>
      </div>

      <div id="skills-list-container">
        <div class="loading">Loading skills...</div>
      </div>

      <!-- Templates Section -->
      <div class="section-header" style="margin-top: 2rem;">
        <div>
          <div class="section-title">Skill Templates</div>
          <div class="section-subtitle">Quick-start templates for common skill patterns</div>
        </div>
      </div>

      <div id="skills-templates-container">
        <div class="loading">Loading templates...</div>
      </div>
    </div>

    <!-- Settings Tab -->
    <div id="tab-settings" class="tab-content">
      <div class="section-header">
        <div>
          <div class="section-title">Gateway Settings</div>
          <div class="section-subtitle">Configure MCP Gateway behavior and optimize token usage.</div>
        </div>
      </div>

      <!-- Token Optimization Settings -->
      <div class="settings-section">
        <div class="settings-card">
          <div class="settings-card-header">
            <div class="settings-card-icon" style="background: linear-gradient(135deg, #10b981, #059669);">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div class="settings-card-title">
              <h3>Lite Mode</h3>
              <p>Reduce gateway meta-tools from 30 to ~7 essential tools</p>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="lite-mode-toggle" onchange="toggleLiteMode(this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-card-body">
            <div class="settings-info">
              <div class="settings-info-item">
                <span class="settings-label">Token Savings:</span>
                <span class="settings-value highlight-green">~12,000 tokens</span>
              </div>
              <div class="settings-info-item">
                <span class="settings-label">Current Status:</span>
                <span class="settings-value" id="lite-mode-status">Loading...</span>
              </div>
              <div class="settings-info-item">
                <span class="settings-label">Source:</span>
                <span class="settings-value" id="lite-mode-source">-</span>
              </div>
            </div>
            <div class="settings-description">
              <p><strong>When enabled, exposes only essential gateway tools:</strong></p>
              <ul>
                <li><code>gateway_list_tool_names</code> - Discover available tools</li>
                <li><code>gateway_search_tools</code> - Search for specific tools</li>
                <li><code>gateway_get_tool_schema</code> - Get tool schema on-demand</li>
                <li><code>gateway_execute_code</code> - Execute code in sandbox</li>
                <li><code>gateway_call_tool_filtered</code> - Call tools with filtering</li>
                <li><code>gateway_list_skills</code>, <code>gateway_search_skills</code>, <code>gateway_get_skill</code>, <code>gateway_execute_skill</code> - Skills operations</li>
              </ul>
              <p class="settings-warning">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                Requires gateway restart to take effect
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Environment Override Notice -->
      <div class="settings-section" id="env-override-notice" style="display: none;">
        <div class="settings-notice warning">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          <div>
            <strong>Environment Variable Override Active</strong>
            <p>GATEWAY_LITE_MODE is set in your environment. The environment variable takes precedence over this UI setting.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <!-- Add/Edit Server Modal -->
  <div class="modal-overlay" id="server-modal">
    <div class="modal">
      <div class="modal-header">
        <h2 id="modal-title">Add Server</h2>
        <button class="modal-close" onclick="closeServerModal()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="modal-body">
        <form id="server-form">
          <input type="hidden" id="edit-server-id" value="">

          <div class="form-row">
            <div class="form-group">
              <label for="server-id">Server ID *</label>
              <input type="text" id="server-id" required pattern="^[a-z0-9-]+$" placeholder="my-server">
              <small>Lowercase letters, numbers, and hyphens only</small>
            </div>
            <div class="form-group">
              <label for="server-name">Display Name *</label>
              <input type="text" id="server-name" required placeholder="My Server">
            </div>
          </div>

          <div class="form-group">
            <label for="server-description">Description</label>
            <input type="text" id="server-description" placeholder="Brief description of what this server does">
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="server-prefix">Tool Prefix</label>
              <input type="text" id="server-prefix" pattern="^[a-z0-9_]*$" placeholder="myserver">
              <small>Lowercase letters, numbers, and underscores</small>
            </div>
            <div class="form-group">
              <label for="server-timeout">Timeout (ms)</label>
              <input type="number" id="server-timeout" min="1000" max="300000" value="30000">
            </div>
          </div>

          <div class="form-group">
            <label for="transport-type">Transport Type *</label>
            <select id="transport-type" required onchange="updateTransportFields()">
              <option value="stdio">StdIO (Command)</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE (Server-Sent Events)</option>
            </select>
          </div>

          <div class="transport-fields" id="stdio-fields">
            <div class="form-group">
              <label for="stdio-command">Command *</label>
              <input type="text" id="stdio-command" placeholder="npx">
            </div>
            <div class="form-group">
              <label for="stdio-args">Arguments (JSON array)</label>
              <textarea id="stdio-args" placeholder='["-y", "@modelcontextprotocol/server-filesystem", "/path"]'></textarea>
            </div>
            <div class="form-group">
              <label for="stdio-env">Environment Variables (JSON object)</label>
              <textarea id="stdio-env" placeholder='{"API_KEY": "your-key"}'></textarea>
            </div>
            <div class="form-group">
              <label for="stdio-cwd">Working Directory</label>
              <input type="text" id="stdio-cwd" placeholder="/path/to/directory">
            </div>
          </div>

          <div class="transport-fields" id="http-fields" style="display: none;">
            <div class="form-group">
              <label for="http-url">URL *</label>
              <input type="url" id="http-url" placeholder="https://mcp-server.example.com">
            </div>
            <div class="form-group">
              <label for="http-headers">Headers (JSON object)</label>
              <textarea id="http-headers" placeholder='{"Authorization": "Bearer token"}'></textarea>
            </div>
          </div>

          <div class="form-group">
            <label class="checkbox-group">
              <input type="checkbox" id="server-enabled" checked>
              <span>Enable server after adding</span>
            </label>
          </div>

          <div id="test-result"></div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeServerModal()">Cancel</button>
        <button class="btn btn-secondary" onclick="testServerConnection()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
          Test Connection
        </button>
        <button class="btn btn-primary" onclick="saveServer()">Save Server</button>
      </div>
    </div>
  </div>

  <!-- Delete Confirmation Modal -->
  <div class="modal-overlay" id="delete-modal">
    <div class="modal" style="max-width: 440px;">
      <div class="modal-header">
        <h2>Delete Server</h2>
        <button class="modal-close" onclick="closeDeleteModal()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="confirm-dialog">
          <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5;">⚠️</div>
          <p>Are you sure you want to delete <strong id="delete-server-name"></strong>?</p>
          <p style="font-size: 0.85rem; opacity: 0.7;">This will disconnect the server and remove it from the configuration. This action cannot be undone.</p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeDeleteModal()">Cancel</button>
        <button class="btn btn-danger" onclick="confirmDeleteServer()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          Delete Server
        </button>
      </div>
    </div>
  </div>

  <script>
    let backends = [];
    let tools = [];
    let searchQuery = '';
    let selectedBackend = null;
    let expandedBackends = new Set();

    // HTML escape function to prevent XSS and HTML parsing issues
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    async function loadData() {
      try {
        const [backendsRes, toolsRes] = await Promise.all([
          fetch('/dashboard/api/backends'),
          fetch('/dashboard/api/tools')
        ]);
        
        backends = (await backendsRes.json()).backends;
        tools = (await toolsRes.json()).tools;
        
        updateStats();
        renderBackends();
        renderFilters();
      } catch (err) {
        console.error('Failed to load data:', err);
      }
    }
    
    function updateStats() {
      try {
        const enabledTools = tools.filter(t => t.enabled);
        const enabledCountEl = document.getElementById('enabled-count');
        const totalCountEl = document.getElementById('total-count');
        const backendsCountEl = document.getElementById('backends-count');
        
        if (enabledCountEl) {
          enabledCountEl.textContent = enabledTools.length.toString();
        }
        if (totalCountEl) {
          totalCountEl.textContent = tools.length.toString();
        }
        if (backendsCountEl) {
          const connectedCount = backends.filter(b => b.status === 'connected').length;
          backendsCountEl.textContent = \`\${connectedCount}/\${backends.length}\`;
        }
      } catch (err) {
        console.error('Failed to update stats:', err);
      }
    }
    
    function renderFilters() {
      const container = document.getElementById('backend-filters');
      container.innerHTML = backends.map(b => {
        const toolCount = getBackendToolCount(b.id);
        const isDisconnected = b.status === 'disconnected' || b.status === 'error';
        const isDisabled = !b.enabled;
        const hasNoTools = toolCount === 0;

        let pillClass = 'pill';
        if (selectedBackend === b.id) pillClass += ' active';
        if (isDisabled) pillClass += ' disabled';
        else if (isDisconnected) pillClass += ' disconnected';
        else if (hasNoTools) pillClass += ' no-tools';

        return \`
          <span class="\${pillClass}" onclick="filterByBackend('\${b.id}')">
            \${b.id} <span class="badge">\${toolCount}</span>
          </span>
        \`;
      }).join('');
    }
    
    function getBackendToolCount(backendId) {
      return tools.filter(t => toolMatchesBackend(t, backendId)).length;
    }
    
    function getBackendPrefix(backendId) {
      // Get prefix dynamically from backend data
      const backend = backends.find(b => b.id === backendId);
      return backend?.toolPrefix || backendId;
    }

    function isFabricBackend(backend) {
      const id = (backend?.id || '').toLowerCase();
      const prefix = (backend?.toolPrefix || '').toLowerCase();
      return id.includes('fabric') || prefix.includes('fabric');
    }

    // Central helper to decide whether a tool belongs to a backend.
    // Prefers backendId from the API (exact), falls back to prefix matching.
    function toolMatchesBackend(tool, backendId) {
      if (tool.backendId) {
        return tool.backendId === backendId;
      }

      const prefix = getBackendPrefix(backendId);
      return tool.name.startsWith(prefix + '_') || (prefix === '' && !tool.name.includes('_'));
    }
    
    function filterByBackend(id) {
      selectedBackend = selectedBackend === id ? null : id;
      renderFilters();
      renderBackends();
    }
    
    function getToolsForBackend(backendId) {
      return tools.filter(t => {
        const matchesBackend = toolMatchesBackend(t, backendId);
        const matchesSearch = !searchQuery || 
          t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (t.description && t.description.toLowerCase().includes(searchQuery.toLowerCase()));
        return matchesBackend && matchesSearch;
      });
    }
    
    function getEnabledToolCountForBackend(backendId) {
      const backendTools = getToolsForBackend(backendId);
      return backendTools.filter(t => t.enabled && !t.backendDisabled).length;
    }
    
    function renderBackends() {
      const container = document.getElementById('backends-container');

      const filteredBackends = selectedBackend
        ? backends.filter(b => b.id === selectedBackend)
        : backends;

      if (filteredBackends.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">🔌</div>
            <h3>No servers configured</h3>
            <p>Add your first MCP server to get started</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = filteredBackends.map(backend => {
        const backendTools = getToolsForBackend(backend.id);
        const enabledCount = backendTools.filter(t => t.enabled && !t.backendDisabled).length;
        const isExpanded = expandedBackends.has(backend.id);
        const isBackendDisabled = !backend.enabled;
        const isDisconnected = backend.status === 'disconnected' || backend.status === 'error';
        const hasNoTools = backendTools.length === 0;

        // Determine card classes
        let cardClasses = 'backend-card';
        if (isExpanded) cardClasses += ' expanded';
        if (isBackendDisabled) cardClasses += ' backend-disabled';
        else if (isDisconnected) cardClasses += ' backend-disconnected';
        else if (hasNoTools) cardClasses += ' backend-no-tools';

        // Determine badge to show
        let badge = '';
        if (isBackendDisabled) {
          badge = '<span class="disabled-badge">Disabled</span>';
        } else if (isDisconnected) {
          badge = '<span class="disconnected-badge">Disconnected</span>';
        } else if (hasNoTools) {
          badge = '<span class="no-tools-badge">No Tools</span>';
        }

        // Error message for disconnected servers
        const errorMessage = backend.error ? escapeHtml(backend.error) : '';

        return \`
          <div class="\${cardClasses}" id="backend-\${backend.id}">
            <div class="backend-header" onclick="toggleExpand('\${backend.id}')">
              <div class="backend-info">
                <div class="backend-status \${backend.status}" \${errorMessage ? \`title="\${errorMessage}"\` : ''}></div>
                <div>
                  <div class="backend-name">\${escapeHtml(backend.id)} \${badge}</div>
                  <div class="backend-meta">
                    <span style="color: var(--accent-secondary)">\${enabledCount}</span>/\${backendTools.length} tools enabled · \${backend.status}
                    \${errorMessage ? \`<div class="backend-error"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> \${errorMessage}</div>\` : ''}
                  </div>
                </div>
              </div>
              <div class="backend-actions">
                <div class="backend-buttons">
                  <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); toggleAllBackendTools('\${backend.id}', true)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    Enable
                  </button>
                  <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); toggleAllBackendTools('\${backend.id}', false)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    Disable
                  </button>
                  <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); openEditServerModal('\${backend.id}')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    Edit
                  </button>
                  <button class="btn btn-danger btn-small" onclick="event.stopPropagation(); openDeleteModal('\${backend.id}')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                  </button>
                </div>
                \${isFabricBackend(backend) ? '<div class="backend-buttons" style="margin-right: 0.5rem;" onclick="event.stopPropagation();">' +
                  '<button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); triggerFabricCheck()">' +
                  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l3 3"></path></svg>' +
                  'Check Fabric Token' +
                  '</button>' +
                  '<button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); triggerFabricLogin()">' +
                  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1v22"></path><path d="M5 5h8a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h11"></path></svg>' +
                  'Fabric Login' +
                  '</button>' +
                  '</div>' : ''}
                <label class="toggle" onclick="event.stopPropagation()">
                  <input type="checkbox" \${backend.enabled ? 'checked' : ''}
                         onchange="toggleBackend('\${backend.id}', this.checked)">
                  <span class="toggle-slider"></span>
                </label>
                <span class="expand-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </span>
              </div>
            </div>
            <div class="tools-list \${isExpanded ? 'expanded' : ''}" id="tools-\${backend.id}">
              \${backendTools.length === 0 ? \`
                <div class="tool-item" style="justify-content: center; color: var(--text-muted); padding: 2rem;">
                  <span>No tools available from this server</span>
                </div>
              \` : backendTools.map(tool => \`
                <div class="tool-item \${tool.backendDisabled ? 'backend-disabled-tool' : ''}">
                  <div>
                    <div class="tool-name \${(tool.enabled && !tool.backendDisabled) ? '' : 'disabled'}">\${escapeHtml(tool.name)}</div>
                    \${tool.description ? \`<div class="tool-desc">\${escapeHtml(tool.description)}</div>\` : ''}
                  </div>
                  <label class="toggle">
                    <input type="checkbox" \${(tool.enabled && !tool.backendDisabled) ? 'checked' : ''}
                           onchange="toggleTool('\${escapeHtml(tool.name)}', this.checked)">
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              \`).join('')}
            </div>
          </div>
        \`;
      }).join('');
    }
    
    function toggleExpand(backendId) {
      if (expandedBackends.has(backendId)) {
        expandedBackends.delete(backendId);
      } else {
        expandedBackends.add(backendId);
      }
      // Always re-render to ensure consistent state
      renderBackends();
    }
    
    async function toggleTool(name, enabled) {
      try {
        // If enabling a tool, also enable its backend if disabled
        if (enabled) {
          const tool = tools.find(t => t.name === name);
          if (tool && tool.backendDisabled) {
            // Prefer backendId from API; fall back to matching tools to backend
            const backend = tool.backendId
              ? backends.find(b => b.id === tool.backendId)
              : backends.find(b => toolMatchesBackend(tool, b.id));

            if (backend) {
              await fetch('/dashboard/api/backends/' + encodeURIComponent(backend.id) + '/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true })
              });
              backend.enabled = true;
              // Clear backendDisabled flag for all tools of this backend
              tools.forEach(t => {
                if (toolMatchesBackend(t, backend.id)) {
                  t.backendDisabled = false;
                }
              });
            }
          }
        }
        
        await fetch('/dashboard/api/tools/' + encodeURIComponent(name) + '/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        
        const tool = tools.find(t => t.name === name);
        if (tool) tool.enabled = enabled;
        
        updateStats();
        renderBackends(); // Re-render to update UI
        showToast(enabled ? 'Tool enabled' : 'Tool disabled');
      } catch (err) {
        showToast('Error updating tool', true);
      }
    }
    
    async function toggleBackend(id, enabled) {
      try {
        // Toggle the backend
        await fetch('/dashboard/api/backends/' + encodeURIComponent(id) + '/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        
        const backend = backends.find(b => b.id === id);
        if (backend) backend.enabled = enabled;
        
        // Also update all tools for this backend via bulk API
        const backendTools = tools.filter(t => toolMatchesBackend(t, id)).map(t => t.name);
        
        if (backendTools.length > 0) {
          await fetch('/dashboard/api/tools/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tools: backendTools, enabled })
          });
        }
        
        tools.forEach(t => {
          if (toolMatchesBackend(t, id)) {
            t.enabled = enabled;
          }
        });
        
        updateStats();
        renderBackends();
        showToast(enabled ? 'Backend enabled' : 'Backend disabled');
      } catch (err) {
        showToast('Error updating backend', true);
      }
    }
    
    async function toggleAllBackendTools(backendId, enabled) {
      const backendTools = tools.filter(t => toolMatchesBackend(t, backendId)).map(t => t.name);

      try {
        await fetch('/dashboard/api/tools/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tools: backendTools, enabled })
        });

        tools.forEach(t => {
          if (backendTools.includes(t.name)) {
            t.enabled = enabled;
          }
        });

        updateStats();
        renderBackends();
        showToast(enabled ? 'All tools enabled' : 'All tools disabled');
      } catch (err) {
        showToast('Error updating tools', true);
      }
    }
    
    async function enableAll() {
      // Enable all backends (which enables all their tools)
      try {
        for (const backend of backends) {
          await fetch('/dashboard/api/backends/' + encodeURIComponent(backend.id) + '/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true })
          });
          backend.enabled = true;
        }
        
        // Also enable all individual tools
        const allToolNames = tools.map(t => t.name);
        await fetch('/dashboard/api/tools/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tools: allToolNames, enabled: true })
        });
        
        tools.forEach(t => t.enabled = true);
        updateStats();
        renderBackends();
        showToast('All backends & tools enabled');
      } catch (err) {
        showToast('Error enabling', true);
      }
    }
    
    async function disableAll() {
      // Disable all backends (which disables all their tools)
      try {
        for (const backend of backends) {
          await fetch('/dashboard/api/backends/' + encodeURIComponent(backend.id) + '/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false })
          });
          backend.enabled = false;
        }
        
        // Also disable all individual tools
        const allToolNames = tools.map(t => t.name);
        await fetch('/dashboard/api/tools/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tools: allToolNames, enabled: false })
        });
        
        tools.forEach(t => t.enabled = false);
        updateStats();
        renderBackends();
        showToast('All backends & tools disabled');
      } catch (err) {
        showToast('Error disabling', true);
      }
    }
    
    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      const icon = isError 
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 8px; vertical-align: -4px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 8px; vertical-align: -4px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
      toast.innerHTML = icon + message;
      toast.style.borderColor = isError ? 'var(--error)' : 'var(--success)';
      toast.style.color = isError ? 'var(--error)' : 'var(--success)';
      toast.classList.add('show');

      setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    async function triggerFabricLogin() {
      try {
        showToast('Starting Fabric login...');
        const res = await fetch('/dashboard/api/fabric/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        const result = await res.json();
        if (res.ok && result.success) {
          showToast(result.message || 'Fabric login started');
        } else {
          showToast(result.error || 'Fabric login failed', true);
        }
      } catch (err) {
        showToast('Fabric login failed', true);
      }
    }

    async function triggerFabricCheck() {
      try {
        showToast('Checking Fabric token...');
        const res = await fetch('/dashboard/api/fabric/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        const result = await res.json();
        if (res.ok && result.success) {
          const status = result.workspaceProbe === 'ok' ? 'valid' : 'token ok, probe failed';
          const expires = result.expiresOn ? 'exp: ' + result.expiresOn : 'exp unknown';
          const detail = result.workspaceError ? ' (' + result.workspaceError + ')' : '';
          showToast('Fabric token ' + status + ' · ' + expires + detail);
        } else {
          showToast(result.error || 'Fabric token check failed', true);
        }
      } catch (err) {
        showToast('Fabric token check failed', true);
      }
    }

    async function restartServer() {
      if (!confirm('Are you sure you want to restart the MCP Gateway server?')) {
        return;
      }

      try {
        showToast('Restarting server...');
        await fetch('/dashboard/api/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'restart-confirmed' })
        });

        // Wait a moment then start polling for the server to come back
        setTimeout(() => {
          showToast('Server is restarting, waiting for it to come back...');
          pollServerHealth();
        }, 1000);
      } catch (err) {
        showToast('Error restarting server', true);
      }
    }

    function pollServerHealth() {
      let attempts = 0;
      const maxAttempts = 30;

      const poll = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch('/health');
          if (res.ok) {
            clearInterval(poll);
            showToast('Server restarted successfully!');
            loadData();
          }
        } catch (e) {
          if (attempts >= maxAttempts) {
            clearInterval(poll);
            showToast('Server did not come back, please refresh manually', true);
          }
        }
      }, 1000);
    }

    // Search functionality
    document.getElementById('search').addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderBackends();
    });

    // ============ Server Modal Functions ============

    let deleteServerId = null;

    function openAddServerModal() {
      document.getElementById('modal-title').textContent = 'Add Server';
      document.getElementById('edit-server-id').value = '';
      document.getElementById('server-form').reset();
      document.getElementById('server-timeout').value = '30000';
      document.getElementById('server-enabled').checked = true;
      document.getElementById('test-result').innerHTML = '';
      updateTransportFields();
      document.getElementById('server-modal').classList.add('show');
    }

    async function openEditServerModal(serverId) {
      try {
        const res = await fetch('/dashboard/api/servers/' + encodeURIComponent(serverId));
        if (!res.ok) {
          showToast('Failed to load server configuration', true);
          return;
        }

        const { server } = await res.json();

        document.getElementById('modal-title').textContent = 'Edit Server';
        document.getElementById('edit-server-id').value = serverId;
        document.getElementById('server-id').value = server.id;
        document.getElementById('server-name').value = server.name;
        document.getElementById('server-description').value = server.description || '';
        document.getElementById('server-prefix').value = server.toolPrefix || '';
        document.getElementById('server-timeout').value = server.timeout || 30000;
        document.getElementById('server-enabled').checked = server.enabled !== false;

        // Set transport type and fields
        document.getElementById('transport-type').value = server.transport.type;
        updateTransportFields();

        if (server.transport.type === 'stdio') {
          document.getElementById('stdio-command').value = server.transport.command || '';
          document.getElementById('stdio-args').value = server.transport.args ? JSON.stringify(server.transport.args, null, 2) : '';
          document.getElementById('stdio-env').value = server.transport.env ? JSON.stringify(server.transport.env, null, 2) : '';
          document.getElementById('stdio-cwd').value = server.transport.cwd || '';
        } else if (server.transport.type === 'http' || server.transport.type === 'sse') {
          document.getElementById('http-url').value = server.transport.url || '';
          document.getElementById('http-headers').value = server.transport.headers ? JSON.stringify(server.transport.headers, null, 2) : '';
        }

        document.getElementById('test-result').innerHTML = '';
        document.getElementById('server-modal').classList.add('show');
      } catch (err) {
        showToast('Failed to load server configuration', true);
      }
    }

    function closeServerModal() {
      document.getElementById('server-modal').classList.remove('show');
    }

    function updateTransportFields() {
      const type = document.getElementById('transport-type').value;
      document.getElementById('stdio-fields').style.display = type === 'stdio' ? 'block' : 'none';
      document.getElementById('http-fields').style.display = (type === 'http' || type === 'sse') ? 'block' : 'none';
    }

    function buildServerConfig() {
      const transportType = document.getElementById('transport-type').value;
      let transport;

      if (transportType === 'stdio') {
        const argsText = document.getElementById('stdio-args').value.trim();
        const envText = document.getElementById('stdio-env').value.trim();

        transport = {
          type: 'stdio',
          command: document.getElementById('stdio-command').value.trim(),
        };

        if (argsText) {
          try {
            transport.args = JSON.parse(argsText);
          } catch (e) {
            throw new Error('Invalid JSON in Arguments field');
          }
        }

        if (envText) {
          try {
            transport.env = JSON.parse(envText);
          } catch (e) {
            throw new Error('Invalid JSON in Environment Variables field');
          }
        }

        const cwd = document.getElementById('stdio-cwd').value.trim();
        if (cwd) {
          transport.cwd = cwd;
        }
      } else {
        const headersText = document.getElementById('http-headers').value.trim();

        transport = {
          type: transportType,
          url: document.getElementById('http-url').value.trim(),
        };

        if (headersText) {
          try {
            transport.headers = JSON.parse(headersText);
          } catch (e) {
            throw new Error('Invalid JSON in Headers field');
          }
        }
      }

      const config = {
        id: document.getElementById('server-id').value.trim(),
        name: document.getElementById('server-name').value.trim(),
        transport,
        enabled: document.getElementById('server-enabled').checked,
        timeout: parseInt(document.getElementById('server-timeout').value, 10) || 30000,
      };

      const description = document.getElementById('server-description').value.trim();
      if (description) {
        config.description = description;
      }

      const prefix = document.getElementById('server-prefix').value.trim();
      if (prefix) {
        config.toolPrefix = prefix;
      }

      return config;
    }

    async function testServerConnection() {
      const resultDiv = document.getElementById('test-result');

      try {
        const config = buildServerConfig();

        resultDiv.className = 'test-result loading';
        resultDiv.textContent = 'Testing connection...';

        const res = await fetch('/dashboard/api/servers/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });

        const result = await res.json();

        if (result.success) {
          resultDiv.className = 'test-result success';
          resultDiv.textContent = 'Connection successful! Found ' + result.toolCount + ' tools, ' +
            result.resourceCount + ' resources, ' + result.promptCount + ' prompts.';
        } else {
          resultDiv.className = 'test-result error';
          resultDiv.textContent = 'Connection failed: ' + (result.error || result.message || 'Unknown error');
        }
      } catch (err) {
        resultDiv.className = 'test-result error';
        resultDiv.textContent = 'Error: ' + err.message;
      }
    }

    async function saveServer() {
      try {
        const config = buildServerConfig();
        const editId = document.getElementById('edit-server-id').value;
        const isEdit = !!editId;

        const url = isEdit
          ? '/dashboard/api/servers/' + encodeURIComponent(editId)
          : '/dashboard/api/servers';

        const method = isEdit ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });

        const result = await res.json();

        if (!res.ok) {
          showToast(result.error || result.message || 'Failed to save server', true);
          return;
        }

        closeServerModal();
        showToast(isEdit ? 'Server updated successfully' : 'Server added successfully');
        loadData();
      } catch (err) {
        showToast('Error: ' + err.message, true);
      }
    }

    // ============ Delete Modal Functions ============

    function openDeleteModal(serverId) {
      deleteServerId = serverId;
      document.getElementById('delete-server-name').textContent = serverId;
      document.getElementById('delete-modal').classList.add('show');
    }

    function closeDeleteModal() {
      deleteServerId = null;
      document.getElementById('delete-modal').classList.remove('show');
    }

    async function confirmDeleteServer() {
      if (!deleteServerId) return;

      try {
        const res = await fetch('/dashboard/api/servers/' + encodeURIComponent(deleteServerId), {
          method: 'DELETE',
        });

        const result = await res.json();

        if (!res.ok) {
          showToast(result.error || result.message || 'Failed to delete server', true);
          return;
        }

        closeDeleteModal();
        showToast('Server deleted successfully');
        loadData();
      } catch (err) {
        showToast('Error: ' + err.message, true);
      }
    }

    // Close modals when clicking outside
    document.getElementById('server-modal').addEventListener('click', (e) => {
      if (e.target.id === 'server-modal') {
        closeServerModal();
      }
    });

    document.getElementById('delete-modal').addEventListener('click', (e) => {
      if (e.target.id === 'delete-modal') {
        closeDeleteModal();
      }
    });

    // Close modals with Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeServerModal();
        closeDeleteModal();
      }
    });

    // ==========================================
    // Feature Flags (Optional Features)
    // ==========================================
    let featureFlags = { skills: false, cipher: false, antigravity: false, claudeUsage: false };

    async function loadFeatureFlags() {
      try {
        const res = await fetch('/dashboard/api/feature-flags');
        const data = await res.json();
        featureFlags = data.features || { skills: false, cipher: false, antigravity: false, claudeUsage: false };
        applyFeatureFlags();
      } catch (err) {
        console.warn('Failed to load feature flags, using defaults:', err);
      }
    }

    function applyFeatureFlags() {
      // Hide/show tabs based on feature flags
      const memoryTabBtn = document.querySelector('[onclick="switchTab(\\'memory\\')"]');
      const memoryTab = document.getElementById('tab-memory');
      const skillsTabBtn = document.querySelector('[onclick="switchTab(\\'skills\\')"]');
      const skillsTab = document.getElementById('tab-skills');
      const antigravityTabBtn = document.getElementById('antigravity-tab-btn');
      const antigravityTab = document.getElementById('tab-antigravity');
      const usageTabBtn = document.querySelector('[onclick="switchTab(\\'usage\\')"]');
      const usageTab = document.getElementById('tab-usage');

      // Memory (Cipher) tab
      if (memoryTabBtn) memoryTabBtn.style.display = featureFlags.cipher ? '' : 'none';
      if (memoryTab) memoryTab.style.display = featureFlags.cipher ? '' : 'none';

      // Skills tab
      if (skillsTabBtn) skillsTabBtn.style.display = featureFlags.skills ? '' : 'none';
      if (skillsTab) skillsTab.style.display = featureFlags.skills ? '' : 'none';

      // Antigravity tab - already has conditional visibility, but also apply feature flag
      if (!featureFlags.antigravity) {
        if (antigravityTabBtn) antigravityTabBtn.style.display = 'none';
        if (antigravityTab) antigravityTab.style.display = 'none';
      }

      // Claude Usage tab
      if (usageTabBtn) usageTabBtn.style.display = featureFlags.claudeUsage ? '' : 'none';
      if (usageTab) usageTab.style.display = featureFlags.claudeUsage ? '' : 'none';

      // Hide overview cards for disabled features
      const recentMemoriesCard = document.querySelector('.overview-card:has(#recent-memories-list)');
      const topSkillsCard = document.querySelector('.overview-card:has(#top-skills-list)');
      const usageSummaryCard = document.querySelector('.overview-card:has(#usage-summary)');
      if (recentMemoriesCard) recentMemoriesCard.style.display = featureFlags.cipher ? '' : 'none';
      if (topSkillsCard) topSkillsCard.style.display = featureFlags.skills ? '' : 'none';
      if (usageSummaryCard) usageSummaryCard.style.display = featureFlags.claudeUsage ? '' : 'none';
    }

    // Load feature flags on page load, then initialize overview
    loadFeatureFlags().then(() => {
      // Ensure feature flags are loaded before initializing overview
      initializeOverview();
    });

    // ==========================================
    // Tab Navigation
    // ==========================================
    let currentTab = 'overview';
    let overviewLoaded = false;

    function switchTab(tabId) {
      currentTab = tabId;

      // Update tab buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
      });
      document.querySelector(\`[onclick="switchTab('\${tabId}')"]\`).classList.add('active');

      // Update tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.getElementById('tab-' + tabId).classList.add('active');

      // Load data for overview tab
      if (tabId === 'overview' && !overviewLoaded) {
        loadOverviewData();
        overviewLoaded = true;
      }

      // Load data for usage tab (only if Claude usage feature is enabled)
      if (tabId === 'usage' && !usageData && featureFlags.claudeUsage) {
        loadUsageData();
      }

      // Load data for memory tab (only if cipher feature is enabled)
      if (tabId === 'memory' && !memoryData && featureFlags.cipher) {
        loadMemoryData();
      }

      // Load data for antigravity tab and start auto-refresh (only if antigravity feature is enabled)
      if (tabId === 'antigravity' && featureFlags.antigravity) {
        if (!antigravityData) {
          loadAntigravityData();
        }
        startAntigravityAutoRefresh();
      } else {
        stopAntigravityAutoRefresh();
      }

      // Load data for skills tab (only if skills feature is enabled)
      if (tabId === 'skills' && featureFlags.skills && skillsData.length === 0) {
        loadSkillsData();
      }
    }

    // ==========================================
    // Overview Tab Data Loading
    // ==========================================
    async function loadOverviewData() {
      try {
        // Load quick stats (this also updates header stats)
        await loadOverviewQuickStats();

        // Load backend health
        await loadOverviewBackendHealth();

        // Load recent memories (only if cipher feature is enabled)
        if (featureFlags.cipher) {
          try {
            await loadOverviewRecentMemories();
          } catch (err) {
            console.warn('Failed to load recent memories (feature may be disabled):', err);
          }
        }

        // Load skills list (only if skills feature is enabled)
        if (featureFlags.skills) {
          try {
            await loadOverviewSkills();
          } catch (err) {
            console.warn('Failed to load skills (feature may be disabled):', err);
          }
        }

        // Load usage summary (only if Claude usage feature is enabled)
        if (featureFlags.claudeUsage) {
          try {
            await loadOverviewUsageSummary();
          } catch (err) {
            console.warn('Failed to load usage summary (feature may be disabled):', err);
          }
        }
      } catch (err) {
        console.error('Failed to load overview data:', err);
      }
    }

    // Initialize overview page (called after feature flags are loaded)
    function initializeOverview() {
      if (!overviewLoaded) {
        loadOverviewData();
        overviewLoaded = true;
      }
    }

    async function loadOverviewQuickStats() {
      const container = document.getElementById('overview-quick-stats');
      let stats = null;
      
      try {
        // Always fetch stats, conditionally fetch skills
        const fetchPromises = [fetch('/dashboard/api/stats')];
        if (featureFlags.skills) {
          fetchPromises.push(fetch('/dashboard/api/skills'));
        }

        const responses = await Promise.all(fetchPromises);
        
        // Check if stats response is ok
        if (!responses[0].ok) {
          throw new Error(\`Stats API returned \${responses[0].status}\`);
        }
        
        stats = await responses[0].json();
        const skillsData = featureFlags.skills ? await responses[1].json() : { skills: [] };

        const backendCount = Object.keys(stats.backends || {}).length;
        const skillCount = (skillsData.skills || []).length;

        // Update header stats (always, even if display fails)
        updateHeaderStats(stats);

        // Build stats HTML, conditionally including skills stat
        const skillsStatHtml = featureFlags.skills ? \`
          <div class="overview-quick-stat">
            <div class="overview-quick-stat-icon skills">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline></svg>
            </div>
            <div>
              <div class="overview-quick-stat-value">\${skillCount}</div>
              <div class="overview-quick-stat-label">Skills</div>
            </div>
          </div>
        \` : '';

        container.innerHTML = \`
          <div class="overview-quick-stat">
            <div class="overview-quick-stat-icon servers">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"></rect><rect x="2" y="14" width="20" height="8" rx="2"></rect></svg>
            </div>
            <div>
              <div class="overview-quick-stat-value">\${backendCount}</div>
              <div class="overview-quick-stat-label">Servers</div>
            </div>
          </div>
          <div class="overview-quick-stat">
            <div class="overview-quick-stat-icon tools">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
            </div>
            <div>
              <div class="overview-quick-stat-value">\${stats.totalTools || 0}</div>
              <div class="overview-quick-stat-label">Tools</div>
            </div>
          </div>
          \${skillsStatHtml}
          <div class="overview-quick-stat">
            <div class="overview-quick-stat-icon memory">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4l3 3"></path></svg>
            </div>
            <div>
              <div class="overview-quick-stat-value">\${stats.enabledTools || 0}</div>
              <div class="overview-quick-stat-label">Enabled</div>
            </div>
          </div>
        \`;
      } catch (err) {
        console.error('Failed to load overview stats:', err);
        
        // Try to update header stats using fallback method (from tools/backends API)
        try {
          await updateHeaderStatsFallback();
        } catch (fallbackErr) {
          console.warn('Fallback header stats update also failed:', fallbackErr);
        }
        
        if (container) {
          container.innerHTML = '<div class="overview-empty">Failed to load stats</div>';
        }
      }
    }
    
    // Fallback method to update header stats using tools/backends API
    async function updateHeaderStatsFallback() {
      try {
        const [backendsRes, toolsRes] = await Promise.all([
          fetch('/dashboard/api/backends'),
          fetch('/dashboard/api/tools')
        ]);
        
        if (!backendsRes.ok || !toolsRes.ok) {
          throw new Error('API calls failed');
        }
        
        const backends = (await backendsRes.json()).backends || [];
        const tools = (await toolsRes.json()).tools || [];
        
        const enabledTools = tools.filter(t => t.enabled);
        const connectedBackends = backends.filter(b => b.status === 'connected').length;
        
        const enabledCountEl = document.getElementById('enabled-count');
        const totalCountEl = document.getElementById('total-count');
        const backendsCountEl = document.getElementById('backends-count');
        
        if (enabledCountEl) {
          enabledCountEl.textContent = enabledTools.length.toString();
        }
        if (totalCountEl) {
          totalCountEl.textContent = tools.length.toString();
        }
        if (backendsCountEl) {
          backendsCountEl.textContent = \`\${connectedBackends}/\${backends.length}\`;
        }
      } catch (err) {
        console.error('Fallback header stats update failed:', err);
        throw err;
      }
    }

    // Update header stats (enabled tools, total tools, backends)
    function updateHeaderStats(stats) {
      try {
        const enabledCountEl = document.getElementById('enabled-count');
        const totalCountEl = document.getElementById('total-count');
        const backendsCountEl = document.getElementById('backends-count');

        if (enabledCountEl) {
          enabledCountEl.textContent = (stats.enabledTools || 0).toString();
        }
        if (totalCountEl) {
          totalCountEl.textContent = (stats.totalTools || 0).toString();
        }
        if (backendsCountEl && stats.backends) {
          const backendIds = Object.keys(stats.backends);
          const connectedCount = backendIds.filter(id => stats.backends[id]?.status === 'connected').length;
          backendsCountEl.textContent = \`\${connectedCount}/\${backendIds.length}\`;
        }
      } catch (err) {
        console.warn('Failed to update header stats:', err);
      }
    }

    async function loadOverviewBackendHealth() {
      const container = document.getElementById('health-list');
      const badge = document.getElementById('health-badge');
      try {
        const res = await fetch('/dashboard/api/backends');
        const data = await res.json();
        const backends = data.backends || [];

        const connected = backends.filter(b => b.status === 'connected').length;
        const disconnected = backends.filter(b => b.status !== 'connected').length;

        if (disconnected > 0) {
          badge.textContent = \`\${disconnected} Issues\`;
          badge.classList.add('warning');
        } else {
          badge.textContent = 'All Connected';
          badge.classList.remove('warning');
        }

        // Show top 5 backends
        const topBackends = backends.slice(0, 5);
        container.innerHTML = topBackends.map(b => \`
          <div class="health-item">
            <div class="health-item-name">
              <span class="health-item-status \${b.status === 'connected' ? 'healthy' : 'error'}"></span>
              \${b.id}
            </div>
            <span class="health-item-tools">\${b.toolCount || 0} tools</span>
          </div>
        \`).join('');

        if (backends.length > 5) {
          container.innerHTML += \`<div class="health-item" style="cursor: pointer;" onclick="switchTab('servers')">
            <div class="health-item-name" style="color: var(--accent);">View all \${backends.length} servers →</div>
          </div>\`;
        }
      } catch (err) {
        console.error('Failed to load backend health:', err);
        container.innerHTML = '<div class="overview-empty">Failed to load backends</div>';
      }
    }

    async function loadOverviewRecentMemories() {
      const container = document.getElementById('recent-memories-list');
      try {
        const res = await fetch('/dashboard/api/cipher/qdrant-stats');
        if (!res.ok) {
          container.innerHTML = '<div class="overview-empty">Memory not configured</div>';
          return;
        }
        const data = await res.json();
        const memories = data.recentMemories || [];

        if (memories.length === 0) {
          container.innerHTML = '<div class="overview-empty">No memories yet</div>';
          return;
        }

        const recentMemories = memories.slice(0, 4);
        container.innerHTML = recentMemories.map(m => {
          const timeAgo = getTimeAgo(new Date(m.timestamp));
          const truncatedText = m.text.length > 60 ? m.text.substring(0, 60) + '...' : m.text;
          return \`
            <div class="activity-item">
              <div class="activity-icon memory">💭</div>
              <div class="activity-text">\${truncatedText}</div>
              <div class="activity-time">\${timeAgo}</div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Failed to load memories:', err);
        container.innerHTML = '<div class="overview-empty">Failed to load memories</div>';
      }
    }

    async function loadOverviewSkills() {
      const container = document.getElementById('top-skills-list');
      const badge = document.getElementById('skills-count-badge');
      try {
        const res = await fetch('/dashboard/api/skills');
        const data = await res.json();
        const skills = data.skills || [];

        badge.textContent = \`\${skills.length} skills\`;

        if (skills.length === 0) {
          container.innerHTML = '<div class="overview-empty">No skills found</div>';
          return;
        }

        const topSkills = skills.slice(0, 5);
        container.innerHTML = topSkills.map(s => \`
          <div class="health-item">
            <div class="health-item-name">
              <span class="health-item-status healthy"></span>
              \${s.name}
            </div>
            <span class="health-item-tools">\${s.tags?.length || 0} tags</span>
          </div>
        \`).join('');

        if (skills.length > 5) {
          container.innerHTML += \`<div class="health-item" style="cursor: pointer;" onclick="switchTab('skills')">
            <div class="health-item-name" style="color: var(--accent);">View all \${skills.length} skills →</div>
          </div>\`;
        }
      } catch (err) {
        console.error('Failed to load skills:', err);
        container.innerHTML = '<div class="overview-empty">Failed to load skills</div>';
      }
    }

    async function loadOverviewUsageSummary() {
      try {
        const res = await fetch('/dashboard/api/usage/cached');
        if (!res.ok) return;
        const data = await res.json();

        const today = data.byDate?.[0];
        if (today) {
          document.getElementById('usage-api-calls').textContent = today.totalCalls?.toLocaleString() || '--';
          document.getElementById('usage-input-tokens').textContent = formatTokens(today.inputTokens);
          document.getElementById('usage-output-tokens').textContent = formatTokens(today.outputTokens);
        }
      } catch (err) {
        console.error('Failed to load usage summary:', err);
      }
    }

    function formatTokens(num) {
      if (!num) return '--';
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return num.toString();
    }

    function getTimeAgo(date) {
      const seconds = Math.floor((new Date() - date) / 1000);
      if (seconds < 60) return 'just now';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return \`\${minutes}m ago\`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return \`\${hours}h ago\`;
      const days = Math.floor(hours / 24);
      return \`\${days}d ago\`;
    }

    // ==========================================
    // Antigravity Usage
    // ==========================================
    let antigravityData = null;
    let antigravityAvailable = false;

    async function checkAntigravityAvailable() {
      try {
        const res = await fetch('/dashboard/api/antigravity/available');
        const data = await res.json();
        antigravityAvailable = data.available;

        // Show/hide the tab button based on availability
        const tabBtn = document.getElementById('antigravity-tab-btn');
        if (tabBtn) {
          tabBtn.style.display = antigravityAvailable ? 'flex' : 'none';
        }

        return antigravityAvailable;
      } catch (err) {
        console.error('Failed to check Antigravity availability:', err);
        return false;
      }
    }

    async function loadAntigravityData() {
      const statusContainer = document.getElementById('antigravity-status-container');
      const accountsContainer = document.getElementById('antigravity-accounts-container');

      statusContainer.innerHTML = '<div class="antigravity-loading">Checking Antigravity status...</div>';
      accountsContainer.innerHTML = '';

      try {
        const res = await fetch('/dashboard/api/antigravity/summary');

        if (!res.ok) {
          const error = await res.json();
          statusContainer.innerHTML = \`
            <div class="antigravity-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path></svg>
              <p><strong>Failed to load Antigravity data</strong></p>
              <p>\${error.message || 'Unknown error'}</p>
            </div>
          \`;
          return;
        }

        antigravityData = await res.json();
        renderAntigravityStatus();
        renderAntigravityAccounts();
      } catch (err) {
        statusContainer.innerHTML = \`
          <div class="antigravity-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path></svg>
            <p><strong>Error loading Antigravity data</strong></p>
            <p>\${err.message}</p>
          </div>
        \`;
      }
    }

    function renderAntigravityStatus() {
      if (!antigravityData) return;

      const container = document.getElementById('antigravity-status-container');
      const status = antigravityData.status;

      const statusClass = status.isRunning ? 'running' : '';
      const statusText = status.isRunning
        ? \`<strong>Antigravity IDE is running</strong> (PID: \${status.processId}\${status.port ? ', Port: ' + status.port : ''})\`
        : '<strong>Antigravity IDE is not running</strong> — Start the IDE to see live quota data';

      container.innerHTML = \`
        <div class="antigravity-status">
          <div class="antigravity-status-indicator \${statusClass}"></div>
          <div class="antigravity-status-text">\${statusText}</div>
        </div>
      \`;
    }

    function renderAntigravityAccounts() {
      if (!antigravityData) return;

      const container = document.getElementById('antigravity-accounts-container');
      const accounts = antigravityData.status.accounts;

      if (!accounts || accounts.length === 0) {
        container.innerHTML = \`
          <div class="antigravity-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path></svg>
            <p>No Antigravity accounts found</p>
          </div>
        \`;
        return;
      }

      const rocketIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path></svg>';

      const cardsHTML = accounts.map(account => {
        const convStats = antigravityData.conversationStats[account.accountId] || {};
        const brainStats = antigravityData.brainStats[account.accountId] || {};

        const accountName = account.accountId === 'primary' ? 'Antigravity' : 'Techgravity';
        const cardClass = account.accountId === 'techgravity' ? 'techgravity' : '';

        // Render quota bars
        const quotaBarsHTML = account.models.map(model => {
          const pct = model.remainingPercentage;
          const level = pct > 50 ? 'high' : pct > 20 ? 'medium' : 'low';
          return \`
            <div class="antigravity-quota-bar">
              <div class="antigravity-quota-model">\${model.label}</div>
              <div class="antigravity-quota-progress">
                <div class="antigravity-quota-fill \${level}" style="width: \${pct}%"></div>
              </div>
              <div class="antigravity-quota-percent \${level}">\${pct}%</div>
            </div>
          \`;
        }).join('');

        return \`
          <div class="antigravity-account-card \${cardClass}">
            <div class="antigravity-account-header">
              <div class="antigravity-account-icon">\${rocketIcon}</div>
              <div>
                <div class="antigravity-account-name">\${accountName}</div>
                \${account.accountEmail ? \`<div class="antigravity-account-email">\${account.accountEmail}</div>\` : ''}
              </div>
            </div>
            <div class="antigravity-stats-grid">
              <div class="antigravity-stat">
                <div class="antigravity-stat-value">\${convStats.totalConversations || 0}</div>
                <div class="antigravity-stat-label">Conversations</div>
              </div>
              <div class="antigravity-stat">
                <div class="antigravity-stat-value">\${convStats.formattedSize || '0 B'}</div>
                <div class="antigravity-stat-label">Data Size</div>
              </div>
              <div class="antigravity-stat">
                <div class="antigravity-stat-value">\${brainStats.totalTasks || 0}</div>
                <div class="antigravity-stat-label">Brain Tasks</div>
              </div>
              <div class="antigravity-stat">
                <div class="antigravity-stat-value">\${convStats.recentConversations || 0}</div>
                <div class="antigravity-stat-label">This Week</div>
              </div>
            </div>
            <div class="antigravity-quota-section">
              <div class="antigravity-quota-title">Model Quota (Estimated)</div>
              <div class="antigravity-quota-bars">\${quotaBarsHTML}</div>
            </div>
          </div>
        \`;
      }).join('');

      container.innerHTML = \`<div class="antigravity-accounts-grid">\${cardsHTML}</div>\`;
    }

    async function refreshAntigravityData() {
      antigravityData = null;
      try {
        await fetch('/dashboard/api/antigravity/refresh', { method: 'POST' });
      } catch (err) {
        console.error('Failed to refresh:', err);
      }
      loadAntigravityData();
      showToast('Antigravity data refreshed');
    }

    // Auto-refresh Antigravity data when tab is active
    let antigravityAutoRefreshInterval = null;
    const ANTIGRAVITY_REFRESH_INTERVAL = 15000; // 15 seconds

    function startAntigravityAutoRefresh() {
      if (antigravityAutoRefreshInterval) return;
      antigravityAutoRefreshInterval = setInterval(async () => {
        if (currentTab !== 'antigravity') return;
        try {
          await fetch('/dashboard/api/antigravity/refresh', { method: 'POST' });
          const res = await fetch('/dashboard/api/antigravity/summary');
          if (res.ok) {
            antigravityData = await res.json();
            renderAntigravityStatus();
            renderAntigravityAccounts();
          }
        } catch (err) {
          console.error('Auto-refresh failed:', err);
        }
      }, ANTIGRAVITY_REFRESH_INTERVAL);
    }

    function stopAntigravityAutoRefresh() {
      if (antigravityAutoRefreshInterval) {
        clearInterval(antigravityAutoRefreshInterval);
        antigravityAutoRefreshInterval = null;
      }
    }

    // ==========================================
    // Claude Usage Analytics
    // ==========================================
    let usageData = null;
    let dailyChart = null;
    let modelChart = null;
    let liveSessionInterval = null;

    async function loadUsageData() {
      const statsContainer = document.getElementById('usage-stats-container');
      const chartsContainer = document.getElementById('usage-charts-container');

      statsContainer.innerHTML = '<div class="usage-loading">Loading usage data...</div>';
      chartsContainer.innerHTML = '';

      try {
        const res = await fetch('/dashboard/api/claude-usage');

        if (!res.ok) {
          const error = await res.json();
          statsContainer.innerHTML = \`
            <div class="usage-error">
              <p><strong>Failed to load usage data</strong></p>
              <p>\${error.message || 'Make sure ccusage is installed: npx ccusage@latest'}</p>
            </div>
          \`;
          return;
        }

        usageData = await res.json();
        renderUsageStats();
        renderUsageCharts();
        startLiveSessionMonitor();
      } catch (err) {
        statsContainer.innerHTML = \`
          <div class="usage-error">
            <p><strong>Error loading usage data</strong></p>
            <p>\${err.message}</p>
          </div>
        \`;
      }
    }

    function renderUsageStats() {
      if (!usageData) return;

      const container = document.getElementById('usage-stats-container');
      const formatCost = (cost) => '$' + cost.toFixed(2);
      
      const formatCompactNumber = (num) => {
        if (num >= 1000000000) {
          return (num / 1000000000).toFixed(2) + 'B';
        }
        if (num >= 1000000) {
          return (num / 1000000).toFixed(2) + 'M';
        }
        if (num >= 1000) {
          return (num / 1000).toFixed(1) + 'k';
        }
        return num.toLocaleString();
      };
      
      const formatPercent = (pct) => pct.toFixed(1) + '%';

      // Calculate additional metrics
      const projectedMonthly = usageData.avgCostPerDay * 30;
      const cacheSavings = usageData.totalCacheReadTokens * 0.000003; // Approx savings from cache
      const totalRequests = usageData.totalSessions || usageData.daily?.length || 0;

      container.innerHTML = \`
        <div class="usage-grid">
          <div class="usage-stat">
            <div class="usage-stat-value large">\${formatCost(usageData.totalCost)}</div>
            <div class="usage-stat-label">Total Spend</div>
            <div class="usage-stat-sublabel">\${usageData.daysActive} days active</div>
          </div>
          <div class="usage-stat">
            <div class="usage-stat-value">\${formatCost(usageData.avgCostPerDay)}</div>
            <div class="usage-stat-label">Avg Cost/Day</div>
            <div class="usage-stat-sublabel">~\${formatCost(projectedMonthly)}/month projected</div>
          </div>
          <div class="usage-stat success">
            <div class="usage-stat-value">\${formatPercent(usageData.cacheHitRatio)}</div>
            <div class="usage-stat-label">Cache Hit Ratio</div>
            <div class="usage-stat-sublabel">~\${formatCost(cacheSavings)} saved</div>
          </div>
          <div class="usage-stat">
            <div class="usage-stat-value">\${formatCompactNumber(usageData.totalInputTokens + usageData.totalOutputTokens)}</div>
            <div class="usage-stat-label">Total Tokens</div>
            <div class="usage-stat-sublabel">\${formatCompactNumber(usageData.totalInputTokens)} in / \${formatCompactNumber(usageData.totalOutputTokens)} out</div>
          </div>
        </div>
        <div class="usage-grid" style="margin-top: -1rem;">
          <div class="usage-stat">
            <div class="usage-stat-value">\${formatCompactNumber(usageData.totalCacheCreationTokens || 0)}</div>
            <div class="usage-stat-label">Cache Write</div>
          </div>
          <div class="usage-stat">
            <div class="usage-stat-value">\${formatCompactNumber(usageData.totalCacheReadTokens || 0)}</div>
            <div class="usage-stat-label">Cache Read</div>
          </div>
          <div class="usage-stat">
            <div class="usage-stat-value">\${formatCompactNumber(usageData.totalInputTokens || 0)}</div>
            <div class="usage-stat-label">Input Tokens</div>
          </div>
          <div class="usage-stat">
            <div class="usage-stat-value">\${formatCompactNumber(usageData.totalOutputTokens || 0)}</div>
            <div class="usage-stat-label">Output Tokens</div>
          </div>
        </div>
      \`;
    }

    function renderUsageCharts() {
      if (!usageData || !usageData.daily || usageData.daily.length === 0) return;

      const container = document.getElementById('usage-charts-container');

      // Get model colors
      const modelColors = {
        'Claude Opus': '#8b5cf6',
        'Claude Sonnet': '#22d3ee',
        'Claude Haiku': '#34d399',
      };

      // Build model breakdown HTML
      const modelBreakdownHTML = usageData.modelDistribution
        .slice(0, 5)
        .map((m, i) => {
          const color = modelColors[m.model] || ['#f87171', '#fbbf24', '#a78bfa'][i % 3];
          return \`
            <div class="model-item">
              <div class="model-color" style="background: \${color}"></div>
              <span class="model-name">\${m.model}</span>
              <span class="model-cost">$\${m.cost.toFixed(2)}</span>
              <span class="model-percent">\${m.percentage.toFixed(1)}%</span>
            </div>
          \`;
        })
        .join('');

      // Build top days HTML
      const topDaysHTML = usageData.topDays
        .slice(0, 5)
        .map(day => \`
          <li>
            <span class="top-day-date">\${formatDate(day.date)}</span>
            <span class="top-day-cost">$\${day.totalCost.toFixed(2)}</span>
          </li>
        \`)
        .join('');

      container.innerHTML = \`
        <div class="charts-grid">
          <div class="chart-card">
            <h3>Daily Cost Trend</h3>
            <div class="chart-container">
              <canvas id="daily-chart"></canvas>
            </div>
          </div>
          <div class="chart-card">
            <h3>Model Distribution</h3>
            <div class="chart-container">
              <canvas id="model-chart"></canvas>
            </div>
            <div class="model-breakdown">
              \${modelBreakdownHTML}
            </div>
          </div>
        </div>
        <div class="charts-grid">
          <div class="chart-card">
            <h3>Top Usage Days</h3>
            <ul class="top-days-list">
              \${topDaysHTML || '<li><span class="top-day-date">No data</span></li>'}
            </ul>
          </div>
          <div class="chart-card">
            <h3>Token Efficiency</h3>
            <div class="chart-container" style="height: 200px;">
              <canvas id="efficiency-chart"></canvas>
            </div>
          </div>
        </div>
      \`;

      // Render charts
      renderDailyChart();
      renderModelChart();
      renderEfficiencyChart();
    }

    function formatDate(dateStr) {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function renderDailyChart() {
      const ctx = document.getElementById('daily-chart');
      if (!ctx || !usageData?.daily) return;

      // Get last 30 days of data
      const recentData = usageData.daily.slice(-30);

      if (dailyChart) {
        dailyChart.destroy();
      }

      dailyChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: recentData.map(d => formatDate(d.date)),
          datasets: [{
            label: 'Daily Cost',
            data: recentData.map(d => d.totalCost),
            backgroundColor: 'rgba(139, 92, 246, 0.6)',
            borderColor: 'rgba(139, 92, 246, 1)',
            borderWidth: 1,
            borderRadius: 4,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              callbacks: {
                label: (ctx) => '$' + ctx.raw.toFixed(2)
              }
            }
          },
          scales: {
            x: {
              grid: {
                display: false,
                color: 'rgba(255,255,255,0.1)'
              },
              ticks: {
                color: '#94a3b8',
                maxRotation: 45,
                minRotation: 45
              }
            },
            y: {
              grid: {
                color: 'rgba(255,255,255,0.05)'
              },
              ticks: {
                color: '#94a3b8',
                callback: (val) => '$' + val
              }
            }
          }
        }
      });
    }

    function renderModelChart() {
      const ctx = document.getElementById('model-chart');
      if (!ctx || !usageData?.modelDistribution) return;

      const colors = ['#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#f87171'];
      const data = usageData.modelDistribution.slice(0, 5);

      if (modelChart) {
        modelChart.destroy();
      }

      modelChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: data.map(m => m.model),
          datasets: [{
            data: data.map(m => m.cost),
            backgroundColor: colors.slice(0, data.length),
            borderWidth: 0,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '65%',
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              callbacks: {
                label: (ctx) => ctx.label + ': $' + ctx.raw.toFixed(2)
              }
            }
          }
        }
      });
    }

    function renderEfficiencyChart() {
      const ctx = document.getElementById('efficiency-chart');
      if (!ctx || !usageData) return;

      const cacheWrite = usageData.totalCacheCreationTokens;
      const cacheRead = usageData.totalCacheReadTokens;
      const input = usageData.totalInputTokens;
      const output = usageData.totalOutputTokens;

      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Cache Write', 'Cache Read', 'Input', 'Output'],
          datasets: [{
            data: [cacheWrite, cacheRead, input, output].map(v => v / 1000000),
            backgroundColor: ['#fbbf24', '#34d399', '#8b5cf6', '#22d3ee'],
            borderWidth: 0,
            borderRadius: 4,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: 'y',
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              callbacks: {
                label: (ctx) => ctx.raw.toFixed(2) + 'M tokens'
              }
            }
          },
          scales: {
            x: {
              grid: {
                color: 'rgba(255,255,255,0.05)'
              },
              ticks: {
                color: '#94a3b8',
                callback: (val) => val + 'M'
              }
            },
            y: {
              grid: {
                display: false
              },
              ticks: {
                color: '#94a3b8'
              }
            }
          }
        }
      });
    }

    async function refreshUsageData() {
      usageData = null;
      await loadUsageData();
      showToast('Usage data refreshed');
    }

    // Live session monitoring
    async function updateLiveSession() {
      const container = document.getElementById('live-session-container');

      try {
        const res = await fetch('/dashboard/api/claude-usage/current');
        const data = await res.json();

        if (data.active && data.session) {
          const s = data.session;
          const startTime = s.startTime ? new Date(s.startTime).toLocaleTimeString() : 'Unknown';

          container.innerHTML = \`
            <div class="live-session">
              <div class="live-indicator"></div>
              <div class="live-session-info">
                <div class="live-session-title">Active Session: \${s.slug || s.sessionId}</div>
                <div class="live-session-meta">
                  Started: \${startTime} · Model: \${s.model || 'Unknown'} ·
                  Tokens: \${(s.inputTokens + s.outputTokens).toLocaleString()}
                </div>
              </div>
              <div class="live-session-cost">$\${s.totalCost.toFixed(4)}</div>
            </div>
          \`;
        } else {
          container.innerHTML = '';
        }
      } catch (err) {
        container.innerHTML = '';
      }
    }

    function startLiveSessionMonitor() {
      if (liveSessionInterval) {
        clearInterval(liveSessionInterval);
      }

      // Initial update
      updateLiveSession();

      // Update every 5 seconds
      liveSessionInterval = setInterval(() => {
        if (currentTab === 'usage') {
          updateLiveSession();
        }
      }, 5000);
    }

    // ==========================================
    // Cipher Memory
    // ==========================================
    let memoryData = null;
    let memorySessions = [];
    let qdrantStats = null;

    async function loadMemoryData() {
      const statsContainer = document.getElementById('memory-stats-container');
      const sessionsContainer = document.getElementById('memory-sessions-container');

      statsContainer.innerHTML = '<div class="memory-loading">Connecting to Cipher Memory...</div>';
      sessionsContainer.innerHTML = '<div class="memory-loading">Loading memories...</div>';

      // Fetch Qdrant stats (actual persistent memories)
      try {
        const qdrantRes = await fetch('/dashboard/api/cipher/qdrant-stats');
        if (qdrantRes.ok) {
          qdrantStats = await qdrantRes.json();
        }
      } catch (err) {
        console.warn('Could not fetch Qdrant stats:', err);
      }

      // Fetch Cipher sessions (local conversation history)
      try {
        const res = await fetch('/dashboard/api/cipher/sessions');

        if (!res.ok && !qdrantStats) {
          const error = await res.json();
          statsContainer.innerHTML = \`
            <div class="memory-error">
              <p><strong>Cipher Memory not available</strong></p>
              <p>\${error.message || 'Make sure cipher-memory container is running.'}</p>
            </div>
          \`;
          sessionsContainer.innerHTML = '';
          return;
        }

        if (res.ok) {
          const data = await res.json();
          memoryData = data;
          memorySessions = data.data?.sessions || data.sessions || [];
        }

        renderMemoryStats();
        renderMemorySessions();
      } catch (err) {
        // If Qdrant stats are available, show them even if Cipher API fails
        if (qdrantStats) {
          renderMemoryStats();
          renderMemorySessions();
        } else {
          statsContainer.innerHTML = \`
            <div class="memory-error">
              <p><strong>Error connecting to Cipher</strong></p>
              <p>\${err.message}</p>
            </div>
          \`;
          sessionsContainer.innerHTML = '';
        }
      }
    }

    function renderMemoryStats() {
      const container = document.getElementById('memory-stats-container');

      // Use Qdrant stats if available, otherwise fall back to session stats
      const stats = qdrantStats?.stats || {
        totalMemories: 0,
        decisions: 0,
        learnings: 0,
        patterns: 0,
        insights: 0,
      };

      const totalMemories = stats.totalMemories;
      const decisions = stats.decisions;
      const learnings = stats.learnings;

      container.innerHTML = \`
        <div class="memory-stats-grid">
          <div class="memory-stat">
            <div class="memory-stat-value" style="color: #22d3ee;">\${totalMemories}</div>
            <div class="memory-stat-label">Total Memories</div>
          </div>
          <div class="memory-stat">
            <div class="memory-stat-value" style="color: #a78bfa;">\${decisions}</div>
            <div class="memory-stat-label">Decisions</div>
          </div>
          <div class="memory-stat">
            <div class="memory-stat-value" style="color: #4ade80;">\${learnings}</div>
            <div class="memory-stat-label">Learnings</div>
          </div>
          <div class="memory-stat">
            <div class="memory-stat-value" style="color: #fbbf24;">\${stats.patterns + stats.insights}</div>
            <div class="memory-stat-label">Patterns & Insights</div>
          </div>
        </div>
        <div style="margin-top: 1rem; padding: 0.75rem 1rem; background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.2); border-radius: 8px; font-size: 0.85rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>
            <strong style="color: #a78bfa;">Qdrant Cloud Storage</strong>
          </div>
          <div style="opacity: 0.8;">Memories are stored in Qdrant Cloud with 20-day TTL. Pass <code style="background: rgba(139, 92, 246, 0.2); padding: 0.1rem 0.3rem; border-radius: 4px;">projectPath</code> to <code style="background: rgba(139, 92, 246, 0.2); padding: 0.1rem 0.3rem; border-radius: 4px;">ask_cipher</code> for cross-IDE persistence.</div>
        </div>
      \`;
    }

    function renderMemorySessions() {
      const container = document.getElementById('memory-sessions-container');
      const recentMemories = qdrantStats?.recentMemories || [];

      if (!recentMemories || recentMemories.length === 0) {
        container.innerHTML = \`
          <div class="memory-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M12 8v4l3 3"></path>
            </svg>
            <p>No memories stored yet</p>
            <p style="font-size: 0.85rem; margin-top: 0.5rem;">Start using Cipher to store decisions, learnings, and patterns.</p>
          </div>
        \`;
        return;
      }

      const memoriesHTML = recentMemories.map(memory => {
        const text = memory.text || 'Empty memory';
        const timestamp = memory.timestamp;
        const formattedDate = timestamp ? new Date(timestamp).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }) : 'Unknown';
        const tags = memory.tags || [];
        const projectPath = memory.projectPath;

        // Determine badge type based on content
        let badgeType = '';
        let badgeText = '';
        const textLower = text.toLowerCase();
        if (textLower.includes('decision') || textLower.includes('store decision')) { badgeType = 'decision'; badgeText = 'Decision'; }
        else if (textLower.includes('learning') || textLower.includes('learned') || textLower.includes('fix')) { badgeType = 'learning'; badgeText = 'Learning'; }
        else if (textLower.includes('pattern')) { badgeType = 'pattern'; badgeText = 'Pattern'; }
        else if (textLower.includes('insight')) { badgeType = 'insight'; badgeText = 'Insight'; }
        else if (textLower.startsWith('user:')) { badgeType = 'user'; badgeText = 'User'; }
        else if (textLower.startsWith('assistant:')) { badgeType = 'assistant'; badgeText = 'Assistant'; }
        else if (textLower.startsWith('tools used:')) { badgeType = 'tool'; badgeText = 'Tool'; }

        // Extract project name from path
        const projectName = projectPath ? projectPath.split('/').pop() : null;

        return \`
          <div class="memory-session-card" style="cursor: pointer;" onclick="viewMemoryDetail('\${memory.id}')">
            <div class="memory-session-header">
              <div class="memory-session-title" style="font-size: 0.9rem; line-height: 1.4;">\${escapeHtml(text)}</div>
            </div>
            <div class="memory-session-meta" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              \${badgeText ? \`<span class="memory-badge \${badgeType}">\${badgeText}</span>\` : ''}
              \${projectName ? \`<span style="background: rgba(34, 211, 238, 0.15); color: #22d3ee; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem;">\${escapeHtml(projectName)}</span>\` : ''}
              <span style="opacity: 0.6;">\${formattedDate}</span>
            </div>
          </div>
        \`;
      }).join('');

      container.innerHTML = \`
        <div style="margin-bottom: 0.75rem; font-size: 0.9rem; color: #94a3b8;">Recent Memories (from Qdrant Cloud)</div>
        <div class="memory-sessions-grid">\${memoriesHTML}</div>
      \`;
    }

    async function viewMemoryDetail(memoryId) {
      const panel = document.getElementById('memory-detail-panel');
      const titleEl = document.getElementById('memory-detail-title');
      const contentEl = document.getElementById('memory-detail-content');

      panel.classList.remove('hidden');
      panel.classList.add('active');
      titleEl.textContent = 'Memory Details';
      contentEl.innerHTML = '<div class="memory-loading">Loading memory...</div>';

      try {
        const res = await fetch(\`/dashboard/api/cipher/memory/\${encodeURIComponent(memoryId)}\`);

        if (!res.ok) {
          throw new Error('Failed to load memory');
        }

        const data = await res.json();
        const memory = data.memory;

        if (!memory) {
          throw new Error('Memory not found');
        }

        // Format timestamp
        const timestamp = memory.timestamp ? new Date(memory.timestamp).toLocaleString('en-US', {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }) : 'Unknown';

        // Determine badge type
        const textLower = (memory.text || '').toLowerCase();
        let badgeType = '';
        let badgeText = '';
        if (textLower.includes('decision') || textLower.includes('store decision')) { badgeType = 'decision'; badgeText = 'Decision'; }
        else if (textLower.includes('learning') || textLower.includes('learned') || textLower.includes('fix')) { badgeType = 'learning'; badgeText = 'Learning'; }
        else if (textLower.includes('pattern')) { badgeType = 'pattern'; badgeText = 'Pattern'; }
        else if (textLower.includes('insight')) { badgeType = 'insight'; badgeText = 'Insight'; }
        else if (textLower.startsWith('user:')) { badgeType = 'user'; badgeText = 'User Message'; }
        else if (textLower.startsWith('assistant:')) { badgeType = 'assistant'; badgeText = 'Assistant Response'; }
        else if (textLower.startsWith('tools used:')) { badgeType = 'tool'; badgeText = 'Tool Usage'; }

        // Extract project name
        const projectName = memory.projectPath ? memory.projectPath.split('/').pop() : null;

        contentEl.innerHTML = \`
          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              \${badgeText ? \`<span class="memory-badge \${badgeType}" style="font-size: 0.85rem;">\${badgeText}</span>\` : ''}
              \${projectName ? \`<span style="background: rgba(34, 211, 238, 0.15); color: #22d3ee; padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.8rem;">\${escapeHtml(projectName)}</span>\` : ''}
            </div>

            <div style="background: rgba(30, 41, 59, 0.5); padding: 1rem; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.1);">
              <div style="font-size: 0.75rem; color: #64748b; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em;">Content</div>
              <div style="font-size: 0.95rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word;">\${escapeHtml(memory.text || 'Empty memory')}</div>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem;">
              <div style="background: rgba(30, 41, 59, 0.3); padding: 0.75rem; border-radius: 6px;">
                <div style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Timestamp</div>
                <div style="font-size: 0.85rem; margin-top: 0.25rem;">\${timestamp}</div>
              </div>
              <div style="background: rgba(30, 41, 59, 0.3); padding: 0.75rem; border-radius: 6px;">
                <div style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Project Path</div>
                <div style="font-size: 0.85rem; margin-top: 0.25rem; word-break: break-all;">\${escapeHtml(memory.projectPath || 'Not specified')}</div>
              </div>
              <div style="background: rgba(30, 41, 59, 0.3); padding: 0.75rem; border-radius: 6px;">
                <div style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Memory ID</div>
                <div style="font-size: 0.75rem; margin-top: 0.25rem; font-family: monospace; word-break: break-all; opacity: 0.7;">\${escapeHtml(memoryId)}</div>
              </div>
            </div>

            \${memory.tags && memory.tags.length > 0 ? \`
              <div>
                <div style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">Tags</div>
                <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                  \${memory.tags.map(tag => \`<span style="background: rgba(139, 92, 246, 0.2); color: #a78bfa; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem;">\${escapeHtml(tag)}</span>\`).join('')}
                </div>
              </div>
            \` : ''}
          </div>
        \`;
      } catch (err) {
        contentEl.innerHTML = \`
          <div class="memory-error">
            <p><strong>Error loading memory</strong></p>
            <p>\${err.message}</p>
          </div>
        \`;
      }
    }

    async function viewMemorySession(sessionId) {
      const panel = document.getElementById('memory-detail-panel');
      const titleEl = document.getElementById('memory-detail-title');
      const contentEl = document.getElementById('memory-detail-content');

      panel.classList.remove('hidden');
      panel.classList.add('active');
      titleEl.textContent = 'Loading...';
      contentEl.innerHTML = '<div class="memory-loading">Loading session history...</div>';

      try {
        const res = await fetch(\`/dashboard/api/cipher/sessions/\${encodeURIComponent(sessionId)}/history\`);

        if (!res.ok) {
          throw new Error('Failed to load session history');
        }

        const data = await res.json();
        const history = data.data?.history || data.history || [];
        const session = memorySessions.find(s => s.id === sessionId);

        titleEl.textContent = session?.title || sessionId;

        if (history.length === 0) {
          contentEl.innerHTML = '<div class="memory-empty"><p>No messages in this session</p></div>';
          return;
        }

        const messagesHTML = history.map(msg => {
          const role = msg.role || 'unknown';
          const content = msg.content || '';
          const textContent = Array.isArray(content)
            ? content.map(c => c.text || c.content || JSON.stringify(c)).join('\\n')
            : (typeof content === 'string' ? content : JSON.stringify(content));

          return \`
            <div class="memory-message \${role}">
              <div class="memory-message-role">\${escapeHtml(role)}</div>
              <div class="memory-message-content">\${escapeHtml(textContent)}</div>
            </div>
          \`;
        }).join('');

        contentEl.innerHTML = messagesHTML;
      } catch (err) {
        contentEl.innerHTML = \`
          <div class="memory-error">
            <p><strong>Error loading session</strong></p>
            <p>\${err.message}</p>
          </div>
        \`;
      }
    }

    function closeMemoryDetail() {
      const panel = document.getElementById('memory-detail-panel');
      panel.classList.remove('active');
      setTimeout(() => panel.classList.add('hidden'), 300);
    }

    async function searchMemory() {
      const searchInput = document.getElementById('memory-search');
      const query = searchInput.value.trim();

      if (!query) {
        showToast('Please enter a search query', true);
        return;
      }

      const sessionsContainer = document.getElementById('memory-sessions-container');
      sessionsContainer.innerHTML = '<div class="memory-loading">Searching memory...</div>';

      try {
        const res = await fetch(\`/dashboard/api/cipher/search?q=\${encodeURIComponent(query)}\`);

        if (!res.ok) {
          throw new Error('Search failed');
        }

        const data = await res.json();
        const result = data.result || data.message || data;

        sessionsContainer.innerHTML = \`
          <div class="memory-search-results">
            <div class="section-title" style="margin-bottom: 1rem;">Search Results for "\${escapeHtml(query)}"</div>
            <div class="memory-search-result">
              <div class="memory-search-result-content">\${escapeHtml(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}</div>
            </div>
            <button class="btn btn-secondary" onclick="loadMemoryData()" style="margin-top: 1rem;">
              Back to Sessions
            </button>
          </div>
        \`;
      } catch (err) {
        sessionsContainer.innerHTML = \`
          <div class="memory-error">
            <p><strong>Search failed</strong></p>
            <p>\${err.message}</p>
          </div>
        \`;
      }
    }

    function refreshMemoryData() {
      memoryData = null;
      memorySessions = [];
      loadMemoryData();
    }

    // Handle Enter key for memory search
    document.getElementById('memory-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        searchMemory();
      }
    });

    // ==========================================
    // Skills Tab Functions
    // ==========================================
    let skillsData = [];
    let skillsCategories = [];
    let skillsTemplates = [];
    let selectedSkillCategory = null;
    let skillsSearchQuery = '';
    let skillsSourceFilter = 'all';

    async function loadSkillsData() {
      try {
        const [skillsRes, categoriesRes, templatesRes] = await Promise.all([
          fetch('/api/code/skills'),
          fetch('/api/code/skills/categories'),
          fetch('/api/code/skills/templates')
        ]);

        skillsData = (await skillsRes.json()).skills || [];
        const catData = await categoriesRes.json();
        skillsCategories = catData.categories || [];
        const templData = await templatesRes.json();
        skillsTemplates = templData.templates || [];

        renderSkillsStats();
        renderSkillsCategories();
        renderSkillsList();
        renderSkillsTemplates();
      } catch (err) {
        console.error('Failed to load skills data:', err);
        document.getElementById('skills-stats-container').innerHTML =
          '<div class="skills-empty">Failed to load skills. Make sure code execution is enabled.</div>';
      }
    }

    function renderSkillsStats() {
      const externalCount = skillsData.filter(s => s.source === 'external').length;
      const workspaceCount = skillsData.filter(s => s.source === 'workspace').length;
      const categoryCount = skillsCategories.filter(c => c.skillCount > 0).length;

      document.getElementById('skills-stats-container').innerHTML = \`
        <div class="skills-stat">
          <div class="skills-stat-value">\${skillsData.length}</div>
          <div class="skills-stat-label">Total Skills</div>
        </div>
        <div class="skills-stat">
          <div class="skills-stat-value">\${externalCount}</div>
          <div class="skills-stat-label">External</div>
        </div>
        <div class="skills-stat">
          <div class="skills-stat-value">\${workspaceCount}</div>
          <div class="skills-stat-label">Workspace</div>
        </div>
        <div class="skills-stat">
          <div class="skills-stat-value">\${categoryCount}</div>
          <div class="skills-stat-label">Categories</div>
        </div>
        <div class="skills-stat">
          <div class="skills-stat-value">\${skillsTemplates.length}</div>
          <div class="skills-stat-label">Templates</div>
        </div>
      \`;
    }

    function renderSkillsCategories() {
      const container = document.getElementById('skills-categories-container');
      const activeCategories = skillsCategories.filter(c => c.skillCount > 0);

      if (activeCategories.length === 0) {
        container.innerHTML = '';
        return;
      }

      container.innerHTML = \`
        <div class="skills-categories-grid">
          \${activeCategories.map(cat => \`
            <div class="skill-category-card \${selectedSkillCategory === cat.name ? 'selected' : ''}"
                 onclick="toggleSkillCategory('\${cat.name}')">
              <div class="skill-category-count">\${cat.skillCount}</div>
              <div class="skill-category-name">\${escapeHtml(cat.name.replace(/-/g, ' '))}</div>
              <div class="skill-category-desc">\${escapeHtml(cat.description)}</div>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    function toggleSkillCategory(category) {
      if (selectedSkillCategory === category) {
        selectedSkillCategory = null;
      } else {
        selectedSkillCategory = category;
      }
      renderSkillsCategories();
      renderSkillsList();
    }

    function filterSkills() {
      skillsSearchQuery = document.getElementById('skills-search').value.toLowerCase();
      skillsSourceFilter = document.getElementById('skills-source-filter').value;
      renderSkillsList();
    }

    function getFilteredSkills() {
      let filtered = [...skillsData];

      // Filter by search query
      if (skillsSearchQuery) {
        filtered = filtered.filter(skill =>
          skill.name.toLowerCase().includes(skillsSearchQuery) ||
          (skill.description && skill.description.toLowerCase().includes(skillsSearchQuery)) ||
          (skill.tags && skill.tags.some(t => t.toLowerCase().includes(skillsSearchQuery)))
        );
      }

      // Filter by category
      if (selectedSkillCategory) {
        filtered = filtered.filter(skill => skill.category === selectedSkillCategory);
      }

      // Filter by source
      if (skillsSourceFilter !== 'all') {
        filtered = filtered.filter(skill => skill.source === skillsSourceFilter);
      }

      return filtered;
    }

    function renderSkillsList() {
      const container = document.getElementById('skills-list-container');
      const filtered = getFilteredSkills();

      document.getElementById('skills-count-subtitle').textContent =
        \`Showing \${filtered.length} of \${skillsData.length} skills\`;

      if (filtered.length === 0) {
        container.innerHTML = '<div class="skills-empty">No skills found matching your criteria.</div>';
        return;
      }

      container.innerHTML = \`
        <div class="skills-list">
          \${filtered.map(skill => \`
            <div class="skill-card">
              <div class="skill-card-header">
                <div class="skill-name">\${escapeHtml(skill.name)}</div>
                <span class="skill-source-badge \${skill.source || 'workspace'}">\${skill.source || 'workspace'}</span>
              </div>
              <div class="skill-description">\${escapeHtml(skill.description || 'No description')}</div>
              <div class="skill-meta">
                \${skill.category ? \`<span class="skill-category-tag">\${escapeHtml(skill.category)}</span>\` : ''}
                \${(skill.tags || []).slice(0, 3).map(tag => \`<span class="skill-tag">\${escapeHtml(tag)}</span>\`).join('')}
              </div>
              <div class="skill-actions">
                <button class="skill-action-btn primary" onclick="executeSkill('\${escapeHtml(skill.name)}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                  Run
                </button>
                \${skill.source === 'external' ? \`
                  <button class="skill-action-btn" onclick="importSkill('\${escapeHtml(skill.name)}')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    Import
                  </button>
                \` : ''}
                <button class="skill-action-btn" onclick="viewSkillDetails('\${escapeHtml(skill.name)}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                  View
                </button>
              </div>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    function renderSkillsTemplates() {
      const container = document.getElementById('skills-templates-container');

      if (skillsTemplates.length === 0) {
        container.innerHTML = '<div class="skills-empty">No templates available.</div>';
        return;
      }

      container.innerHTML = \`
        <div class="skills-templates-grid">
          \${skillsTemplates.map(template => \`
            <div class="template-card" onclick="createFromTemplate('\${escapeHtml(template.name)}')">
              <div class="template-name">\${escapeHtml(template.name.replace(/-template$/, ''))}</div>
              <div class="template-desc">\${escapeHtml(template.description)}</div>
              <span class="template-category">\${escapeHtml(template.category)}</span>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    async function executeSkill(skillName) {
      try {
        showToast(\`Executing skill: \${skillName}...\`);
        const res = await fetch(\`/api/code/skills/\${encodeURIComponent(skillName)}/execute\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: {} })
        });
        const result = await res.json();
        if (result.success) {
          showToast(\`Skill executed successfully!\`, 'success');
          console.log('Skill result:', result);
        } else {
          showToast(\`Skill failed: \${result.error}\`, 'error');
        }
      } catch (err) {
        showToast(\`Failed to execute skill: \${err.message}\`, 'error');
      }
    }

    async function importSkill(skillName) {
      try {
        showToast(\`Importing skill: \${skillName}...\`);
        const res = await fetch(\`/api/code/skills/\${encodeURIComponent(skillName)}/import\`, {
          method: 'POST'
        });
        const result = await res.json();
        if (result.success) {
          showToast(\`Imported '\${skillName}' to workspace!\`, 'success');
          await loadSkillsData();
        } else {
          showToast(\`Import failed: \${result.error}\`, 'error');
        }
      } catch (err) {
        showToast(\`Failed to import skill: \${err.message}\`, 'error');
      }
    }

    async function syncExternalSkills() {
      try {
        showToast('Syncing external skills...');
        const res = await fetch('/api/code/skills/sync', { method: 'POST' });
        const result = await res.json();
        showToast(\`Synced! Imported: \${result.imported.length}, Failed: \${result.failed.length}\`, 'success');
        await loadSkillsData();
      } catch (err) {
        showToast(\`Sync failed: \${err.message}\`, 'error');
      }
    }

    function viewSkillDetails(skillName) {
      const skill = skillsData.find(s => s.name === skillName);
      if (!skill) return;

      alert(\`Skill: \${skill.name}\\n\\nDescription: \${skill.description}\\n\\nCategory: \${skill.category || 'N/A'}\\n\\nTags: \${(skill.tags || []).join(', ')}\\n\\nSource: \${skill.source}\\n\\nInputs: \${skill.inputs?.length || 0}\`);
    }

    async function createFromTemplate(templateName) {
      const skillName = prompt('Enter a name for the new skill:');
      if (!skillName) return;

      try {
        showToast(\`Creating skill from template...\`);
        const res = await fetch('/api/code/skills/from-template', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateName, skillName })
        });
        const result = await res.json();
        if (result.success) {
          showToast(\`Created skill '\${skillName}'!\`, 'success');
          await loadSkillsData();
        } else {
          showToast(\`Failed: \${result.error}\`, 'error');
        }
      } catch (err) {
        showToast(\`Failed to create skill: \${err.message}\`, 'error');
      }
    }

    function refreshSkillsData() {
      loadSkillsData();
      showToast('Skills refreshed!');
    }

    // Load skills when switching to skills tab
    const originalSwitchTab = switchTab;
    switchTab = function(tabId) {
      originalSwitchTab(tabId);
      if (tabId === 'skills' && skillsData.length === 0) {
        loadSkillsData();
      }
      if (tabId === 'settings') {
        loadGatewaySettings();
      }
    };

    // Gateway Settings Functions
    async function loadGatewaySettings() {
      try {
        const res = await fetch('/dashboard/api/gateway-settings');
        const data = await res.json();

        // Update toggle state
        const toggle = document.getElementById('lite-mode-toggle');
        if (toggle) {
          toggle.checked = data.effectiveLiteMode;
          toggle.disabled = data.liteModeSource === 'env';
        }

        // Update status display
        const statusEl = document.getElementById('lite-mode-status');
        if (statusEl) {
          if (data.effectiveLiteMode) {
            statusEl.textContent = 'Enabled';
            statusEl.className = 'info-value success';
          } else {
            statusEl.textContent = 'Disabled';
            statusEl.className = 'info-value';
          }
        }

        // Update source display
        const sourceEl = document.getElementById('lite-mode-source');
        if (sourceEl) {
          sourceEl.textContent = data.liteModeSource === 'env' ? 'Environment Variable' : 'Dashboard UI';
        }

        // Show/hide env override notice
        const envNotice = document.getElementById('env-override-notice');
        if (envNotice) {
          if (data.liteModeSource === 'env') {
            envNotice.classList.remove('hidden');
          } else {
            envNotice.classList.add('hidden');
          }
        }
      } catch (err) {
        console.error('Failed to load gateway settings:', err);
      }
    }

    async function toggleLiteMode(enabled) {
      try {
        const res = await fetch('/dashboard/api/gateway-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ liteMode: enabled })
        });
        const data = await res.json();

        if (data.success) {
          // Show restart notice
          const restartNotice = document.getElementById('restart-notice');
          if (restartNotice) {
            restartNotice.classList.add('show');
          }

          // Update status display
          const statusEl = document.getElementById('lite-mode-status');
          if (statusEl) {
            if (enabled) {
              statusEl.textContent = 'Enabled';
              statusEl.className = 'info-value success';
            } else {
              statusEl.textContent = 'Disabled';
              statusEl.className = 'info-value';
            }
          }

          showToast(data.message || 'Settings saved!');
        } else {
          showToast('Failed to save settings', 'error');
          // Revert toggle
          document.getElementById('lite-mode-toggle').checked = !enabled;
        }
      } catch (err) {
        console.error('Failed to toggle lite mode:', err);
        showToast('Failed to save settings', 'error');
        // Revert toggle
        document.getElementById('lite-mode-toggle').checked = !enabled;
      }
    }

    // Initial load - update header stats immediately
    loadData().then(() => {
      // Header stats are updated by loadData() -> updateStats()
      // This ensures header shows counts even if overview stats fail
    }).catch(err => {
      console.error('Failed to load initial data:', err);
      // Try to update header stats using stats API as fallback
      updateHeaderStatsFallback().catch(() => {
        console.error('All header stats update methods failed');
      });
    });
    
    // Overview data will be loaded after feature flags are loaded (see loadFeatureFlags above)
    checkAntigravityAvailable();

    // Refresh servers every 30 seconds
    setInterval(loadData, 30000);
  </script>
</body>
</html>`;
}
