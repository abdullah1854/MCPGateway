/**
 * CORS middleware with deployment-profile-aware credential policy.
 *
 * Wildcard origin (*) must not combine with credentials outside local-single-user.
 * Browsers reject Access-Control-Allow-Origin: * with credentials anyway; this
 * middleware enforces safe behavior at the gateway layer.
 */

import cors, { CorsOptions } from 'cors';
import { GatewayConfig } from '../types.js';
import { corsConfigHasWildcard, isLocalhostOrigin } from '../deployment-profile.js';
import { logger } from '../logger.js';

const MCP_CORS_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS'];
const MCP_CORS_HEADERS = [
  'Content-Type',
  'Authorization',
  'Mcp-Session-Id',
  'X-Session-Id',
  'Accept',
];
const MCP_EXPOSED_HEADERS = ['Mcp-Session-Id'];

function buildBaseOptions(): Pick<CorsOptions, 'methods' | 'allowedHeaders' | 'exposedHeaders'> {
  return {
    methods: MCP_CORS_METHODS,
    allowedHeaders: MCP_CORS_HEADERS,
    exposedHeaders: MCP_EXPOSED_HEADERS,
  };
}

export function resolveCorsCredentials(config: GatewayConfig): boolean {
  if (!corsConfigHasWildcard(config.cors.origins)) {
    return true;
  }
  return config.deploymentProfile === 'local-single-user';
}

/**
 * Create CORS middleware aligned with deployment profile.
 */
export function createCorsMiddleware(config: GatewayConfig) {
  const origins = config.cors.origins;
  const base = buildBaseOptions();

  if (origins === '*') {
    if (config.deploymentProfile === 'local-single-user') {
      return cors({
        ...base,
        credentials: true,
        origin: (origin, callback) => {
          if (!origin || isLocalhostOrigin(origin)) {
            callback(null, origin ?? true);
            return;
          }
          logger.debug('CORS rejected non-localhost origin in local-single-user mode', { origin });
          callback(null, false);
        },
      });
    }

    return cors({
      ...base,
      origin: '*',
      credentials: false,
    });
  }

  const originList = Array.isArray(origins) ? origins : [origins];
  return cors({
    ...base,
    origin: originList,
    credentials: true,
  });
}