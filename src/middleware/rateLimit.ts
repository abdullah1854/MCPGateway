/**
 * Rate Limiting Middleware
 * Simple in-memory rate limiter
 */

import { Request, Response, NextFunction } from 'express';
import { GatewayConfig } from '../types.js';
import { logger } from '../logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) {
      store.delete(key);
    }
  }
}, 60000); // Clean up every minute

/**
 * Get client identifier for rate limiting
 */
function getClientId(req: Request): string {
  // Use X-Forwarded-For if behind a proxy, otherwise use IP
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Create rate limiting middleware
 */
export function createRateLimitMiddleware(config: GatewayConfig) {
  const { windowMs, maxRequests } = config.rateLimit;

  return (req: Request, res: Response, next: NextFunction): void => {
    const clientId = getClientId(req);
    const now = Date.now();

    let entry = store.get(clientId);

    if (!entry || now >= entry.resetAt) {
      // Create new entry
      entry = {
        count: 1,
        resetAt: now + windowMs,
      };
      store.set(clientId, entry);
    } else {
      entry.count++;
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

