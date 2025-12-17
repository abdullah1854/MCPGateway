/**
 * Schema Deduplication - Reference Identical Schemas by Hash
 *
 * Many MCP tools share identical or very similar schemas. This module
 * identifies duplicates and allows referencing them by hash instead
 * of sending the full schema repeatedly.
 *
 * Example savings:
 * - 10 database tools with same query schema: 90% reduction
 * - 20 filesystem tools with path schema: 95% reduction
 */

import { createHash } from 'crypto';

export interface SchemaReference {
  $ref: string;
  hash: string;
}

export interface SchemaRegistry {
  schemas: Record<string, unknown>;
  tools: Record<string, string>; // toolName -> schemaHash
}

export interface DedupStats {
  totalSchemas: number;
  uniqueSchemas: number;
  duplicateSchemas: number;
  estimatedTokensSaved: number;
  deduplicationRatio: number;
}

/**
 * Schema deduplication manager
 */
export class SchemaDeduplicator {
  private schemaHashes = new Map<string, unknown>(); // hash -> schema
  private toolSchemas = new Map<string, string>(); // toolName -> hash
  private schemaUsage = new Map<string, Set<string>>(); // hash -> Set<toolName>

  /**
   * Generate a deterministic hash for a schema
   */
  static hashSchema(schema: unknown): string {
    // Normalize the schema for consistent hashing
    const normalized = JSON.stringify(schema, Object.keys(schema as object).sort());
    return createHash('sha256').update(normalized).digest('hex').substring(0, 12);
  }

  /**
   * Estimate tokens for a schema
   */
  static estimateTokens(schema: unknown): number {
    return Math.ceil(JSON.stringify(schema).length / 4);
  }

  /**
   * Register a tool's schema
   */
  registerSchema(toolName: string, schema: unknown): string {
    const hash = SchemaDeduplicator.hashSchema(schema);

    // Store the schema if new
    if (!this.schemaHashes.has(hash)) {
      this.schemaHashes.set(hash, schema);
      this.schemaUsage.set(hash, new Set());
    }

    // Map tool to schema
    this.toolSchemas.set(toolName, hash);
    this.schemaUsage.get(hash)!.add(toolName);

    return hash;
  }

  /**
   * Register multiple tools at once
   */
  registerAll(tools: Array<{ name: string; inputSchema: unknown }>): void {
    for (const tool of tools) {
      this.registerSchema(tool.name, tool.inputSchema);
    }
  }

  /**
   * Get schema for a tool
   */
  getSchema(toolName: string): unknown | null {
    const hash = this.toolSchemas.get(toolName);
    if (!hash) return null;
    return this.schemaHashes.get(hash) ?? null;
  }

  /**
   * Get schema hash for a tool
   */
  getSchemaHash(toolName: string): string | null {
    return this.toolSchemas.get(toolName) ?? null;
  }

  /**
   * Check if schema is duplicated across tools
   */
  isDuplicate(toolName: string): boolean {
    const hash = this.toolSchemas.get(toolName);
    if (!hash) return false;
    const usage = this.schemaUsage.get(hash);
    return usage ? usage.size > 1 : false;
  }

  /**
   * Get all tools sharing the same schema
   */
  getToolsWithSameSchema(toolName: string): string[] {
    const hash = this.toolSchemas.get(toolName);
    if (!hash) return [];
    const usage = this.schemaUsage.get(hash);
    return usage ? Array.from(usage) : [];
  }

  /**
   * Get deduplicated schema response
   * Returns either full schema or reference if already sent
   */
  getDeduplicatedSchema(
    toolName: string,
    sentSchemas: Set<string>
  ): { schema: unknown; isReference: boolean; hash: string } | null {
    const hash = this.toolSchemas.get(toolName);
    if (!hash) return null;

    const schema = this.schemaHashes.get(hash);
    if (!schema) return null;

    // If this schema hash was already sent, return a reference
    if (sentSchemas.has(hash)) {
      return {
        schema: { $schemaRef: hash },
        isReference: true,
        hash,
      };
    }

    return {
      schema,
      isReference: false,
      hash,
    };
  }

  /**
   * Build a schema registry for efficient transmission
   * This sends unique schemas once and references them by hash
   */
  buildRegistry(toolNames?: string[]): SchemaRegistry {
    const schemas: Record<string, unknown> = {};
    const tools: Record<string, string> = {};

    const targetTools = toolNames
      ? new Set(toolNames)
      : new Set(this.toolSchemas.keys());

    // Collect unique schemas needed for the requested tools
    const neededHashes = new Set<string>();
    for (const toolName of targetTools) {
      const hash = this.toolSchemas.get(toolName);
      if (hash) {
        neededHashes.add(hash);
        tools[toolName] = hash;
      }
    }

    // Add unique schemas
    for (const hash of neededHashes) {
      const schema = this.schemaHashes.get(hash);
      if (schema) {
        schemas[hash] = schema;
      }
    }

    return { schemas, tools };
  }

  /**
   * Get deduplication statistics
   */
  getStats(): DedupStats {
    const totalSchemas = this.toolSchemas.size;
    const uniqueSchemas = this.schemaHashes.size;
    const duplicateSchemas = totalSchemas - uniqueSchemas;

    // Calculate token savings
    let originalTokens = 0;
    let deduplicatedTokens = 0;

    for (const [hash, schema] of this.schemaHashes) {
      const schemaTokens = SchemaDeduplicator.estimateTokens(schema);
      const usageCount = this.schemaUsage.get(hash)?.size ?? 1;

      originalTokens += schemaTokens * usageCount;
      deduplicatedTokens += schemaTokens; // Only count once
    }

    // Add reference overhead (small per reference)
    const referenceOverhead = duplicateSchemas * 5; // ~5 tokens per reference
    deduplicatedTokens += referenceOverhead;

    return {
      totalSchemas,
      uniqueSchemas,
      duplicateSchemas,
      estimatedTokensSaved: originalTokens - deduplicatedTokens,
      deduplicationRatio: totalSchemas > 0 ? uniqueSchemas / totalSchemas : 1,
    };
  }

  /**
   * Get common schema patterns (for documentation/debugging)
   */
  getCommonPatterns(): Array<{ hash: string; toolCount: number; tools: string[] }> {
    const patterns: Array<{ hash: string; toolCount: number; tools: string[] }> = [];

    for (const [hash, tools] of this.schemaUsage) {
      if (tools.size > 1) {
        patterns.push({
          hash,
          toolCount: tools.size,
          tools: Array.from(tools),
        });
      }
    }

    return patterns.sort((a, b) => b.toolCount - a.toolCount);
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.schemaHashes.clear();
    this.toolSchemas.clear();
    this.schemaUsage.clear();
  }
}

// Singleton instance for global schema deduplication
export const globalSchemaDeduplicator = new SchemaDeduplicator();

/**
 * Create a compact tool list with deduplicated schemas
 */
export function createCompactToolList(
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>
): {
  schemaRegistry: Record<string, unknown>;
  tools: Array<{ name: string; description?: string; schemaRef: string }>;
  stats: DedupStats;
} {
  const dedup = new SchemaDeduplicator();
  dedup.registerAll(tools);

  const registry = dedup.buildRegistry();
  const compactTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    schemaRef: registry.tools[tool.name],
  }));

  return {
    schemaRegistry: registry.schemas,
    tools: compactTools,
    stats: dedup.getStats(),
  };
}
