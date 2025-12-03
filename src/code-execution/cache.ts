/**
 * Tool Result Caching with TTL
 *
 * Caches tool call results to reduce redundant calls and improve performance.
 */

import { logger } from '../logger.js';

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
  hits: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/**
 * LRU Cache with TTL support
 */
export class ResultCache<T = unknown> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private defaultTTL: number;
  private hits = 0;
  private misses = 0;

  constructor(options?: { maxSize?: number; defaultTTL?: number }) {
    this.maxSize = options?.maxSize ?? 1000;
    this.defaultTTL = options?.defaultTTL ?? 300000; // 5 minutes default
  }

  /**
   * Generate cache key from tool name and arguments
   */
  static generateKey(toolName: string, args: unknown): string {
    const argsStr = JSON.stringify(args, Object.keys(args as object).sort());
    return `${toolName}:${argsStr}`;
  }

  /**
   * Get value from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    entry.hits++;
    this.hits++;

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, ttl?: number): void {
    // Evict oldest entries if at max size
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + (ttl ?? this.defaultTTL),
      createdAt: Date.now(),
      hits: 0,
    };

    this.cache.set(key, entry);
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete specific key
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    logger.info('Cache cleared');
  }

  /**
   * Remove expired entries
   */
  prune(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(`Pruned ${removed} expired cache entries`);
    }

    return removed;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  invalidatePattern(pattern: RegExp): number {
    let invalidated = 0;

    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
        invalidated++;
      }
    }

    return invalidated;
  }

  /**
   * Invalidate all entries for a specific tool
   */
  invalidateTool(toolName: string): number {
    return this.invalidatePattern(new RegExp(`^${toolName}:`));
  }
}

/**
 * Cached tool executor wrapper
 */
export function withCache<T>(
  cache: ResultCache<T>,
  fn: (key: string, ...args: unknown[]) => Promise<T>,
  options?: { ttl?: number; keyGenerator?: (...args: unknown[]) => string }
): (key: string, ...args: unknown[]) => Promise<T> {
  return async (key: string, ...args: unknown[]) => {
    const cacheKey = options?.keyGenerator
      ? options.keyGenerator(...args)
      : key;

    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      logger.debug(`Cache hit: ${cacheKey}`);
      return cached;
    }

    const result = await fn(key, ...args);
    cache.set(cacheKey, result, options?.ttl);
    logger.debug(`Cache miss, stored: ${cacheKey}`);

    return result;
  };
}
