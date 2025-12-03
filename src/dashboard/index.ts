/**
 * Dashboard Routes - Web UI for managing MCP Gateway
 */

import { Router, Request, Response } from 'express';
import { BackendManager } from '../backend/index.js';
import ConfigManager from '../config.js';
import { ServerConfigSchema, ServerConfig } from '../types.js';
import { logger } from '../logger.js';

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
      // Check if tool's backend is disabled
      const backendId = findBackendIdForTool(tool.name, backendManager);
      const backendDisabled = backendId ? disabledBackends.has(backendId) : false;
      
      return {
        ...tool,
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
  <style>
    :root {
      --bg-primary: #08080c;
      --bg-secondary: rgba(16, 16, 24, 0.8);
      --bg-tertiary: rgba(24, 24, 36, 0.9);
      --bg-card: rgba(20, 20, 32, 0.6);
      --bg-glass: rgba(255, 255, 255, 0.02);
      --accent: #7c3aed;
      --accent-secondary: #06b6d4;
      --accent-glow: rgba(124, 58, 237, 0.4);
      --accent-hover: #8b5cf6;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.3);
      --warning: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.3);
      --error: #ef4444;
      --error-glow: rgba(239, 68, 68, 0.3);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --border: rgba(148, 163, 184, 0.1);
      --border-hover: rgba(148, 163, 184, 0.2);
      --gradient-1: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%);
      --gradient-2: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
      --gradient-3: linear-gradient(180deg, rgba(124, 58, 237, 0.1) 0%, transparent 100%);
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
      margin-bottom: 2.5rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      position: relative;
    }

    header::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      width: 120px;
      height: 2px;
      background: var(--gradient-1);
      border-radius: 2px;
    }

    .logo-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: var(--gradient-1);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      box-shadow: 0 8px 32px var(--accent-glow);
    }
    
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: var(--gradient-1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    h1 span {
      font-weight: 400;
      opacity: 0.7;
    }
    
    .stats {
      display: flex;
      gap: 1rem;
    }
    
    .stat {
      background: var(--bg-glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 1rem 1.75rem;
      border-radius: 16px;
      border: 1px solid var(--border);
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .stat:hover {
      border-color: var(--border-hover);
      transform: translateY(-2px);
    }

    .stat::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
    }
    
    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      background: var(--gradient-1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      line-height: 1.2;
    }
    
    .stat-label {
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 500;
      margin-top: 0.25rem;
    }
    
    .controls {
      display: flex;
      gap: 1rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
      align-items: center;
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
      padding: 0.75rem 1.5rem;
      border: none;
      border-radius: 12px;
      font-size: 0.875rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      position: relative;
      overflow: hidden;
    }
    
    .btn-primary {
      background: var(--gradient-1);
      color: white;
      box-shadow: 0 4px 16px var(--accent-glow);
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px var(--accent-glow);
    }
    
    .btn-secondary {
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    
    .btn-secondary:hover {
      background: var(--bg-tertiary);
      border-color: var(--border-hover);
    }
    
    .backend-card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 20px;
      margin-bottom: 1rem;
      overflow: hidden;
      transition: all 0.3s ease;
      position: relative;
    }

    .backend-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
    }

    .backend-card:hover {
      border-color: var(--border-hover);
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.2);
    }
    
    .backend-card.backend-disabled {
      opacity: 0.5;
    }
    
    .backend-card.backend-disabled .backend-name {
      color: var(--text-muted);
    }
    
    .disabled-badge {
      background: linear-gradient(135deg, var(--error), #dc2626);
      color: white;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      font-size: 0.65rem;
      font-weight: 600;
      margin-left: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      box-shadow: 0 2px 8px var(--error-glow);
    }

    .disconnected-badge {
      background: linear-gradient(135deg, var(--warning), #d97706);
      color: white;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      font-size: 0.65rem;
      font-weight: 600;
      margin-left: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      box-shadow: 0 2px 8px var(--warning-glow);
    }

    .no-tools-badge {
      background: var(--text-muted);
      color: white;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      font-size: 0.65rem;
      font-weight: 600;
      margin-left: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .backend-card.backend-disconnected {
      opacity: 0.75;
      border-color: var(--warning);
    }

    .backend-card.backend-no-tools {
      opacity: 0.6;
    }

    .backend-disabled-tool {
      opacity: 0.5;
    }
    
    .backend-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.25rem 1.5rem;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    
    .backend-header:hover {
      background: rgba(255, 255, 255, 0.02);
    }
    
    .backend-info {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    
    .backend-status {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      position: relative;
    }

    .backend-status::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      opacity: 0.3;
    }
    
    .backend-status.connected {
      background: var(--success);
      box-shadow: 0 0 12px var(--success-glow), 0 0 24px var(--success-glow);
    }

    .backend-status.connected::after {
      background: var(--success);
      animation: pulse 2s ease-in-out infinite;
    }
    
    .backend-status.error {
      background: var(--error);
      box-shadow: 0 0 12px var(--error-glow);
    }
    
    .backend-status.disconnected {
      background: var(--text-muted);
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.3; transform: scale(1); }
      50% { opacity: 0.1; transform: scale(1.5); }
    }
    
    .backend-name {
      font-weight: 600;
      font-size: 1.05rem;
      letter-spacing: -0.01em;
    }
    
    .backend-meta {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .backend-error {
      color: var(--error);
      font-size: 0.75rem;
      margin-top: 0.35rem;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .backend-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    
    .toggle {
      position: relative;
      width: 52px;
      height: 28px;
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
      border-radius: 28px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      border: 1px solid var(--border);
    }
    
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 22px;
      width: 22px;
      left: 2px;
      bottom: 2px;
      background: var(--text-muted);
      border-radius: 50%;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .toggle input:checked + .toggle-slider {
      background: var(--accent);
      border-color: var(--accent);
      box-shadow: 0 0 16px var(--accent-glow);
    }
    
    .toggle input:checked + .toggle-slider:before {
      transform: translateX(24px);
      background: white;
    }
    
    .tools-list {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      background: rgba(0, 0, 0, 0.2);
    }
    
    .tools-list.expanded {
      max-height: 3000px;
    }
    
    .tool-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border);
      transition: background 0.2s ease;
    }
    
    .tool-item:hover {
      background: rgba(255, 255, 255, 0.02);
    }
    
    .tool-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--accent-secondary);
      padding: 0.25rem 0.5rem;
      background: rgba(6, 182, 212, 0.1);
      border-radius: 6px;
      border: 1px solid rgba(6, 182, 212, 0.2);
    }
    
    .tool-name.disabled {
      color: var(--text-muted);
      background: rgba(100, 116, 139, 0.1);
      border-color: rgba(100, 116, 139, 0.2);
      text-decoration: line-through;
    }
    
    .tool-desc {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 0.5rem;
      max-width: 600px;
      line-height: 1.5;
    }
    
    .expand-icon {
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      color: var(--text-muted);
    }
    
    .expanded .expand-icon {
      transform: rotate(180deg);
    }
    
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: var(--bg-secondary);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      padding: 1rem 1.75rem;
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      transform: translateY(120px);
      opacity: 0;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      font-weight: 500;
      z-index: 9999;
    }
    
    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }
    
    .filter-pills {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    
    .pill {
      padding: 0.5rem 1rem;
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid var(--border);
      border-radius: 24px;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .pill:hover, .pill.active {
      background: var(--accent);
      border-color: var(--accent);
      box-shadow: 0 4px 16px var(--accent-glow);
    }

    .pill.disconnected {
      border-color: var(--warning);
      opacity: 0.7;
    }

    .pill.disabled {
      border-color: var(--error);
      opacity: 0.5;
    }

    .pill.no-tools {
      border-color: var(--text-muted);
      opacity: 0.4;
    }

    .loading {
      text-align: center;
      padding: 4rem;
      color: var(--text-secondary);
      font-size: 1rem;
    }
    
    .loading::after {
      content: "";
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-left: 0.75rem;
      vertical-align: middle;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .quick-actions {
      display: flex;
      gap: 0.5rem;
      margin-left: auto;
    }
    
    .badge {
      background: var(--gradient-1);
      color: white;
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.7rem;
      font-weight: 700;
    }

    .btn-restart {
      background: linear-gradient(135deg, var(--warning), #d97706);
      color: white;
      font-weight: 600;
      box-shadow: 0 4px 16px var(--warning-glow);
    }

    .btn-restart:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px var(--warning-glow);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .btn-success {
      background: linear-gradient(135deg, var(--success), #059669);
      color: white;
      font-weight: 600;
      box-shadow: 0 4px 16px var(--success-glow);
    }

    .btn-success:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px var(--success-glow);
    }

    .btn-danger {
      background: linear-gradient(135deg, var(--error), #dc2626);
      color: white;
      box-shadow: 0 4px 12px var(--error-glow);
    }

    .btn-danger:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px var(--error-glow);
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
      background: var(--bg-secondary);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border: 1px solid var(--border);
      border-radius: 24px;
      width: 90%;
      max-width: 640px;
      max-height: 90vh;
      overflow-y: auto;
      transform: translateY(-20px) scale(0.95);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
    }

    .modal-overlay.show .modal {
      transform: translateY(0) scale(1);
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--border);
      position: relative;
    }

    .modal-header::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 2rem;
      width: 60px;
      height: 2px;
      background: var(--gradient-1);
      border-radius: 2px;
    }

    .modal-header h2 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .modal-close {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      width: 36px;
      height: 36px;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }

    .modal-close:hover {
      color: var(--text-primary);
      border-color: var(--border-hover);
      background: var(--bg-glass);
    }

    .modal-body {
      padding: 2rem;
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
      margin-bottom: 1.5rem;
    }

    .form-group label {
      display: block;
      margin-bottom: 0.6rem;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-secondary);
      letter-spacing: 0.01em;
    }

    .form-group input,
    .form-group select,
    .form-group textarea {
      width: 100%;
      padding: 0.875rem 1.125rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text-primary);
      font-size: 0.9rem;
      font-family: inherit;
      transition: all 0.2s ease;
    }

    .form-group input:focus,
    .form-group select:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-glow);
    }

    .form-group input::placeholder,
    .form-group textarea::placeholder {
      color: var(--text-muted);
    }

    .form-group select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 1rem center;
      background-size: 16px;
      padding-right: 2.5rem;
    }

    .form-group textarea {
      resize: vertical;
      min-height: 100px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      line-height: 1.6;
    }

    .form-group small {
      display: block;
      margin-top: 0.5rem;
      font-size: 0.75rem;
      color: var(--text-muted);
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
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-section">
        <div class="logo-icon">⚡</div>
        <div>
          <h1>MCP Gateway</h1>
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
    
    <div id="backends-container">
      <div class="loading">Loading backends</div>
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
      const enabledTools = tools.filter(t => t.enabled);
      document.getElementById('enabled-count').textContent = enabledTools.length;
      document.getElementById('total-count').textContent = tools.length;
      document.getElementById('backends-count').textContent = 
        backends.filter(b => b.status === 'connected').length + '/' + backends.length;
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
      const prefix = getBackendPrefix(backendId);
      return tools.filter(t => t.name.startsWith(prefix + '_') || 
        (prefix === '' && !t.name.includes('_'))).length;
    }
    
    function getBackendPrefix(backendId) {
      // Get prefix dynamically from backend data
      const backend = backends.find(b => b.id === backendId);
      return backend?.toolPrefix || backendId;
    }
    
    function filterByBackend(id) {
      selectedBackend = selectedBackend === id ? null : id;
      renderFilters();
      renderBackends();
    }
    
    function getToolsForBackend(backendId) {
      const prefix = getBackendPrefix(backendId);
      // Include all tools for this backend, regardless of backend enabled status
      return tools.filter(t => {
        const matchesBackend = t.name.startsWith(prefix + '_');
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
            // Find the backend ID from tool prefix dynamically
            for (const backend of backends) {
              const prefix = backend.toolPrefix + '_';
              if (name.startsWith(prefix)) {
                // Enable the backend first
                await fetch('/dashboard/api/backends/' + encodeURIComponent(backend.id) + '/toggle', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled: true })
                });
                backend.enabled = true;
                // Clear backendDisabled flag for all tools of this backend
                tools.forEach(t => {
                  if (t.name.startsWith(prefix)) {
                    t.backendDisabled = false;
                  }
                });
                break;
              }
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
        const prefix = getBackendPrefix(id);
        const backendTools = tools.filter(t => t.name.startsWith(prefix + '_')).map(t => t.name);
        
        if (backendTools.length > 0) {
          await fetch('/dashboard/api/tools/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tools: backendTools, enabled })
          });
        }
        
        tools.forEach(t => {
          if (t.name.startsWith(prefix + '_')) {
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
      const prefix = getBackendPrefix(backendId);
      const backendTools = tools.filter(t => t.name.startsWith(prefix + '_')).map(t => t.name);

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

    // Initial load
    loadData();

    // Refresh every 30 seconds
    setInterval(loadData, 30000);
  </script>
</body>
</html>`;
}

