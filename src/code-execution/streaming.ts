/**
 * Streaming Support for Large Results
 *
 * Implements streaming responses for large tool results to avoid
 * memory issues and enable incremental processing.
 */

import { Response } from 'express';

export interface StreamOptions {
  chunkSize?: number;
  format?: 'jsonl' | 'json-array';
}

/**
 * Stream an array of results as JSON Lines (JSONL) or chunked JSON array
 */
export function streamResults(
  res: Response,
  results: unknown[],
  options: StreamOptions = {}
): void {
  const { format = 'jsonl' } = options;

  res.setHeader('Content-Type', format === 'jsonl' ? 'application/x-ndjson' : 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');

  if (format === 'jsonl') {
    // Stream as JSON Lines (one JSON object per line)
    for (const item of results) {
      res.write(JSON.stringify(item) + '\n');
    }
  } else {
    // Stream as chunked JSON array
    res.write('[\n');
    for (let i = 0; i < results.length; i++) {
      const isLast = i === results.length - 1;
      res.write(JSON.stringify(results[i]) + (isLast ? '\n' : ',\n'));
    }
    res.write(']\n');
  }

  res.end();
}

/**
 * Create a streaming response generator for async iteration
 */
export async function* streamGenerator<T>(
  items: T[],
  chunkSize: number = 100
): AsyncGenerator<T[], void, unknown> {
  for (let i = 0; i < items.length; i += chunkSize) {
    yield items.slice(i, i + chunkSize);
  }
}

/**
 * Aggregation helpers for tool results
 */
export const Aggregations = {
  /**
   * Count items in an array
   */
  count(data: unknown[]): number {
    return data.length;
  },

  /**
   * Sum numeric values from an array of objects
   */
  sum(data: Record<string, unknown>[], field: string): number {
    return data.reduce((acc, item) => {
      const value = item[field];
      return acc + (typeof value === 'number' ? value : 0);
    }, 0);
  },

  /**
   * Calculate average of numeric values
   */
  avg(data: Record<string, unknown>[], field: string): number {
    if (data.length === 0) return 0;
    return Aggregations.sum(data, field) / data.length;
  },

  /**
   * Find minimum value
   */
  min(data: Record<string, unknown>[], field: string): number | null {
    const values = data
      .map(item => item[field])
      .filter((v): v is number => typeof v === 'number');
    return values.length > 0 ? Math.min(...values) : null;
  },

  /**
   * Find maximum value
   */
  max(data: Record<string, unknown>[], field: string): number | null {
    const values = data
      .map(item => item[field])
      .filter((v): v is number => typeof v === 'number');
    return values.length > 0 ? Math.max(...values) : null;
  },

  /**
   * Group by a field
   */
  groupBy(data: Record<string, unknown>[], field: string): Record<string, Record<string, unknown>[]> {
    const result: Record<string, Record<string, unknown>[]> = {};
    for (const item of data) {
      const key = String(item[field] ?? 'null');
      if (!result[key]) result[key] = [];
      result[key].push(item);
    }
    return result;
  },

  /**
   * Get distinct values for a field
   */
  distinct(data: Record<string, unknown>[], field: string): unknown[] {
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const item of data) {
      const value = item[field];
      const key = JSON.stringify(value);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(value);
      }
    }
    return result;
  },

  /**
   * Apply multiple aggregations at once
   */
  aggregate(
    data: Record<string, unknown>[],
    operations: Array<{ type: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; alias: string }>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const op of operations) {
      switch (op.type) {
        case 'count':
          result[op.alias] = Aggregations.count(data);
          break;
        case 'sum':
          result[op.alias] = op.field ? Aggregations.sum(data, op.field) : 0;
          break;
        case 'avg':
          result[op.alias] = op.field ? Aggregations.avg(data, op.field) : 0;
          break;
        case 'min':
          result[op.alias] = op.field ? Aggregations.min(data, op.field) : null;
          break;
        case 'max':
          result[op.alias] = op.field ? Aggregations.max(data, op.field) : null;
          break;
      }
    }

    return result;
  },
};
