/**
 * Dashboard Routes - Web UI for managing MCP Gateway
 */

import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { ZodError } from 'zod';
import { BackendManager } from '../backend/index.js';
import ConfigManager from '../config.js';
import { ServerConfigSchema, ServerConfig } from '../types.js';
import { logger } from '../logger.js';
import { generateTopology } from '../services/topology.js';
import {
  getChronicleMemory,
  listChronicleMemories,
} from '../services/chronicle-memory.js';
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

type ApiValidationError = {
  error: string;
  message: string;
  fieldErrors: Record<string, string[]>;
  details: Array<{
    field: string;
    message: string;
    code: string;
  }>;
};

function formatServerConfigValidationError(
  error: ZodError<ServerConfig>,
  options: {
    error?: string;
    pathPrefix?: string;
  } = {}
): ApiValidationError {
  const fieldErrors: Record<string, string[]> = {};
  const details = error.issues.map(issue => {
    const fieldPath = issue.path.length > 0 ? issue.path.join('.') : 'server';
    const field = options.pathPrefix ? `${options.pathPrefix}.${fieldPath}` : fieldPath;

    fieldErrors[field] ??= [];
    fieldErrors[field].push(issue.message);

    return {
      field,
      message: issue.message,
      code: issue.code,
    };
  });

  const fieldCount = Object.keys(fieldErrors).length;
  const firstDetail = details[0];
  const message =
    fieldCount === 1 && firstDetail
      ? `Please fix ${firstDetail.field}: ${firstDetail.message}.`
      : `Please fix ${fieldCount} fields in the server configuration.`;

  return {
    error: options.error ?? 'Invalid server configuration',
    message,
    fieldErrors,
    details,
  };
}

export function createDashboardRoutes(backendManager: BackendManager): Router {
  const router = Router();
  const configManager = ConfigManager.getInstance();

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
    const features = configManager.getFeatureFlags();
    res.json({
      features: {
        skills: features.skills,
        chronicle: true,
      },
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

  // API: Chronicle daily memory summaries
  router.get('/api/chronicle/daily', async (req: Request, res: Response) => {
    try {
      const date = typeof req.query.date === 'string' ? req.query.date : undefined;
      res.json(await listChronicleMemories(date));
    } catch (error) {
      res.status(503).json({
        error: 'Chronicle memories not available',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/api/chronicle/memory/:id', async (req: Request, res: Response) => {
    try {
      res.json(await getChronicleMemory(req.params.id));
    } catch (error) {
      res.status(404).json({
        error: 'Chronicle memory not found',
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
        res.status(400).json(formatServerConfigValidationError(parseResult.error));
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
        res.status(400).json(formatServerConfigValidationError(parseResult.error));
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
        res.status(400).json(formatServerConfigValidationError(parseResult.error));
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
      const errors: Array<{ index: number } & ApiValidationError> = [];

      for (let i = 0; i < servers.length; i++) {
        const parseResult = ServerConfigSchema.safeParse(servers[i]);
        if (parseResult.success) {
          validatedServers.push(parseResult.data);
        } else {
          errors.push({
            index: i,
            ...formatServerConfigValidationError(parseResult.error, {
              pathPrefix: `servers.${i}`,
            }),
          });
        }
      }

      if (errors.length > 0 && !merge) {
        const fieldErrors = errors.reduce<Record<string, string[]>>((acc, item) => {
          for (const [field, messages] of Object.entries(item.fieldErrors)) {
            acc[field] = [...(acc[field] ?? []), ...messages];
          }
          return acc;
        }, {});

        res.status(400).json({
          error: 'Invalid server configurations',
          message: `Please fix ${errors.length} invalid server configuration${errors.length === 1 ? '' : 's'} before importing.`,
          fieldErrors,
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
        message: errors.length > 0
          ? `Imported valid servers and skipped ${errors.length} invalid server configuration${errors.length === 1 ? '' : 's'}.`
          : undefined,
        fieldErrors: errors.length > 0
          ? errors.reduce<Record<string, string[]>>((acc, item) => {
              for (const [field, messages] of Object.entries(item.fieldErrors)) {
                acc[field] = [...(acc[field] ?? []), ...messages];
              }
              return acc;
            }, {})
          : undefined,
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
