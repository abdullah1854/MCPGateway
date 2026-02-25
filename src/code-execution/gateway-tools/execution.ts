import { BackendManager } from '../../backend/index.js';
import { CodeExecutor } from '../executor.js';
import { getContextTracker } from '../context-tracker.js';
import { DeltaResponseManager, getDeltaManager } from '../delta-response.js';
import { SchemaDeduplicator } from '../schema-dedup.js';
import { getSessionContext, sessionContextManager } from '../session-context.js';
import { analyzeCode, getQueryPlanSummary } from '../query-planner.js';
import { getPIITokenizerForSession } from '../pii-tokenizer.js';
import { summarizeResponse } from '../response-summarizer.js';
import { Aggregations } from '../streaming.js';
import { GatewayTool, GatewayToolsConfig } from './types.js';
import { applyResultFilter } from './filtering.js';

export function getExecutionTools(config: GatewayToolsConfig, liteMode: boolean): GatewayTool[] {
    const prefix = config.prefix ?? 'gateway';
    const enableCodeExecution = config.enableCodeExecution ?? true;
    const tools: GatewayTool[] = [];

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
                    timeout: {
                        type: 'number',
                        description: 'Timeout in milliseconds (default: backend default)',
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

        // Non-essential code execution tools - only in full mode
        if (!liteMode) {
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
                                            maxTokens: { type: 'number', description: 'Maximum approximate tokens in response' },
                                            fields: { type: 'array', items: { type: 'string' } },
                                            format: { type: 'string', enum: ['full', 'summary', 'sample'] },
                                        },
                                    },
                                    smart: {
                                        type: 'boolean',
                                        description: 'Auto-apply summary filter when no filter provided. Set false for raw results.',
                                        default: true,
                                    },
                                    timeout: {
                                        type: 'number',
                                        description: 'Timeout in milliseconds for this specific call',
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

            // Optimization Tools
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

            tools.push({
                name: `${prefix}_get_context_status`,
                description: 'Get context window usage status including tokens used, warnings, and recommendations. Use this to monitor context and prevent overflow.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        contextLimit: {
                            type: 'number',
                            description: 'Override context limit (default: 128000 for Claude)',
                        },
                    },
                },
                inputExamples: [
                    {},
                    { contextLimit: 200000 },
                ],
            });

            // Response Summarization Tool
            tools.push({
                name: `${prefix}_call_tool_summarized`,
                description: 'Call a tool and auto-summarize large results. Extracts key insights, statistics, and sample data. Saves 60-90% tokens on large datasets.',
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
                        maxTokens: {
                            type: 'number',
                            description: 'Maximum tokens for the summary (default: 500)',
                        },
                        focusFields: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Fields to focus analysis on',
                        },
                    },
                    required: ['toolName'],
                },
                inputExamples: [
                    { toolName: 'database_query', args: { query: 'SELECT * FROM orders' }, maxTokens: 300 },
                    { toolName: 'api_fetch', args: { url: '/users' }, focusFields: ['status', 'role'] },
                ],
            });

            // Query Planning Tool
            tools.push({
                name: `${prefix}_analyze_code`,
                description: 'Analyze code before execution to detect optimization opportunities like parallelization, redundant calls, and missing filters.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            description: 'The code to analyze',
                        },
                    },
                    required: ['code'],
                },
                inputExamples: [
                    { code: 'const users = await db.query("SELECT * FROM users");\nconst orders = await db.query("SELECT * FROM orders");' },
                ],
            });
        }
    }

    return tools;
}

export async function handleExecutionToolCall(
    name: string,
    params: Record<string, unknown>,
    backendManager: BackendManager,
    codeExecutor: CodeExecutor,
    schemaDeduplicator: SchemaDeduplicator,
    isProgrammaticToolAllowed: (name: string) => boolean,
    config: GatewayToolsConfig,
    ctx?: { sessionId?: string }
): Promise<unknown> {
    const prefix = config.prefix ?? 'gateway';
    const enableCodeExecution = config.enableCodeExecution ?? true;

    if (!enableCodeExecution) return undefined;

    const tokenizer = getPIITokenizerForSession(ctx?.sessionId);
    const sessionContext = getSessionContext(ctx?.sessionId);
    const deltaManager = getDeltaManager(ctx?.sessionId);
    const contextTracker = getContextTracker(ctx?.sessionId);

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

    // Code Execution
    if (name === `${prefix}_execute_code`) {
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

    if (name === `${prefix}_call_tool_filtered`) {
        const toolName = params.toolName as string;
        const toolArgs = tokenizer ? tokenizer.detokenizeObject(params.args || {}) : (params.args || {});
        const filter = params.filter as { maxRows?: number; maxTokens?: number; fields?: string[]; format?: string } | undefined;
        const smart = params.smart as boolean | undefined;
        const timeout = params.timeout as number | undefined;

        if (!isProgrammaticToolAllowed(toolName)) {
            return { success: false, error: `Tool not allowed for programmatic calls: ${toolName}` };
        }

        // Auto-increase timeout for search/research tools if not specified
        const effectiveTimeout = timeout ?? (
            toolName.includes('search') || toolName.includes('research') || toolName.includes('perplexity')
                ? 60000
                : undefined
        );

        const response = await backendManager.callTool(toolName, toolArgs, effectiveTimeout);
        if (response.error) {
            return { success: false, error: response.error.message };
        }

        let result = response.result;

        // Safety: Hard limit to prevent token overflow if no filter is provided
        const safetyFilter = (smart === false && !filter)
            ? { maxTokens: 25000, format: 'summary' } // ~100k chars limit
            : undefined;

        const effectiveFilter =
            filter ?? safetyFilter ?? (smart !== false ? { maxRows: 20, format: 'summary' } : undefined);

        if (effectiveFilter) {
            result = applyResultFilter(result, effectiveFilter);
        }

        if (tokenizer) {
            result = tokenizer.tokenizeObject(result).result;
        }

        return { success: true, result };
    }

    if (name === `${prefix}_call_tool_aggregate`) {
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

    if (name === `${prefix}_call_tools_parallel`) {
        const calls = params.calls as Array<{
            toolName: string;
            args?: unknown;
            filter?: { maxRows?: number; maxTokens?: number; fields?: string[]; format?: string };
            smart?: boolean;
            timeout?: number;
        }>;

        for (const c of calls) {
            if (!isProgrammaticToolAllowed(c.toolName)) {
                return { success: false, error: `Tool not allowed for programmatic calls: ${c.toolName}` };
            }
        }

        // Execute calls in parallel with their respective timeouts
        const results = await Promise.all(calls.map(async (c) => {
            const toolArgs = tokenizer ? tokenizer.detokenizeObject(c.args ?? {}) : (c.args ?? {});

            // Auto-increase timeout for search/research tools if not specified
            const effectiveTimeout = c.timeout ?? (
                c.toolName.includes('search') || c.toolName.includes('research') || c.toolName.includes('perplexity')
                    ? 60000
                    : undefined
            );

            return backendManager.callTool(c.toolName, toolArgs, effectiveTimeout);
        }));

        return {
            success: true,
            results: results.map((r, i) => {
                let result = r.result;

                // Safety: Hard limit to prevent token overflow if no filter is provided
                const safetyFilter = (calls[i].smart === false && !calls[i].filter)
                    ? { maxTokens: 25000, format: 'summary' }
                    : undefined;

                const effectiveFilter =
                    calls[i].filter ?? safetyFilter ?? (calls[i].smart !== false ? { maxRows: 20, format: 'summary' } : undefined);

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

    // Context Status Tool
    if (name === `${prefix}_get_context_status`) {
        const contextLimit = params.contextLimit as number | undefined;
        if (contextLimit) {
            contextTracker.setContextLimit(contextLimit);
        }
        return contextTracker.getStatus();
    }

    // Summarized Tool Call
    if (name === `${prefix}_call_tool_summarized`) {
        const toolName = params.toolName as string;
        const toolArgs = params.args as Record<string, unknown> || {};
        const maxTokens = params.maxTokens as number | undefined;
        const focusFields = params.focusFields as string[] | undefined;

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

        // Track the result
        contextTracker.trackResult(toolName, data);

        // Summarize the response
        const summarized = summarizeResponse(data, {
            maxTokens: maxTokens || 500,
            focusFields,
        });

        return summarized;
    }

    // Code Analysis Tool
    if (name === `${prefix}_analyze_code`) {
        const code = params.code as string;
        if (!code) {
            return { error: 'Code parameter is required' };
        }

        const plan = analyzeCode(code);
        return {
            ...plan,
            summary: getQueryPlanSummary(plan),
        };
    }

    return undefined; // Not handled
}
