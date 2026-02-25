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
import { printStartupBanner } from './banner.js';
import { setupGracefulShutdown } from './services/graceful-shutdown.js';

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

  // Start the HTTP server immediately (don't wait for backends)
  await server.start();

  // Load backend servers in the background (non-blocking)
  server.loadBackends(serversConfig).catch((error) => {
    logger.error('Error loading backends', { error: error.message });
  });

  // Set up graceful shutdown with connection draining
  const httpServer = server.getHttpServer();
  if (httpServer) {
    setupGracefulShutdown({
      server: httpServer,
      backendManager: server.getBackendManager(),
      gracePeriodMs: 15_000,
    });
  }

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

  printStartupBanner({
    host: gatewayConfig.host || '0.0.0.0',
    port: gatewayConfig.port,
    backendCount: Object.keys(status).length,
    toolCount: backendManager.getAllTools().length,
    resourceCount: backendManager.getAllResources().length,
    name: gatewayConfig.name,
  });
}

main().catch((error) => {
  logger.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});

