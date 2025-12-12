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
): { tools: GatewayTool[]; callTool: (name: string, args: unknown) => Promise<unknown> } {
  const prefix = config.prefix ?? 'gateway';
  const enableCodeExecution = config.enableCodeExecution ?? true;
  const enableSkills = config.enableSkills ?? true;

  const toolDiscovery = new ToolDiscovery(backendManager);
  const codeExecutor = new CodeExecutor(backendManager);
  const workspaceManager = new WorkspaceManager();
  const skillsManager = new SkillsManager(workspaceManager, codeExecutor);

  const tools: GatewayTool[] = [];

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
          enum: ['name_only', 'name_description', 'compact_schema', 'full_schema'],
          description: 'Level of detail. Use name_only for minimal tokens, compact_schema for types without descriptions.',
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
  });

  tools.push({
    name: `${prefix}_get_tool_schema`,
    description: 'Get the JSON schema for a specific tool. Use compact=true to save ~40% tokens.',
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
      },
      required: ['toolName'],
    },
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
      },
      required: ['toolNames'],
    },
  });

  tools.push({
    name: `${prefix}_get_tool_categories`,
    description: 'Get available tool categories with tool counts. Use categories to filter tools in search_tools.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  });

  tools.push({
    name: `${prefix}_get_tool_tree`,
    description: 'Get tools organized as a tree structure by backend. Useful for understanding the overall tool landscape.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  });

  tools.push({
    name: `${prefix}_get_tool_stats`,
    description: 'Get statistics about available tools grouped by backend server.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
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
    });
  }

  // ==================== Tool Call Handler ====================

  async function callTool(name: string, args: unknown): Promise<unknown> {
    const params = (args || {}) as Record<string, unknown>;

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
      const schema = toolDiscovery.getToolSchema(toolName, compact);
      if (!schema) {
        return { error: `Tool '${toolName}' not found` };
      }
      return { tool: schema };
    }

    if (name === `${prefix}_get_tool_schemas`) {
      const toolNames = params.toolNames as string[];
      const compact = params.compact as boolean | undefined;

      // Limit to 20 tools per request
      const limitedNames = toolNames.slice(0, 20);
      const result = toolDiscovery.getToolSchemas(limitedNames, compact);

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
      });
    }

    if (name === `${prefix}_call_tool_filtered` && enableCodeExecution) {
      const toolName = params.toolName as string;
      const toolArgs = params.args || {};
      const filter = params.filter as { maxRows?: number; fields?: string[]; format?: string } | undefined;
      const smart = params.smart as boolean | undefined;

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

      return { success: true, result };
    }

    if (name === `${prefix}_call_tool_aggregate` && enableCodeExecution) {
      const toolName = params.toolName as string;
      const toolArgs = params.args || {};
      const aggregation = params.aggregation as {
        operation: string;
        field?: string;
        groupByField?: string;
      };

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

      return { success: true, result: aggregated, operation: aggregation.operation };
    }

    if (name === `${prefix}_call_tools_parallel` && enableCodeExecution) {
      const calls = params.calls as Array<{
        toolName: string;
        args?: unknown;
        filter?: { maxRows?: number; fields?: string[]; format?: string };
        smart?: boolean;
      }>;

      // Ensure args is always present for type compatibility
      const normalizedCalls = calls.map(c => ({ toolName: c.toolName, args: c.args ?? {} }));
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
      return await skillsManager.executeSkill(skillName, inputs);
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

    return { error: `Unknown gateway tool: ${name}` };
  }

  return { tools, callTool };
}

/**
 * Apply filtering to tool results for context efficiency
 */
function applyResultFilter(
  result: unknown,
  filter: { maxRows?: number; maxTokens?: number; fields?: string[]; format?: string }
): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const { maxRows, maxTokens, fields, format } = filter;

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

  const objResult = result as Record<string, unknown>;
  if (objResult.content && Array.isArray(objResult.content)) {
    return {
      ...objResult,
      content: applyResultFilter(objResult.content, filter),
    };
  }

  return result;
}
