/**
 * Tool Discovery - Progressive Tool Disclosure
 *
 * Allows agents to search and filter tools without loading all definitions upfront.
 * This reduces token usage significantly when dealing with many tools.
 */

import { BackendManager } from '../backend/index.js';
import { MCPTool } from '../types.js';

export type DetailLevel = 'name_only' | 'name_description' | 'full_schema';

export interface ToolSearchOptions {
  /** Search query to match against tool names and descriptions */
  query?: string;
  /** Filter by specific backend ID */
  backend?: string;
  /** Filter by tool name prefix */
  prefix?: string;
  /** Detail level to return */
  detailLevel?: DetailLevel;
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
  inputSchema?: MCPTool['inputSchema'];
  backend: string;
}

export interface ToolTreeNode {
  name: string;
  type: 'server' | 'tool';
  children?: ToolTreeNode[];
  tool?: ToolInfo;
}

export class ToolDiscovery {
  private backendManager: BackendManager;
  private toolCache: Map<string, { tool: MCPTool; backend: string }> = new Map();
  private lastCacheUpdate = 0;
  private cacheTTL = 30000; // 30 seconds

  constructor(backendManager: BackendManager) {
    this.backendManager = backendManager;
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
        this.toolCache.set(tool.name, { tool, backend: backendId });
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
      detailLevel = 'name_description',
      limit = 50,
      offset = 0,
    } = options;

    let results: { tool: MCPTool; backend: string }[] = [];

    // Filter tools
    for (const entry of this.toolCache.values()) {
      // Backend filter
      if (backend && entry.backend !== backend) continue;

      // Prefix filter
      if (prefix && !entry.tool.name.startsWith(prefix)) continue;

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
    const tools: ToolInfo[] = results.map(({ tool, backend: backendId }) => {
      const info: ToolInfo = {
        name: tool.name,
        backend: backendId,
      };

      if (detailLevel === 'name_description' || detailLevel === 'full_schema') {
        info.description = tool.description;
      }

      if (detailLevel === 'full_schema') {
        info.inputSchema = tool.inputSchema;
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
   */
  getToolSchema(toolName: string): ToolInfo | null {
    this.refreshCache();

    const entry = this.toolCache.get(toolName);
    if (!entry) return null;

    return {
      name: entry.tool.name,
      description: entry.tool.description,
      inputSchema: entry.tool.inputSchema,
      backend: entry.backend,
    };
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
        });
      }
    }

    return tools;
  }
}
