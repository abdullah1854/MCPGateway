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
import { generateTopology } from '../services/topology.js';
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
import { getDashboardHTML, getPlaygroundHTML } from './render.js';

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

type HelperAgentId = 'kimi' | 'minimax' | 'zai' | 'codex';

interface HelperAgentDefinition {
  id: HelperAgentId;
  displayName: string;
  specialization: string;
  primaryTaskTypes: string[];
  fallbackTaskTypes: string[];
  defaultModels: string[];
}

const HELPER_ROUTER_BACKEND_ID = 'multi-model-router';
const HELPER_ROUTER_REQUIRED_TOOL_SUFFIXES = ['list_models', 'call_model', 'route_task'];

const HELPER_AGENT_DEFINITIONS: HelperAgentDefinition[] = [
  {
    id: 'kimi',
    displayName: 'Kimi K2.5',
    specialization: 'Coding assistant for delegated implementation tasks and pair programming',
    primaryTaskTypes: ['coding', 'implementation', 'file-editing'],
    fallbackTaskTypes: ['general', 'debugging'],
    defaultModels: ['kimi-k2-0905-preview'],
  },
  {
    id: 'minimax',
    displayName: 'Minimax M2.5',
    specialization: 'Coding assistant for delegated implementation tasks and fast prototyping',
    primaryTaskTypes: ['coding', 'implementation', 'file-editing'],
    fallbackTaskTypes: ['general', 'fast'],
    defaultModels: ['MiniMax-M2.5'],
  },
  {
    id: 'zai',
    displayName: 'Z.AI (GLM 4.7)',
    specialization: 'Content writing, documentation, copywriting, and creative text generation',
    primaryTaskTypes: ['content-writing', 'documentation', 'creative', 'copywriting'],
    fallbackTaskTypes: ['translation', 'summarization'],
    defaultModels: ['glm-4.7'],
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    specialization: 'Code review, planning, auditing, and architectural oversight',
    primaryTaskTypes: ['code-review', 'planning', 'auditing', 'architecture'],
    fallbackTaskTypes: ['analysis', 'general'],
    defaultModels: ['codex-cli'],
  },
];

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

  // API: Helper agents routing and availability
  router.get('/api/helper-agents', (_req: Request, res: Response) => {
    const backends = backendManager.getBackends();
    const status = backendManager.getStatus();
    const disabledBackends = backendManager.getDisabledBackends();

    const routerBackend = backends.get(HELPER_ROUTER_BACKEND_ID);
    const routerStatus = status[HELPER_ROUTER_BACKEND_ID];
    const routerEnabled = routerBackend ? !disabledBackends.has(HELPER_ROUTER_BACKEND_ID) : false;
    const routerConnectionState = routerStatus?.status ?? 'not-configured';
    const routerTools = routerBackend?.tools?.map(tool => tool.name) ?? [];
    const normalizedPrefix = (routerBackend?.config.toolPrefix ?? 'multi').replace(/_+$/g, '');
    const requiredTools = HELPER_ROUTER_REQUIRED_TOOL_SUFFIXES.map(
      suffix => `${normalizedPrefix}_${suffix}`,
    );
    const missingTools = HELPER_ROUTER_REQUIRED_TOOL_SUFFIXES
      .filter(suffix => !routerTools.some(toolName => toolName.endsWith(`_${suffix}`)))
      .map(suffix => `${normalizedPrefix}_${suffix}`);

    const routerAvailability = !routerBackend
      ? 'not-configured'
      : !routerEnabled
        ? 'disabled'
        : routerConnectionState === 'connected'
          ? 'connected'
          : 'disconnected';

    const agents = HELPER_AGENT_DEFINITIONS.map(agent => ({
      ...agent,
      availability: routerAvailability === 'connected' ? 'available' : 'unavailable',
      routeMethod:
        agent.id === 'codex'
          ? 'multi_route_task(taskType="file-editing")'
          : 'multi_route_task(taskType=...)',
    }));

    res.json({
      router: {
        id: HELPER_ROUTER_BACKEND_ID,
        availability: routerAvailability,
        status: routerConnectionState,
        enabled: routerEnabled,
        toolPrefix: `${normalizedPrefix}_`,
        requiredTools,
        availableTools: routerTools,
        missingTools,
        error: routerStatus?.error ?? null,
      },
      agents,
      generatedAt: new Date().toISOString(),
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

  // ==============================================
  // Topology API Routes (live system map)
  // ==============================================

  router.get('/api/topology', (_req: Request, res: Response) => {
    res.json(generateTopology(backendManager));
  });

  router.get('/api/topology/mermaid', (_req: Request, res: Response) => {
    const topology = generateTopology(backendManager);
    res.setHeader('Content-Type', 'text/plain');
    res.send(topology.mermaid);
  });

  // ==============================================
  // Playground Route (interactive tool testing)
  // ==============================================

  router.get('/playground', (_req: Request, res: Response) => {
    res.send(getPlaygroundHTML());
  });

  return router;
}
