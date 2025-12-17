/**
 * Delta Response System - Incremental Updates
 *
 * For repeated queries or polling scenarios, send only the changes
 * instead of full responses. This can save 90%+ tokens on updates.
 *
 * Use cases:
 * - Dashboard refreshes
 * - Monitoring queries
 * - Real-time data feeds
 * - Pagination with caching
 */

import { createHash } from 'crypto';

export interface DeltaEntry {
  hash: string;
  data: unknown;
  timestamp: number;
  accessCount: number;
}

export interface DeltaResult<T> {
  /** Whether this is a delta (partial) response */
  isDelta: boolean;
  /** The response data (full or delta) */
  data: T | DeltaPatch;
  /** Hash of the current state for future delta requests */
  stateHash: string;
  /** Stats about the delta operation */
  stats?: {
    originalSize: number;
    deltaSize: number;
    savedPercent: number;
  };
}

export interface DeltaPatch {
  /** Type of delta operation */
  type: 'full' | 'diff' | 'append' | 'remove' | 'update';
  /** Reference to previous state */
  previousHash?: string;
  /** Added items (for arrays) */
  added?: unknown[];
  /** Removed item indices or keys */
  removed?: (number | string)[];
  /** Updated items with their indices/keys */
  updated?: Record<string | number, unknown>;
  /** Changed fields (for objects) */
  changes?: Record<string, { old?: unknown; new: unknown }>;
}

/**
 * Generate a hash for data
 */
function hashData(data: unknown): string {
  const str = JSON.stringify(data);
  return createHash('sha256').update(str).digest('hex').substring(0, 16);
}

/**
 * Estimate size in tokens
 */
function estimateTokens(data: unknown): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

/**
 * Delta Response Manager - Session-scoped delta tracking
 */
export class DeltaResponseManager {
  private cache = new Map<string, DeltaEntry>();
  private maxCacheSize = 100;
  private maxAge = 10 * 60 * 1000; // 10 minutes

  /**
   * Generate a cache key for a query
   */
  static generateKey(toolName: string, args: unknown): string {
    const argsStr = JSON.stringify(args, Object.keys(args as object).sort());
    return `delta:${toolName}:${argsStr}`;
  }

  /**
   * Get delta response for array data
   */
  getDeltaForArray<T>(
    key: string,
    currentData: T[],
    idField?: string
  ): DeltaResult<T[]> {
    const currentHash = hashData(currentData);
    const cached = this.cache.get(key);

    // No previous data - return full response
    if (!cached) {
      this.storeResponse(key, currentData, currentHash);
      return {
        isDelta: false,
        data: currentData,
        stateHash: currentHash,
      };
    }

    // Same data - return minimal response
    if (cached.hash === currentHash) {
      cached.accessCount++;
      return {
        isDelta: true,
        data: {
          type: 'full',
          previousHash: cached.hash,
        } as DeltaPatch,
        stateHash: currentHash,
        stats: {
          originalSize: estimateTokens(currentData),
          deltaSize: estimateTokens({ unchanged: true }),
          savedPercent: 95,
        },
      };
    }

    // Compute delta
    const previousData = cached.data as T[];
    const delta = this.computeArrayDelta(previousData, currentData, idField);

    // Store new state
    this.storeResponse(key, currentData, currentHash);

    const originalSize = estimateTokens(currentData);
    const deltaSize = estimateTokens(delta);
    const savedPercent = Math.round((1 - deltaSize / originalSize) * 100);

    // Only use delta if it's significantly smaller
    if (savedPercent < 20) {
      return {
        isDelta: false,
        data: currentData,
        stateHash: currentHash,
      };
    }

    return {
      isDelta: true,
      data: delta,
      stateHash: currentHash,
      stats: {
        originalSize,
        deltaSize,
        savedPercent,
      },
    };
  }

  /**
   * Get delta response for object data
   */
  getDeltaForObject<T extends Record<string, unknown>>(
    key: string,
    currentData: T
  ): DeltaResult<T> {
    const currentHash = hashData(currentData);
    const cached = this.cache.get(key);

    // No previous data - return full response
    if (!cached) {
      this.storeResponse(key, currentData, currentHash);
      return {
        isDelta: false,
        data: currentData,
        stateHash: currentHash,
      };
    }

    // Same data - return minimal response
    if (cached.hash === currentHash) {
      cached.accessCount++;
      return {
        isDelta: true,
        data: {
          type: 'full',
          previousHash: cached.hash,
        } as DeltaPatch,
        stateHash: currentHash,
        stats: {
          originalSize: estimateTokens(currentData),
          deltaSize: estimateTokens({ unchanged: true }),
          savedPercent: 95,
        },
      };
    }

    // Compute delta
    const previousData = cached.data as T;
    const delta = this.computeObjectDelta(previousData, currentData);

    // Store new state
    this.storeResponse(key, currentData, currentHash);

    const originalSize = estimateTokens(currentData);
    const deltaSize = estimateTokens(delta);
    const savedPercent = Math.round((1 - deltaSize / originalSize) * 100);

    // Only use delta if it's significantly smaller
    if (savedPercent < 20) {
      return {
        isDelta: false,
        data: currentData,
        stateHash: currentHash,
      };
    }

    return {
      isDelta: true,
      data: delta,
      stateHash: currentHash,
      stats: {
        originalSize,
        deltaSize,
        savedPercent,
      },
    };
  }

  /**
   * Compute delta between two arrays
   */
  private computeArrayDelta<T>(
    previous: T[],
    current: T[],
    idField?: string
  ): DeltaPatch {
    // If we have an ID field, use it for smarter diffing
    if (idField) {
      return this.computeArrayDeltaById(previous, current, idField);
    }

    // Simple positional diff
    const added: T[] = [];
    const removed: number[] = [];
    const updated: Record<number, T> = {};

    const maxLen = Math.max(previous.length, current.length);

    for (let i = 0; i < maxLen; i++) {
      const prev = previous[i];
      const curr = current[i];

      if (prev === undefined && curr !== undefined) {
        added.push(curr);
      } else if (prev !== undefined && curr === undefined) {
        removed.push(i);
      } else if (JSON.stringify(prev) !== JSON.stringify(curr)) {
        updated[i] = curr;
      }
    }

    return {
      type: 'diff',
      added: added.length > 0 ? added : undefined,
      removed: removed.length > 0 ? removed : undefined,
      updated: Object.keys(updated).length > 0 ? updated : undefined,
    };
  }

  /**
   * Compute delta using ID field for matching
   */
  private computeArrayDeltaById<T>(
    previous: T[],
    current: T[],
    idField: string
  ): DeltaPatch {
    const prevMap = new Map<unknown, T>();
    const currMap = new Map<unknown, T>();

    for (const item of previous) {
      const id = (item as Record<string, unknown>)[idField];
      if (id !== undefined) prevMap.set(id, item);
    }

    for (const item of current) {
      const id = (item as Record<string, unknown>)[idField];
      if (id !== undefined) currMap.set(id, item);
    }

    const added: T[] = [];
    const removed: (string | number)[] = [];
    const updated: Record<string, T> = {};

    // Find added and updated
    for (const [id, curr] of currMap) {
      const prev = prevMap.get(id);
      if (!prev) {
        added.push(curr);
      } else if (JSON.stringify(prev) !== JSON.stringify(curr)) {
        updated[String(id)] = curr;
      }
    }

    // Find removed
    for (const [id] of prevMap) {
      if (!currMap.has(id)) {
        // Cast id to string or number for the removed array
        removed.push(typeof id === 'number' ? id : String(id));
      }
    }

    return {
      type: 'diff',
      added: added.length > 0 ? added : undefined,
      removed: removed.length > 0 ? removed : undefined,
      updated: Object.keys(updated).length > 0 ? updated : undefined,
    };
  }

  /**
   * Compute delta between two objects
   */
  private computeObjectDelta<T extends Record<string, unknown>>(
    previous: T,
    current: T
  ): DeltaPatch {
    const changes: Record<string, { old?: unknown; new: unknown }> = {};

    const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);

    for (const key of allKeys) {
      const prevVal = previous[key];
      const currVal = current[key];

      if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        changes[key] = {
          old: prevVal,
          new: currVal,
        };
      }
    }

    return {
      type: 'update',
      changes: Object.keys(changes).length > 0 ? changes : undefined,
    };
  }

  /**
   * Store response in cache
   */
  private storeResponse(key: string, data: unknown, hash: string): void {
    // Evict old entries if at capacity
    if (this.cache.size >= this.maxCacheSize) {
      this.pruneCache();
    }

    this.cache.set(key, {
      hash,
      data,
      timestamp: Date.now(),
      accessCount: 1,
    });
  }

  /**
   * Prune old or least-used entries
   */
  private pruneCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    // First, delete expired entries
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.maxAge) {
        toDelete.push(key);
      }
    }

    // If still over capacity, delete least accessed
    if (this.cache.size - toDelete.length >= this.maxCacheSize) {
      const entries = Array.from(this.cache.entries())
        .filter(([key]) => !toDelete.includes(key))
        .sort((a, b) => a[1].accessCount - b[1].accessCount);

      const deleteCount = Math.ceil(this.maxCacheSize * 0.2); // Delete 20%
      for (let i = 0; i < deleteCount && i < entries.length; i++) {
        toDelete.push(entries[i][0]);
      }
    }

    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  /**
   * Clear all cached deltas
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Invalidate cache for a specific tool
   */
  invalidateTool(toolName: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(`delta:${toolName}:`)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }
}

/**
 * Session-scoped delta manager storage
 */
const sessionDeltaManagers = new Map<string, DeltaResponseManager>();

/**
 * Get delta manager for a session
 */
export function getDeltaManager(sessionId: string | undefined): DeltaResponseManager {
  if (!sessionId) {
    return new DeltaResponseManager();
  }

  let manager = sessionDeltaManagers.get(sessionId);
  if (!manager) {
    manager = new DeltaResponseManager();
    sessionDeltaManagers.set(sessionId, manager);
  }
  return manager;
}

/**
 * Apply a delta patch to reconstruct full data (for clients)
 */
export function applyDelta<T>(previous: T, delta: DeltaPatch): T {
  if (delta.type === 'full') {
    return previous;
  }

  if (Array.isArray(previous)) {
    const result = [...previous] as unknown[];

    // Apply removals (from end to preserve indices)
    if (delta.removed) {
      const indices = [...delta.removed].sort((a, b) => (b as number) - (a as number));
      for (const idx of indices) {
        result.splice(idx as number, 1);
      }
    }

    // Apply updates
    if (delta.updated) {
      for (const [idx, value] of Object.entries(delta.updated)) {
        result[parseInt(idx)] = value;
      }
    }

    // Apply additions
    if (delta.added) {
      result.push(...delta.added);
    }

    return result as T;
  }

  if (typeof previous === 'object' && previous !== null && delta.changes) {
    const result = { ...previous } as Record<string, unknown>;
    for (const [key, change] of Object.entries(delta.changes)) {
      if (change.new === undefined) {
        delete result[key];
      } else {
        result[key] = change.new;
      }
    }
    return result as T;
  }

  return previous;
}
