/**
 * Rate Limiting Middleware
 * In-memory rate limiter with LRU eviction to prevent unbounded memory growth
 */

import { Request, Response, NextFunction } from 'express';
import { GatewayConfig } from '../types.js';
import { logger } from '../logger.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Maximum number of entries to prevent unbounded memory growth
const MAX_ENTRIES = 10000;

// LRU-style store with bounded size
class BoundedRateLimitStore {
  private store = new Map<string, RateLimitEntry>();

  get(key: string): RateLimitEntry | undefined {
    const entry = this.store.get(key);
    if (entry) {
      // Move to end for LRU behavior (delete and re-add)
      this.store.delete(key);
      this.store.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: RateLimitEntry): void {
    // If key exists, delete it first to update position
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= MAX_ENTRIES) {
      // Evict oldest entry (first in Map)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, entry);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  entries(): IterableIterator<[string, RateLimitEntry]> {
    return this.store.entries();
  }

  get size(): number {
    return this.store.size;
  }
}

const store = new BoundedRateLimitStore();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  const toDelete: string[] = [];

  for (const [key, entry] of store.entries()) {
    if (now >= entry.resetAt) {
      toDelete.push(key);
    }
  }

  for (const key of toDelete) {
    store.delete(key);
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

