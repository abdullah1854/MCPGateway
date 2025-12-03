/**
 * Minimal end-to-end style smoke tests for MCP Gateway core flows.
 *
 * These are intentionally lightweight and can be run with:
 *
 *   npx tsx src/tests/smoke.e2e.test.ts
 *
 * They focus on: /health and instantiation of the main server.
 */

import { MCPGatewayServer } from '../server.js';
import ConfigManager, { loadGatewayConfig } from '../config.js';

async function main(): Promise<void> {
  const configManager = ConfigManager.getInstance();
  const cfg = configManager.getGatewayConfig() ?? loadGatewayConfig();
  const server = new MCPGatewayServer(cfg);

  await server.start();
  console.log('Gateway started for smoke test');

  const res = await fetch(`http://${cfg.host}:${cfg.port}/health`);
  if (!res.ok) {
    throw new Error(`/health returned HTTP ${res.status}`);
  }
  const body = await res.json() as { status: string };
  if (!body || (body.status !== 'ok' && body.status !== 'degraded')) {
    throw new Error(`Unexpected health status: ${JSON.stringify(body)}`);
  }

  await server.stop();
  console.log('Smoke test passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}


