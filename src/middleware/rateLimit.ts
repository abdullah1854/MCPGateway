/**
 * Rate Limiting Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { GatewayConfig } from '../types.js';
import { logger } from '../logger.js';
import { createInMemoryGatewayStores, RateLimitStore } from './stores.js';

export interface RateLimitMiddlewareOptions {
  store?: RateLimitStore;
}

/**
 * Get client identifier for rate limiting
 */
function getClientId(req: Request, trustProxy: boolean): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Create rate limiting middleware
 */
export function createRateLimitMiddleware(config: GatewayConfig, options: RateLimitMiddlewareOptions = {}) {
  const { windowMs, maxRequests } = config.rateLimit;
  const store = options.store ?? createInMemoryGatewayStores(config.store.namespace).rateLimit;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientId = getClientId(req, config.trustedProxy);
    const now = Date.now();
    let entry;
    try {
      entry = await store.increment(clientId, windowMs);
    } catch (error) {
      logger.error('Rate limit store unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message: 'Rate limit store unavailable',
        },
      });
      return;
    }

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      logger.warn('Rate limit exceeded', { clientId, count: entry.count });

      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));

      res.status(429).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Rate limit exceeded',
          data: {
            retryAfter: Math.ceil((entry.resetAt - now) / 1000),
          },
        },
      });
      return;
    }

    next();
  };
}
