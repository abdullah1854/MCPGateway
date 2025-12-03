/**
 * Dashboard Routes - Web UI for managing MCP Gateway
 */

import { Router, Request, Response } from 'express';
import { BackendManager } from '../backend/index.js';
import ConfigManager from '../config.js';
import { ServerConfigSchema, ServerConfig } from '../types.js';

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
  router.post('/api/restart', (_req: Request, res: Response) => {
    res.json({ success: true, message: 'Server restarting...' });

    // Give time for the response to be sent, then exit
    // The process manager (pm2, systemd, etc.) or npm script should restart it
    setTimeout(() => {
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
  <style>
    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
      --bg-tertiary: #1a1a25;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --success: #22c55e;
      --warning: #f59e0b;
      --error: #ef4444;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --border: #2a2a3a;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    
    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      background: linear-gradient(135deg, var(--accent), #a855f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    
    .stats {
      display: flex;
      gap: 1.5rem;
    }
    
    .stat {
      background: var(--bg-secondary);
      padding: 1rem 1.5rem;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--accent);
    }
    
    .stat-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .controls {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    
    .search-box {
      flex: 1;
      min-width: 250px;
      position: relative;
    }
    
    .search-box input {
      width: 100%;
      padding: 0.75rem 1rem 0.75rem 2.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 0.9rem;
      transition: border-color 0.2s;
    }
    
    .search-box input:focus {
      outline: none;
      border-color: var(--accent);
    }
    
    .search-box::before {
      content: "🔍";
      position: absolute;
      left: 1rem;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.9rem;
    }
    
    .btn {
      padding: 0.75rem 1.25rem;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    
    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    
    .btn-secondary:hover {
      background: var(--bg-secondary);
    }
    
    .tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    }
    
    .tab {
      padding: 0.5rem 1rem;
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.9rem;
      border-radius: 6px;
      transition: all 0.2s;
    }
    
    .tab:hover {
      color: var(--text-primary);
      background: var(--bg-tertiary);
    }
    
    .tab.active {
      color: var(--accent);
      background: var(--bg-tertiary);
    }
    
    .section {
      display: none;
    }
    
    .section.active {
      display: block;
    }
    
    .backend-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 1rem;
      overflow: hidden;
    }
    
    .backend-card.backend-disabled {
      opacity: 0.7;
      border-color: var(--text-secondary);
    }
    
    .backend-card.backend-disabled .backend-name {
      color: var(--text-secondary);
    }
    
    .disabled-badge {
      background: var(--error);
      color: white;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.6rem;
      margin-left: 0.5rem;
      vertical-align: middle;
    }
    
    .backend-disabled-tool {
      opacity: 0.6;
    }
    
    .backend-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.25rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .backend-header:hover {
      background: var(--bg-tertiary);
    }
    
    .backend-info {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    
    .backend-status {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    
    .backend-status.connected {
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }
    
    .backend-status.error {
      background: var(--error);
      box-shadow: 0 0 8px var(--error);
    }
    
    .backend-status.disconnected {
      background: var(--text-secondary);
    }
    
    .backend-name {
      font-weight: 600;
    }
    
    .backend-meta {
      font-size: 0.8rem;
      color: var(--text-secondary);
    }
    
    .backend-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
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
      transition: 0.3s;
      border: 1px solid var(--border);
    }
    
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 2px;
      bottom: 2px;
      background: var(--text-secondary);
      border-radius: 50%;
      transition: 0.3s;
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
      transition: max-height 0.3s ease-out;
      background: var(--bg-primary);
    }
    
    .tools-list.expanded {
      max-height: 2000px;
    }
    
    .tool-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.25rem;
      border-top: 1px solid var(--border);
    }
    
    .tool-item:hover {
      background: var(--bg-tertiary);
    }
    
    .tool-name {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 0.85rem;
      color: var(--success);
    }
    
    .tool-name.disabled {
      color: var(--text-secondary);
      text-decoration: line-through;
    }
    
    .tool-desc {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
      max-width: 600px;
    }
    
    .expand-icon {
      transition: transform 0.2s;
    }
    
    .expanded .expand-icon {
      transform: rotate(180deg);
    }
    
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      padding: 1rem 1.5rem;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s;
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
      padding: 0.4rem 0.8rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 20px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .pill:hover, .pill.active {
      background: var(--accent);
      border-color: var(--accent);
    }
    
    .loading {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
    
    .loading::after {
      content: "";
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-left: 0.5rem;
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
      background: var(--accent);
      color: white;
      padding: 0.2rem 0.5rem;
      border-radius: 10px;
      font-size: 0.7rem;
      font-weight: 600;
    }

    .btn-restart {
      background: var(--warning);
      color: #000;
      font-weight: 600;
    }

    .btn-restart:hover {
      background: #e6a000;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .btn-success {
      background: var(--success);
      color: #000;
      font-weight: 600;
    }

    .btn-success:hover {
      background: #1eb854;
    }

    .btn-danger {
      background: var(--error);
      color: white;
    }

    .btn-danger:hover {
      background: #dc2626;
    }

    .btn-small {
      padding: 0.4rem 0.75rem;
      font-size: 0.75rem;
    }

    /* Modal styles */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 1000;
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s;
    }

    .modal-overlay.show {
      opacity: 1;
      visibility: visible;
    }

    .modal {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 16px;
      width: 90%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
      transform: translateY(-20px);
      transition: transform 0.3s;
    }

    .modal-overlay.show .modal {
      transform: translateY(0);
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .modal-header h2 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .modal-close {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0.25rem;
      line-height: 1;
    }

    .modal-close:hover {
      color: var(--text-primary);
    }

    .modal-body {
      padding: 1.5rem;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border);
    }

    .form-group {
      margin-bottom: 1.25rem;
    }

    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .form-group input,
    .form-group select,
    .form-group textarea {
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 0.9rem;
      font-family: inherit;
    }

    .form-group input:focus,
    .form-group select:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: var(--accent);
    }

    .form-group textarea {
      resize: vertical;
      min-height: 80px;
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
    }

    .form-group small {
      display: block;
      margin-top: 0.25rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    .transport-fields {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-top: 0.5rem;
    }

    .test-result {
      margin-top: 1rem;
      padding: 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
    }

    .test-result.success {
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid var(--success);
      color: var(--success);
    }

    .test-result.error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid var(--error);
      color: var(--error);
    }

    .test-result.loading {
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid var(--accent);
      color: var(--accent);
    }

    .backend-buttons {
      display: flex;
      gap: 0.5rem;
    }

    .confirm-dialog {
      text-align: center;
      padding: 1rem;
    }

    .confirm-dialog p {
      margin-bottom: 1.5rem;
      color: var(--text-secondary);
    }

    .confirm-dialog strong {
      color: var(--error);
    }

    /* Checkbox styling */
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .checkbox-group:hover {
      border-color: var(--accent);
    }

    .checkbox-group input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--accent);
      cursor: pointer;
    }

    .checkbox-group span {
      font-size: 0.9rem;
      color: var(--text-primary);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>MCP Gateway</h1>
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
        <button class="btn btn-success" onclick="openAddServerModal()">+ Add Server</button>
        <button class="btn btn-restart" onclick="restartServer()">Restart Server</button>
      </div>
    </header>
    
    <div class="controls">
      <div class="search-box">
        <input type="text" id="search" placeholder="Search tools..." />
      </div>
      <div class="filter-pills" id="backend-filters"></div>
      <div class="quick-actions">
        <button class="btn btn-secondary" onclick="enableAll()">Enable All</button>
        <button class="btn btn-secondary" onclick="disableAll()">Disable All</button>
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
        <button class="modal-close" onclick="closeServerModal()">&times;</button>
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
            <input type="text" id="server-description" placeholder="What this server does">
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
        <button class="btn btn-secondary" onclick="testServerConnection()">Test Connection</button>
        <button class="btn btn-primary" onclick="saveServer()">Save Server</button>
      </div>
    </div>
  </div>

  <!-- Delete Confirmation Modal -->
  <div class="modal-overlay" id="delete-modal">
    <div class="modal" style="max-width: 400px;">
      <div class="modal-header">
        <h2>Delete Server</h2>
        <button class="modal-close" onclick="closeDeleteModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="confirm-dialog">
          <p>Are you sure you want to delete <strong id="delete-server-name"></strong>?</p>
          <p>This will disconnect the server and remove it from the configuration. This action cannot be undone.</p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeDeleteModal()">Cancel</button>
        <button class="btn btn-danger" onclick="confirmDeleteServer()">Delete Server</button>
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
      container.innerHTML = backends.map(b => \`
        <span class="pill \${selectedBackend === b.id ? 'active' : ''}" 
              onclick="filterByBackend('\${b.id}')">
          \${b.id} <span class="badge">\${getBackendToolCount(b.id)}</span>
        </span>
      \`).join('');
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
      
      container.innerHTML = filteredBackends.map(backend => {
        const backendTools = getToolsForBackend(backend.id);
        const enabledCount = backendTools.filter(t => t.enabled && !t.backendDisabled).length;
        const isExpanded = expandedBackends.has(backend.id);
        const isBackendDisabled = !backend.enabled;
        
        return \`
          <div class="backend-card \${isExpanded ? 'expanded' : ''} \${isBackendDisabled ? 'backend-disabled' : ''}" id="backend-\${backend.id}">
            <div class="backend-header" onclick="toggleExpand('\${backend.id}')">
              <div class="backend-info">
                <div class="backend-status \${backend.status}"></div>
                <div>
                  <div class="backend-name">\${backend.id} \${isBackendDisabled ? '<span class="disabled-badge">DISABLED</span>' : ''}</div>
                  <div class="backend-meta">
                    \${enabledCount}/\${backendTools.length} tools enabled • \${backend.status}
                  </div>
                </div>
              </div>
              <div class="backend-actions">
                <div class="backend-buttons">
                  <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); toggleAllBackendTools('\${backend.id}', true)">
                    Enable All
                  </button>
                  <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); toggleAllBackendTools('\${backend.id}', false)">
                    Disable All
                  </button>
                  <button class="btn btn-secondary btn-small" onclick="event.stopPropagation(); openEditServerModal('\${backend.id}')">
                    Edit
                  </button>
                  <button class="btn btn-danger btn-small" onclick="event.stopPropagation(); openDeleteModal('\${backend.id}')">
                    Delete
                  </button>
                </div>
                <label class="toggle" onclick="event.stopPropagation()">
                  <input type="checkbox" \${backend.enabled ? 'checked' : ''}
                         onchange="toggleBackend('\${backend.id}', this.checked)">
                  <span class="toggle-slider"></span>
                </label>
                <span class="expand-icon">▼</span>
              </div>
            </div>
            <div class="tools-list \${isExpanded ? 'expanded' : ''}" id="tools-\${backend.id}">
              \${backendTools.map(tool => \`
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
      toast.textContent = message;
      toast.style.borderColor = isError ? 'var(--error)' : 'var(--success)';
      toast.classList.add('show');

      setTimeout(() => {
        toast.classList.remove('show');
      }, 2000);
    }

    async function restartServer() {
      if (!confirm('Are you sure you want to restart the MCP Gateway server?')) {
        return;
      }

      try {
        showToast('Restarting server...');
        await fetch('/dashboard/api/restart', { method: 'POST' });

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

