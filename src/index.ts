/**
 * MCP Gateway - Entry Point
 * 
 * Universal MCP Gateway that works with:
 * - Claude Desktop / Claude Code
 * - Cursor
 * - OpenAI Codex
 * - VS Code Copilot
 */

import 'dotenv/config';
import { MCPGatewayServer } from './server.js';
import ConfigManager from './config.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  logger.info('Starting MCP Gateway...');

  // Load configuration
  const configManager = ConfigManager.getInstance();
  const gatewayConfig = configManager.getGatewayConfig();
  const serversConfig = configManager.getServersConfig();

  logger.info('Configuration loaded', {
    gateway: gatewayConfig.name,
    authMode: gatewayConfig.auth.mode,
    servers: serversConfig.servers.length,
    enabled: serversConfig.servers.filter(s => s.enabled).length,
  });

  // Create and start server
  const server = new MCPGatewayServer(gatewayConfig);

  // Load backend servers
  await server.loadBackends(serversConfig);

  // Start the server
  await server.start();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Log startup summary
  const backendManager = server.getBackendManager();
  const status = backendManager.getStatus();
  
  logger.info('Gateway ready', {
    backends: Object.keys(status).length,
    connected: Object.values(status).filter(s => s.status === 'connected').length,
    tools: backendManager.getAllTools().length,
    resources: backendManager.getAllResources().length,
    prompts: backendManager.getAllPrompts().length,
  });

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      MCP Gateway Ready                       ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Dashboard:        http://localhost:${gatewayConfig.port}/dashboard           ║
║  HTTP Streamable:  http://localhost:${gatewayConfig.port}/mcp                 ║
║  SSE:              http://localhost:${gatewayConfig.port}/sse                 ║
║  Health:           http://localhost:${gatewayConfig.port}/health              ║
║                                                              ║
║  Use these endpoints in your MCP clients:                    ║
║  - Claude Desktop: Add as Remote MCP Server                  ║
║  - Cursor: Settings → MCP → Add Server (HTTP/SSE)            ║
║  - Codex: codex mcp add gateway --url <http-url>             ║
║  - VS Code: Command Palette → MCP: Add Server (Remote)       ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

main().catch((error) => {
  logger.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});

