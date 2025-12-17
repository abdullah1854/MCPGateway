/**
 * Gateway MCP Tools
 *
 * Exposes Code Execution API functionality as MCP tools that clients can discover
 * and call directly. This enables progressive tool disclosure and efficient
 * token usage through the standard MCP protocol.
 */

import { BackendManager } from '../backend/index.js';
import { ToolDiscovery, DetailLevel, TOOL_CATEGORIES } from './tool-discovery.js';
import { CodeExecutor } from './executor.js';
import { SkillsManager } from './skills.js';
import { WorkspaceManager } from './workspace.js';
import { Aggregations } from './streaming.js';
import { getPIITokenizerForSession } from './pii-tokenizer.js';
import { optimizeApiResponse } from './response-optimizer.js';
import { getSessionContext, sessionContextManager } from './session-context.js';
import { SchemaDeduplicator } from './schema-dedup.js';
import { getDeltaManager, DeltaResponseManager } from './delta-response.js';

/**
 * Estimate tokens for a given object (roughly 4 chars per token)
 */
function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/**
 * Filter results by token budget
 */
function filterByTokenBudget(results: unknown[], budget: number): { items: unknown[]; truncated: boolean; tokensUsed: number } {
  let totalTokens = 0;
  const items: unknown[] = [];

  for (const item of results) {
    const itemTokens = estimateTokens(item);
    if (totalTokens + itemTokens > budget) {
      return { items, truncated: true, tokensUsed: totalTokens };
    }
    items.push(item);
    totalTokens += itemTokens;
  }

  return { items, truncated: false, tokensUsed: totalTokens };
}

export interface GatewayTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  inputExamples?: Record<string, unknown>[];
}

export interface GatewayToolsConfig {
  prefix?: string; // Default: 'gateway'
  enableCodeExecution?: boolean; // Default: true
  enableSkills?: boolean; // Default: true
}

/**
 * Creates gateway-level MCP tools for progressive disclosure and code execution
 */
export function createGatewayTools(
  backendManager: BackendManager,
  config: GatewayToolsConfig = {}
): { tools: GatewayTool[]; callTool: (name: string, args: unknown, ctx?: { sessionId?: string }) => Promise<unknown> } {
  const prefix = config.prefix ?? 'gateway';
  const enableCodeExecution = config.enableCodeExecution ?? true;
  const enableSkills = config.enableSkills ?? true;

  const toolDiscovery = new ToolDiscovery(backendManager);
  const codeExecutor = new CodeExecutor(backendManager);
  const workspaceManager = new WorkspaceManager();
  const skillsManager = new SkillsManager(workspaceManager, codeExecutor);
  const schemaDeduplicator = new SchemaDeduplicator();

  const tools: GatewayTool[] = [];

  const requireAllowlist = process.env.CODE_EXECUTION_REQUIRE_ALLOWLIST === '1';
  const allowedTools = (process.env.CODE_EXECUTION_ALLOWED_TOOLS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const allowedPrefixes = (process.env.CODE_EXECUTION_ALLOWED_TOOL_PREFIXES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const enforceToolAllowlist = requireAllowlist || allowedTools.length > 0 || allowedPrefixes.length > 0;
  const allowedToolNames = new Set(allowedTools);
  const isProgrammaticToolAllowed = (toolName: string): boolean => {
    if (!enforceToolAllowlist) return true;
    if (allowedToolNames.has(toolName)) return true;
    return allowedPrefixes.some(p => toolName.startsWith(p));
  };

  // ==================== Tool Discovery Tools ====================

  tools.push({
    name: `${prefix}_list_tool_names`,
    description:
      'List tool names with optional pagination and filtering. Use this first to discover what tools exist before loading schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: {
          type: 'string',
          description: 'Filter tools by backend server ID',
        },
        prefix: {
          type: 'string',
          description: 'Filter tools by tool name prefix',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tool names to return',
          default: 200,
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination',
          default: 0,
        },
      },
    },
    inputExamples: [
      { backend: 'mssql-prod', prefix: 'mssql_prod_', limit: 50, offset: 0 },
      { prefix: 'github_', limit: 200, offset: 0 },
    ],
  });

  tools.push({
    name: `${prefix}_search_tools`,
    description: 'Search and filter tools by name, description, backend, or category. Returns tools with configurable detail level.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against tool names and descriptions',
        },
        backend: {
          type: 'string',
          description: 'Filter tools by backend server ID',
        },
        category: {
          type: 'string',
          enum: Object.keys(TOOL_CATEGORIES),
          description: 'Filter tools by semantic category (database, filesystem, api, ai, search, transform, auth, messaging)',
        },
        detailLevel: {
          type: 'string',
          enum: ['name_only', 'name_description', 'compact_schema', 'full_schema', 'micro_schema'],
          description: 'Level of detail. Use name_only for minimal tokens, micro_schema for ultra-compact (60-70% savings).',
          default: 'name_description',
        },
        includeExamples: {
          type: 'boolean',
          description: 'Include input_examples if available (for improved accuracy)',
          default: false,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tools to return',
          default: 20,
        },
      },
    },
    inputExamples: [
      { query: 'sql', detailLevel: 'name_description', limit: 20 },
      { backend: 'mssql-prod', category: 'database', detailLevel: 'name_only', limit: 50 },
    ],
  });

  tools.push({
    name: `${prefix}_get_tool_schema`,
    description: 'Get the JSON schema for a specific tool. Use compact=true for ~40% savings, or mode="micro" for ~60-70% savings.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          description: 'Name of the tool to get schema for',
        },
        compact: {
          type: 'boolean',
          description: 'If true, returns schema with types only (no descriptions). Saves ~40% tokens.',
          default: false,
        },
        mode: {
          type: 'string',
          enum: ['full', 'compact', 'micro'],
          description: 'Schema mode: full (default), compact (~40% savings), micro (~60-70% savings with abbreviated types)',
        },
      },
      required: ['toolName'],
    },
    inputExamples: [
      { toolName: 'mssql_prod_execute_query', mode: 'micro' },
      { toolName: 'mssql_prod_execute_query', compact: true },
      { toolName: 'filesystem_read_file' },
    ],
  });

  tools.push({
    name: `${prefix}_get_tool_schemas`,
    description: 'Get schemas for multiple tools in a single request. More efficient than multiple get_tool_schema calls.',
    inputSchema: {
      type: 'object',
      properties: {
        toolNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tool names to get schemas for (max 20)',
        },
        compact: {
          type: 'boolean',
          description: 'If true, returns schemas with types only (no descriptions). Saves ~40% tokens.',
          default: false,
        },
        mode: {
          type: 'string',
          enum: ['full', 'compact', 'micro'],
          description: 'Schema mode: full (default), compact (~40% savings), micro (~60-70% savings)',
        },
      },
      required: ['toolNames'],
    },
    inputExamples: [
      { toolNames: ['mssql_prod_execute_query', 'mssql_prod_get_schema'], mode: 'micro' },
      { toolNames: ['mssql_prod_execute_query', 'mssql_prod_get_schema'], compact: true },
    ],
  });

  tools.push({
    name: `${prefix}_get_tool_categories`,
    description: 'Get available tool categories with tool counts. Use categories to filter tools in search_tools.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    inputExamples: [
      {},
    ],
  });

  tools.push({
    name: `${prefix}_get_tool_tree`,
    description: 'Get tools organized as a tree structure by backend. Useful for understanding the overall tool landscape.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    inputExamples: [
      {},
    ],
  });

  tools.push({
    name: `${prefix}_get_tool_stats`,
    description: 'Get statistics about available tools grouped by backend server.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    inputExamples: [
      {},
    ],
  });

  // ==================== Code Execution Tools ====================

  if (enableCodeExecution) {
    tools.push({
      name: `${prefix}_execute_code`,
      description: 'Execute TypeScript/JavaScript code in a sandboxed environment with access to all MCP tools. Use this to batch multiple tool calls efficiently. The sandbox auto-generates an SDK from available tools.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'TypeScript/JavaScript code to execute. Use await for async operations. Use console.log() to output results.',
          },
          timeout: {
            type: 'number',
            description: 'Execution timeout in milliseconds (1000-120000)',
            default: 30000,
          },
          context: {
            type: 'object',
            description: 'Additional context variables to inject into the sandbox',
          },
        },
        required: ['code'],
      },
      inputExamples: [
        {
          code: "const r = await callTool('gateway_search_tools', { query: 'sql', limit: 5 });\nconsole.log(r);",
          timeout: 30000,
        },
      ],
    });

    tools.push({
      name: `${prefix}_call_tool_filtered`,
      description: 'Call any tool with result filtering to reduce response size. Use maxRows, maxTokens, fields, and format options.',
      inputSchema: {
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            description: 'Name of the tool to call',
          },
          args: {
            type: 'object',
            description: 'Arguments to pass to the tool',
          },
          filter: {
            type: 'object',
            description: 'Filter options for the result',
            properties: {
              maxRows: {
                type: 'number',
                description: 'Maximum number of rows to return',
              },
              maxTokens: {
                type: 'number',
                description: 'Maximum approximate tokens in response (overrides maxRows if both set)',
              },
              fields: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific fields to include in results',
              },
              format: {
                type: 'string',
                enum: ['full', 'summary', 'sample'],
                description: 'Output format: full (all data), summary (count + sample), sample (first 5 items)',
              },
            },
          },
          smart: {
            type: 'boolean',
            description: 'Auto-apply summary filter when no filter provided. Set false for raw results.',
            default: true,
          },
        },
        required: ['toolName'],
      },
      inputExamples: [
        {
          toolName: 'database_execute_query',
          args: { query: "SELECT TOP 5 * FROM inventory.products WHERE status = 'active'" },
          filter: { format: 'summary', maxRows: 5 },
          smart: true,
        },
      ],
    });

    tools.push({
      name: `${prefix}_call_tool_aggregate`,
      description: 'Call any tool and apply aggregation to reduce large result sets. Supports count, sum, avg, min, max, groupBy, distinct.',
      inputSchema: {
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            description: 'Name of the tool to call',
          },
          args: {
            type: 'object',
            description: 'Arguments to pass to the tool',
          },
          aggregation: {
            type: 'object',
            description: 'Aggregation to apply',
            properties: {
              operation: {
                type: 'string',
                enum: ['count', 'sum', 'avg', 'min', 'max', 'groupBy', 'distinct'],
                description: 'Aggregation operation to perform',
              },
              field: {
                type: 'string',
                description: 'Field to aggregate on (required for sum, avg, min, max, distinct)',
              },
              groupByField: {
                type: 'string',
                description: 'Field to group by (for groupBy operation)',
              },
            },
            required: ['operation'],
          },
        },
        required: ['toolName', 'aggregation'],
      },
      inputExamples: [
        {
          toolName: 'database_execute_query',
          args: { query: "SELECT status, COUNT(*) as cnt FROM orders GROUP BY status" },
          aggregation: { operation: 'groupBy', groupByField: 'status' },
        },
      ],
    });

    tools.push({
      name: `${prefix}_call_tools_parallel`,
      description:
        'Execute multiple tool calls in parallel with optional per-call result filtering to reduce response size.',
      inputSchema: {
        type: 'object',
        properties: {
          calls: {
            type: 'array',
            description: 'Array of tool calls to execute in parallel',
            items: {
              type: 'object',
              properties: {
                toolName: { type: 'string' },
                args: { type: 'object' },
                filter: {
                  type: 'object',
                  description: 'Optional filter applied to this call result',
                  properties: {
                    maxRows: { type: 'number' },
                    fields: { type: 'array', items: { type: 'string' } },
                    format: { type: 'string', enum: ['full', 'summary', 'sample'] },
                  },
                },
                smart: {
                  type: 'boolean',
                  description: 'Auto-apply summary filter when no filter provided. Set false for raw results.',
                  default: true,
                },
              },
              required: ['toolName'],
            },
          },
        },
        required: ['calls'],
      },
      inputExamples: [
        {
          calls: [
            { toolName: 'gateway_search_tools', args: { query: 'mssql', limit: 5 }, smart: true },
            { toolName: 'gateway_get_tool_stats', args: {} },
          ],
        },
      ],
    });
  }

  // ==================== Skills Tools ====================

  if (enableSkills) {
    tools.push({
      name: `${prefix}_list_skills`,
      description: 'List all available skills (reusable code patterns). Skills are saved code snippets that can be executed with parameters.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      inputExamples: [
        {},
      ],
    });

    tools.push({
      name: `${prefix}_search_skills`,
      description: 'Search skills by name, description, or tags.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
      },
      inputExamples: [
        { query: 'sql' },
      ],
    });

    tools.push({
      name: `${prefix}_get_skill`,
      description: 'Get details of a specific skill including its code and input parameters.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name',
          },
        },
        required: ['name'],
      },
      inputExamples: [
        { name: 'my-skill' },
      ],
    });

    tools.push({
      name: `${prefix}_execute_skill`,
      description: 'Execute a saved skill with provided inputs.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name to execute',
          },
          inputs: {
            type: 'object',
            description: 'Input parameters for the skill',
          },
        },
        required: ['name'],
      },
      inputExamples: [
        { name: 'my-skill', inputs: { limit: 5 } },
      ],
    });

    tools.push({
      name: `${prefix}_create_skill`,
      description: 'Create a new reusable skill from code. Skills can be executed later with different inputs.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Unique skill name (lowercase, hyphens allowed)',
          },
          description: {
            type: 'string',
            description: 'What this skill does',
          },
          code: {
            type: 'string',
            description: 'TypeScript/JavaScript code for the skill',
          },
          inputs: {
            type: 'array',
            description: 'Input parameter definitions',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array'] },
                description: { type: 'string' },
                required: { type: 'boolean', default: true },
              },
            },
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorizing the skill',
          },
        },
        required: ['name', 'description', 'code'],
      },
      inputExamples: [
        {
          name: 'list-recent-orders',
          description: 'Fetch recent orders and print a summary',
          code: "const r = await callTool('database_query', { query: \"SELECT TOP 5 id, status FROM orders ORDER BY created_at DESC\" });\nconsole.log(r);",
          inputs: [{ name: 'limit', type: 'number', description: 'Max rows to fetch', required: false }],
          tags: ['database', 'query'],
        },
        {
          name: 'hello-world',
          description: 'A simple greeting skill',
          code: "console.log('Hello, ' + (inputs.name || 'World') + '!');",
          inputs: [{ name: 'name', type: 'string', description: 'Name to greet' }],
          tags: ['example'],
        },
      ],
    });
  }

  // ==================== Optimization Stats Tool ====================

  tools.push({
    name: `${prefix}_get_optimization_stats`,
    description: 'Get token optimization statistics for the current session including cache hits, duplicates avoided, and estimated savings.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    inputExamples: [
      {},
    ],
  });

  // ==================== Delta Response Tool ====================

  tools.push({
    name: `${prefix}_call_tool_delta`,
    description: 'Call a tool with delta response - only returns changes since last call. Saves 90%+ tokens for repeated/polling queries.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          description: 'Name of the tool to call',
        },
        args: {
          type: 'object',
          description: 'Arguments to pass to the tool',
        },
        idField: {
          type: 'string',
          description: 'For array results, the field to use as unique ID for smarter diffing (e.g., "id", "userId")',
        },
      },
      required: ['toolName'],
    },
    inputExamples: [
      { toolName: 'database_query', args: { query: 'SELECT * FROM users WHERE active = 1' }, idField: 'id' },
      { toolName: 'monitoring_get_status', args: {} },
    ],
  });

  // ==================== Tool Call Handler ====================

  async function callTool(name: string, args: unknown, ctx?: { sessionId?: string }): Promise<unknown> {
    const params = (args || {}) as Record<string, unknown>;
    const tokenizer = getPIITokenizerForSession(ctx?.sessionId);
    const sessionContext = getSessionContext(ctx?.sessionId);
    const deltaManager = getDeltaManager(ctx?.sessionId);

    // Optimization Stats
    if (name === `${prefix}_get_optimization_stats`) {
      const sessionStats = sessionContext.getStats();
      const aggregateStats = sessionContextManager.getAggregateStats();
      const dedupStats = schemaDeduplicator.getStats();

      return {
        session: {
          schemasInContext: sessionStats.schemasInContext,
          duplicatesAvoided: sessionStats.duplicatesAvoided,
          tokensSaved: sessionStats.tokensSaved,
          totalItemsSent: sessionStats.totalItemsSent,
        },
        schemaDeduplication: {
          uniqueSchemas: dedupStats.uniqueSchemas,
          totalSchemas: dedupStats.totalSchemas,
          duplicateSchemas: dedupStats.duplicateSchemas,
          estimatedTokensSaved: dedupStats.estimatedTokensSaved,
        },
        aggregate: {
          activeSessions: aggregateStats.activeSessions,
          totalDuplicatesAvoided: aggregateStats.totalDuplicatesAvoided,
          totalTokensSaved: aggregateStats.totalTokensSaved,
        },
      };
    }

    // Tool Discovery
    if (name === `${prefix}_list_tool_names`) {
      const backend = params.backend as string | undefined;
      const namePrefix = params.prefix as string | undefined;

      const rawLimit = params.limit as number | undefined;
      const rawOffset = params.offset as number | undefined;

      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 1000)
        : 200;
      const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset)
        ? Math.max(rawOffset, 0)
        : 0;

      const result = toolDiscovery.searchTools({
        backend,
        prefix: namePrefix,
        detailLevel: 'name_only',
        limit,
        offset,
      });

      return {
        names: result.tools.map(t => t.name),
        total: result.total,
        limit,
        offset,
        hasMore: result.hasMore,
      };
    }

    if (name === `${prefix}_search_tools`) {
      return toolDiscovery.searchTools({
        query: params.query as string | undefined,
        backend: params.backend as string | undefined,
        category: params.category as string | undefined,
        detailLevel: params.detailLevel as DetailLevel | undefined,
        includeExamples: params.includeExamples as boolean | undefined,
        limit: params.limit as number | undefined,
      });
    }

    if (name === `${prefix}_get_tool_schema`) {
      const toolName = params.toolName as string;
      const compact = params.compact as boolean | undefined;
      const mode = params.mode as 'full' | 'compact' | 'micro' | undefined;
      // Prefer mode if specified, otherwise fall back to compact boolean
      // 'full' mode is equivalent to false (default)
      const schemaMode = mode === 'full' ? false : (mode || (compact ? 'compact' : false));
      const schema = toolDiscovery.getToolSchema(toolName, schemaMode);
      if (!schema) {
        return { error: `Tool '${toolName}' not found` };
      }
      return { tool: schema };
    }

    if (name === `${prefix}_get_tool_schemas`) {
      const toolNames = params.toolNames as string[];
      const compact = params.compact as boolean | undefined;
      const mode = params.mode as 'full' | 'compact' | 'micro' | undefined;
      // Prefer mode if specified, otherwise fall back to compact boolean
      // 'full' mode is equivalent to false (default)
      const schemaMode = mode === 'full' ? false : (mode || (compact ? 'compact' : false));

      // Limit to 20 tools per request
      const limitedNames = toolNames.slice(0, 20);
      const result = toolDiscovery.getToolSchemas(limitedNames, schemaMode);

      return {
        tools: result.tools,
        notFound: result.notFound,
        count: result.tools.length,
        totalTokens: result.tools.reduce((sum, t) => sum + (t.estimatedTokens || 0), 0),
      };
    }

    if (name === `${prefix}_get_tool_categories`) {
      return {
        categories: toolDiscovery.getToolCategories(),
        availableCategories: Object.keys(TOOL_CATEGORIES),
      };
    }

    if (name === `${prefix}_get_tool_tree`) {
      return { tree: toolDiscovery.getToolTree() };
    }

    if (name === `${prefix}_get_tool_stats`) {
      return { stats: toolDiscovery.getToolStats() };
    }

    // Code Execution
    if (name === `${prefix}_execute_code` && enableCodeExecution) {
      const code = params.code as string;
      const timeout = params.timeout as number | undefined;
      const context = params.context as Record<string, unknown> | undefined;

      return await codeExecutor.execute(code, {
        timeout,
        context,
        captureConsole: true,
        sessionId: ctx?.sessionId,
      });
    }

    if (name === `${prefix}_call_tool_filtered` && enableCodeExecution) {
      const toolName = params.toolName as string;
      const toolArgs = tokenizer ? tokenizer.detokenizeObject(params.args || {}) : (params.args || {});
      const filter = params.filter as { maxRows?: number; fields?: string[]; format?: string } | undefined;
      const smart = params.smart as boolean | undefined;

      if (!isProgrammaticToolAllowed(toolName)) {
        return { success: false, error: `Tool not allowed for programmatic calls: ${toolName}` };
      }

      const response = await backendManager.callTool(toolName, toolArgs);
      if (response.error) {
        return { success: false, error: response.error.message };
      }

      let result = response.result;
      const effectiveFilter =
        filter ?? (smart !== false ? { maxRows: 20, format: 'summary' } : undefined);
      if (effectiveFilter) {
        result = applyResultFilter(result, effectiveFilter);
      }

      if (tokenizer) {
        result = tokenizer.tokenizeObject(result).result;
      }

      return { success: true, result };
    }

    if (name === `${prefix}_call_tool_aggregate` && enableCodeExecution) {
      const toolName = params.toolName as string;
      const toolArgs = tokenizer ? tokenizer.detokenizeObject(params.args || {}) : (params.args || {});
      const aggregation = params.aggregation as {
        operation: string;
        field?: string;
        groupByField?: string;
      };

      if (!isProgrammaticToolAllowed(toolName)) {
        return { success: false, error: `Tool not allowed for programmatic calls: ${toolName}` };
      }

      const response = await backendManager.callTool(toolName, toolArgs);
      if (response.error) {
        return { success: false, error: response.error.message };
      }

      const data = response.result as Record<string, unknown>[];
      let aggregated: unknown;

      switch (aggregation.operation) {
        case 'count':
          aggregated = Aggregations.count(data);
          break;
        case 'sum':
          aggregated = aggregation.field ? Aggregations.sum(data, aggregation.field) : 0;
          break;
        case 'avg':
          aggregated = aggregation.field ? Aggregations.avg(data, aggregation.field) : 0;
          break;
        case 'min':
          aggregated = aggregation.field ? Aggregations.min(data, aggregation.field) : null;
          break;
        case 'max':
          aggregated = aggregation.field ? Aggregations.max(data, aggregation.field) : null;
          break;
        case 'groupBy':
          aggregated = aggregation.groupByField ? Aggregations.groupBy(data, aggregation.groupByField) : {};
          break;
        case 'distinct':
          aggregated = aggregation.field ? Aggregations.distinct(data, aggregation.field) : [];
          break;
        default:
          aggregated = data;
      }

      const safeAggregated = tokenizer
        ? tokenizer.tokenizeObject(aggregated).result
        : aggregated;

      return { success: true, result: safeAggregated, operation: aggregation.operation };
    }

    if (name === `${prefix}_call_tools_parallel` && enableCodeExecution) {
      const calls = params.calls as Array<{
        toolName: string;
        args?: unknown;
        filter?: { maxRows?: number; fields?: string[]; format?: string };
        smart?: boolean;
      }>;

      for (const c of calls) {
        if (!isProgrammaticToolAllowed(c.toolName)) {
          return { success: false, error: `Tool not allowed for programmatic calls: ${c.toolName}` };
        }
      }

      // Ensure args is always present for type compatibility
      const normalizedCalls = calls.map(c => ({
        toolName: c.toolName,
        args: tokenizer ? tokenizer.detokenizeObject(c.args ?? {}) : (c.args ?? {}),
      }));
      const results = await backendManager.callToolsParallel(normalizedCalls);

      return {
        success: true,
        results: results.map((r, i) => {
          let result = r.result;
          const effectiveFilter =
            calls[i].filter ?? (calls[i].smart !== false ? { maxRows: 20, format: 'summary' } : undefined);

          if (effectiveFilter) {
            result = applyResultFilter(result, effectiveFilter);
          }

          if (tokenizer) {
            result = tokenizer.tokenizeObject(result).result;
          }

          return {
            toolName: calls[i].toolName,
            result,
            error: r.error?.message,
          };
        }),
      };
    }

    // Skills
    if (name === `${prefix}_list_skills` && enableSkills) {
      const skills = skillsManager.listSkills();
      return { skills, count: skills.length };
    }

    if (name === `${prefix}_search_skills` && enableSkills) {
      const query = params.query as string;
      const skills = skillsManager.searchSkills(query);
      return { skills, count: skills.length };
    }

    if (name === `${prefix}_get_skill` && enableSkills) {
      const skillName = params.name as string;
      const skill = skillsManager.getSkill(skillName);
      if (!skill) {
        return { error: `Skill '${skillName}' not found` };
      }
      return { skill };
    }

    if (name === `${prefix}_execute_skill` && enableSkills) {
      const skillName = params.name as string;
      const inputs = params.inputs as Record<string, unknown> || {};
      return await skillsManager.executeSkill(skillName, inputs, { sessionId: ctx?.sessionId });
    }

    if (name === `${prefix}_create_skill` && enableSkills) {
      const rawInputs = params.inputs as Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'object' | 'array';
        description?: string;
        required?: boolean;
        default?: unknown;
      }> || [];

      // Normalize inputs to ensure required is always a boolean
      const normalizedInputs = rawInputs.map(input => ({
        name: input.name,
        type: input.type,
        description: input.description,
        required: input.required ?? true,
        default: input.default,
      }));

      const skill = skillsManager.createSkill({
        name: params.name as string,
        description: params.description as string,
        code: params.code as string,
        version: '1.0.0',
        inputs: normalizedInputs,
        tags: (params.tags as string[]) || [],
      });
      return { success: true, skill };
    }

    // Delta Response Tool
    if (name === `${prefix}_call_tool_delta`) {
      const toolName = params.toolName as string;
      const toolArgs = params.args as Record<string, unknown> || {};
      const idField = params.idField as string | undefined;

      // Check if tool is allowed
      if (!isProgrammaticToolAllowed(toolName)) {
        return { error: `Tool '${toolName}' is not in the allowed list for programmatic access` };
      }

      // Find the backend and execute the tool
      const backendId = backendManager.getBackendForTool(toolName);
      if (!backendId) {
        return { error: `Tool '${toolName}' not found` };
      }

      const result = await backendManager.callTool(toolName, toolArgs);

      // Extract the actual data from the result
      let data: unknown;
      if (result && typeof result === 'object' && 'content' in result) {
        const content = (result as { content: Array<{ type: string; text?: string }> }).content;
        if (Array.isArray(content) && content.length > 0 && content[0].text) {
          try {
            data = JSON.parse(content[0].text);
          } catch {
            data = content[0].text;
          }
        } else {
          data = result;
        }
      } else {
        data = result;
      }

      // Generate delta key
      const deltaKey = DeltaResponseManager.generateKey(toolName, toolArgs);

      // Get delta response based on data type
      if (Array.isArray(data)) {
        return deltaManager.getDeltaForArray(deltaKey, data, idField);
      } else if (typeof data === 'object' && data !== null) {
        return deltaManager.getDeltaForObject(deltaKey, data as Record<string, unknown>);
      }

      // For primitive types, just return as-is
      return { isDelta: false, data, stateHash: '' };
    }

    return { error: `Unknown gateway tool: ${name}` };
  }

  return { tools, callTool };
}

/**
 * Apply filtering to tool results for context efficiency
 * Now includes default value omission for additional token savings
 */
function applyResultFilter(
  result: unknown,
  filter: { maxRows?: number; maxTokens?: number; fields?: string[]; format?: string; optimize?: boolean }
): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const { maxRows, maxTokens, fields, format, optimize = true } = filter;

  if (Array.isArray(result)) {
    let filtered = result;

    // Apply field selection first (before row limiting)
    if (fields && fields.length > 0) {
      filtered = filtered.map(row => {
        if (typeof row !== 'object' || row === null) return row;
        const selected: Record<string, unknown> = {};
        for (const field of fields) {
          if (field in (row as Record<string, unknown>)) {
            selected[field] = (row as Record<string, unknown>)[field];
          }
        }
        return selected;
      });
    }

    // Apply default value omission (strip nulls, empty strings, etc.)
    if (optimize) {
      filtered = optimizeApiResponse(filtered) as typeof filtered;
    }

    // Apply token budget if specified (takes precedence over maxRows)
    if (maxTokens && maxTokens > 0) {
      const tokenFiltered = filterByTokenBudget(filtered, maxTokens);
      if (format === 'summary') {
        return {
          count: result.length,
          sample: tokenFiltered.items.slice(0, 3),
          truncated: tokenFiltered.truncated,
          tokensUsed: tokenFiltered.tokensUsed,
        };
      }
      filtered = tokenFiltered.items as typeof filtered;
    } else if (maxRows && filtered.length > maxRows) {
      filtered = filtered.slice(0, maxRows);
    }

    if (format === 'summary') {
      return {
        count: result.length,
        sample: filtered.slice(0, 3),
        truncated: result.length > (maxRows || result.length),
        tokensUsed: estimateTokens(filtered.slice(0, 3)),
      };
    } else if (format === 'sample') {
      return filtered.slice(0, 5);
    }

    return filtered;
  }

  // Apply optimization to object results
  let objResult = result as Record<string, unknown>;
  if (optimize) {
    objResult = optimizeApiResponse(objResult);
  }

  if (objResult.content && Array.isArray(objResult.content)) {
    return {
      ...objResult,
      content: applyResultFilter(objResult.content, filter),
    };
  }

  return objResult;
}
