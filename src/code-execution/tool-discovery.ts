/**
 * Tool Discovery - Progressive Tool Disclosure
 *
 * Allows agents to search and filter tools without loading all definitions upfront.
 * This reduces token usage significantly when dealing with many tools.
 * 
 * Implements patterns from Anthropic's Advanced Tool Use:
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import { BackendManager } from '../backend/index.js';
import { MCPTool } from '../types.js';

export type DetailLevel = 'name_only' | 'name_description' | 'compact_schema' | 'full_schema' | 'micro_schema';

/**
 * Tool categories for semantic grouping
 */
export const TOOL_CATEGORIES: Record<string, string[]> = {
  database: ['query', 'sql', 'table', 'schema', 'insert', 'update', 'delete', 'select', 'database', 'db'],
  filesystem: ['read', 'write', 'file', 'directory', 'path', 'copy', 'move', 'delete', 'list', 'folder'],
  api: ['fetch', 'http', 'request', 'endpoint', 'rest', 'graphql', 'api', 'webhook', 'url'],
  ai: ['generate', 'complete', 'embed', 'analyze', 'classify', 'llm', 'model', 'prompt', 'chat'],
  search: ['search', 'find', 'query', 'filter', 'lookup', 'index'],
  transform: ['convert', 'transform', 'parse', 'format', 'encode', 'decode', 'serialize'],
  auth: ['auth', 'login', 'token', 'oauth', 'credential', 'permission', 'role'],
  messaging: ['send', 'email', 'message', 'notify', 'slack', 'discord', 'sms'],
};

export interface ToolSearchOptions {
  /** Search query to match against tool names and descriptions */
  query?: string;
  /** Filter by specific backend ID */
  backend?: string;
  /** Filter by tool name prefix */
  prefix?: string;
  /** Filter by tool category (database, filesystem, api, ai, search, transform, auth, messaging) */
  category?: string;
  /** Detail level to return */
  detailLevel?: DetailLevel;
  /** Whether to include input examples */
  includeExamples?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface ToolSearchResult {
  tools: ToolInfo[];
  total: number;
  hasMore: boolean;
}

export interface ToolInfo {
  name: string;
  description?: string;
  shortDescription?: string;
  inputSchema?: MCPTool['inputSchema'];
  inputExamples?: Record<string, unknown>[];
  backend: string;
  category?: string;
  estimatedTokens?: number;
}

export interface ToolTreeNode {
  name: string;
  type: 'server' | 'tool';
  children?: ToolTreeNode[];
  tool?: ToolInfo;
}

export class ToolDiscovery {
  private backendManager: BackendManager;
  private toolCache: Map<string, { tool: MCPTool; backend: string; category?: string }> = new Map();
  private lastCacheUpdate = 0;
  private cacheTTL = 30000; // 30 seconds

  constructor(backendManager: BackendManager) {
    this.backendManager = backendManager;
  }

  /**
   * Estimate tokens for a given object (roughly 4 chars per token)
   */
  static estimateTokens(obj: unknown): number {
    return Math.ceil(JSON.stringify(obj).length / 4);
  }

  /**
   * Generate a short description (max 60 chars) from a longer one
   */
  static generateShortDescription(description?: string, name?: string): string {
    const desc = description || name || '';
    if (desc.length <= 60) return desc;

    // Try to get first sentence
    const firstSentence = desc.split(/[.!?]/)[0];
    if (firstSentence && firstSentence.length <= 60) return firstSentence;

    // Truncate with ellipsis
    return desc.substring(0, 57) + '...';
  }

  /**
   * Compact a schema by removing descriptions and examples
   * This saves ~40% tokens based on Anthropic's recommendations
   */
  static compactSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== 'object') return schema;

    return JSON.parse(JSON.stringify(schema, (key, value) => {
      // Remove verbose fields that consume tokens
      if (key === 'description' || key === 'examples' || key === 'example' || key === '$schema') {
        return undefined;
      }
      return value;
    }));
  }

  /**
   * Type abbreviation map for micro schema
   */
  private static readonly TYPE_ABBREV: Record<string, string> = {
    string: 's',
    number: 'n',
    integer: 'i',
    boolean: 'b',
    array: 'a',
    object: 'o',
    null: 'x',
  };

  /**
   * Micro schema - ultra-compact representation
   * Saves ~60-70% tokens compared to full schema
   * Format: { n: "name", t: "s", r: true } instead of { name: "string", type: "string", required: true }
   */
  static microSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== 'object') return schema;

    const obj = schema as Record<string, unknown>;

    // Handle properties object
    if (obj.type === 'object' && obj.properties) {
      const props = obj.properties as Record<string, unknown>;
      const required = new Set((obj.required as string[]) || []);
      const microProps: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(props)) {
        const propObj = value as Record<string, unknown>;
        const microProp: Record<string, unknown> = {
          t: ToolDiscovery.TYPE_ABBREV[propObj.type as string] || propObj.type,
        };

        if (required.has(key)) {
          microProp.r = 1; // required = 1 (true)
        }

        // Handle enum
        if (propObj.enum) {
          microProp.e = propObj.enum;
        }

        // Handle array items
        if (propObj.type === 'array' && propObj.items) {
          const items = propObj.items as Record<string, unknown>;
          microProp.i = ToolDiscovery.TYPE_ABBREV[items.type as string] || items.type;
        }

        // Handle default
        if (propObj.default !== undefined) {
          microProp.d = propObj.default;
        }

        microProps[key] = microProp;
      }

      return { p: microProps };
    }

    return schema;
  }

  /**
   * Detect category from tool name and description
   */
  static detectCategory(name: string, description?: string): string | undefined {
    const searchText = `${name} ${description || ''}`.toLowerCase();

    for (const [category, keywords] of Object.entries(TOOL_CATEGORIES)) {
      for (const keyword of keywords) {
        if (searchText.includes(keyword)) {
          return category;
        }
      }
    }
    return undefined;
  }

  /**
   * Refresh the tool cache if needed
   */
  private refreshCache(): void {
    const now = Date.now();
    if (now - this.lastCacheUpdate < this.cacheTTL) {
      return;
    }

    this.toolCache.clear();
    const backends = this.backendManager.getBackends();

    for (const [backendId, backend] of backends) {
      if (backend.status !== 'connected') continue;

      for (const tool of backend.tools) {
        const category = ToolDiscovery.detectCategory(tool.name, tool.description);
        this.toolCache.set(tool.name, { tool, backend: backendId, category });
      }
    }

    this.lastCacheUpdate = now;
  }

  /**
   * Search tools with filtering options
   */
  searchTools(options: ToolSearchOptions = {}): ToolSearchResult {
    this.refreshCache();

    const {
      query,
      backend,
      prefix,
      category,
      detailLevel = 'name_description',
      includeExamples = false,
      limit = 50,
      offset = 0,
    } = options;

    let results: { tool: MCPTool; backend: string; category?: string }[] = [];

    // Filter tools
    for (const entry of this.toolCache.values()) {
      // Backend filter
      if (backend && entry.backend !== backend) continue;

      // Prefix filter
      if (prefix && !entry.tool.name.startsWith(prefix)) continue;

      // Category filter
      if (category && entry.category !== category) continue;

      // Query filter (search in name and description)
      if (query) {
        const queryLower = query.toLowerCase();
        const nameMatch = entry.tool.name.toLowerCase().includes(queryLower);
        const descMatch = entry.tool.description?.toLowerCase().includes(queryLower);
        if (!nameMatch && !descMatch) continue;
      }

      results.push(entry);
    }

    const total = results.length;

    // Apply pagination
    results = results.slice(offset, offset + limit);

    // Map to requested detail level
    const tools: ToolInfo[] = results.map(({ tool, backend: backendId, category: toolCategory }) => {
      const info: ToolInfo = {
        name: tool.name,
        backend: backendId,
      };

      // Always include category if detected
      if (toolCategory) {
        info.category = toolCategory;
      }

      if (detailLevel === 'name_description' || detailLevel === 'compact_schema' || detailLevel === 'full_schema' || detailLevel === 'micro_schema') {
        info.description = tool.description;
        info.shortDescription = ToolDiscovery.generateShortDescription(tool.description, tool.name);
      }

      if (detailLevel === 'micro_schema') {
        // Micro schema: ultra-compact with abbreviated types
        info.inputSchema = ToolDiscovery.microSchema(tool.inputSchema) as MCPTool['inputSchema'];
        info.estimatedTokens = ToolDiscovery.estimateTokens(info);
      }

      if (detailLevel === 'compact_schema') {
        // Compact schema: types only, no descriptions
        info.inputSchema = ToolDiscovery.compactSchema(tool.inputSchema) as MCPTool['inputSchema'];
        info.estimatedTokens = ToolDiscovery.estimateTokens(info);
      }

      if (detailLevel === 'full_schema') {
        info.inputSchema = tool.inputSchema;
        info.estimatedTokens = ToolDiscovery.estimateTokens(info);
      }

      // Include examples if requested and available
      if (includeExamples && tool.inputExamples && tool.inputExamples.length > 0) {
        info.inputExamples = tool.inputExamples;
      }

      return info;
    });

    return {
      tools,
      total,
      hasMore: offset + results.length < total,
    };
  }

  /**
   * Get full schema for a specific tool (lazy loading)
   * @param toolName - Name of the tool
   * @param mode - Schema mode: false/undefined=full, true/'compact'=compact, 'micro'=micro
   */
  getToolSchema(toolName: string, mode: boolean | 'compact' | 'micro' = false): ToolInfo | null {
    this.refreshCache();

    const entry = this.toolCache.get(toolName);
    if (!entry) return null;

    let schema: MCPTool['inputSchema'];
    if (mode === 'micro') {
      schema = ToolDiscovery.microSchema(entry.tool.inputSchema) as MCPTool['inputSchema'];
    } else if (mode === true || mode === 'compact') {
      schema = ToolDiscovery.compactSchema(entry.tool.inputSchema) as MCPTool['inputSchema'];
    } else {
      schema = entry.tool.inputSchema;
    }

    const info: ToolInfo = {
      name: entry.tool.name,
      description: entry.tool.description,
      shortDescription: ToolDiscovery.generateShortDescription(entry.tool.description, entry.tool.name),
      inputSchema: schema,
      backend: entry.backend,
      category: entry.category,
    };

    // Include examples if available
    if (entry.tool.inputExamples && entry.tool.inputExamples.length > 0) {
      info.inputExamples = entry.tool.inputExamples;
    }

    info.estimatedTokens = ToolDiscovery.estimateTokens(info);

    return info;
  }

  /**
   * Get schemas for multiple tools at once (batch loading)
   * @param mode - Schema mode: false/undefined=full, true/'compact'=compact, 'micro'=micro
   */
  getToolSchemas(toolNames: string[], mode: boolean | 'compact' | 'micro' = false): { tools: ToolInfo[]; notFound: string[] } {
    this.refreshCache();

    const tools: ToolInfo[] = [];
    const notFound: string[] = [];

    for (const toolName of toolNames) {
      const schema = this.getToolSchema(toolName, mode);
      if (schema) {
        tools.push(schema);
      } else {
        notFound.push(toolName);
      }
    }

    return { tools, notFound };
  }

  /**
   * Get available tool categories with counts
   */
  getToolCategories(): Record<string, { count: number; tools: string[] }> {
    this.refreshCache();

    const categories: Record<string, { count: number; tools: string[] }> = {};

    for (const [toolName, entry] of this.toolCache) {
      const category = entry.category || 'other';
      if (!categories[category]) {
        categories[category] = { count: 0, tools: [] };
      }
      categories[category].count++;
      categories[category].tools.push(toolName);
    }

    return categories;
  }

  /**
   * Get tools organized as a filesystem-like tree structure
   */
  getToolTree(): ToolTreeNode[] {
    this.refreshCache();

    const backends = this.backendManager.getBackends();
    const tree: ToolTreeNode[] = [];

    for (const [backendId, backend] of backends) {
      if (backend.status !== 'connected') continue;

      const serverNode: ToolTreeNode = {
        name: backendId,
        type: 'server',
        children: backend.tools.map(tool => ({
          name: tool.name,
          type: 'tool' as const,
          tool: {
            name: tool.name,
            description: tool.description,
            backend: backendId,
          },
        })),
      };

      tree.push(serverNode);
    }

    return tree;
  }

  /**
   * Get tool statistics by backend
   */
  getToolStats(): Record<string, { toolCount: number; tools: string[] }> {
    this.refreshCache();

    const stats: Record<string, { toolCount: number; tools: string[] }> = {};

    for (const [toolName, entry] of this.toolCache) {
      if (!stats[entry.backend]) {
        stats[entry.backend] = { toolCount: 0, tools: [] };
      }
      stats[entry.backend].toolCount++;
      stats[entry.backend].tools.push(toolName);
    }

    return stats;
  }

  /**
   * Get all tool names (minimal token usage)
   */
  getAllToolNames(): string[] {
    this.refreshCache();
    return Array.from(this.toolCache.keys());
  }

  /**
   * Get tools by backend
   */
  getToolsByBackend(backendId: string): ToolInfo[] {
    this.refreshCache();

    const tools: ToolInfo[] = [];
    for (const [, entry] of this.toolCache) {
      if (entry.backend === backendId) {
        tools.push({
          name: entry.tool.name,
          description: entry.tool.description,
          backend: entry.backend,
          category: entry.category,
        });
      }
    }

    return tools;
  }
}
