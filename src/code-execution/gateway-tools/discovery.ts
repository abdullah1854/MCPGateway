import { ToolDiscovery, DetailLevel, TOOL_CATEGORIES } from '../tool-discovery.js';
import { GatewayTool, GatewayToolsConfig } from './types.js';

export function getDiscoveryTools(config: GatewayToolsConfig, liteMode: boolean): GatewayTool[] {
    const prefix = config.prefix ?? 'gateway';
    const tools: GatewayTool[] = [];

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

    // Non-essential tools - only in full mode
    if (!liteMode) {
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
    }

    return tools;
}

export async function handleDiscoveryToolCall(
    name: string,
    params: Record<string, unknown>,
    toolDiscovery: ToolDiscovery,
    config: GatewayToolsConfig
): Promise<unknown> {
    const prefix = config.prefix ?? 'gateway';

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

    return undefined; // Not handled
}
