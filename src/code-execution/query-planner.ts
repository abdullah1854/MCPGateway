/**
 * Query Planning & Auto-Optimization - Layer 15
 *
 * Analyzes code before execution to:
 * - Detect redundant tool calls
 * - Identify parallelization opportunities
 * - Suggest optimizations
 * - Warn about inefficient patterns
 */

export interface ToolCall {
  name: string;
  args: string;
  line: number;
  isAsync: boolean;
  isAwaited: boolean;
}

export interface OptimizationSuggestion {
  type: 'parallel' | 'cache' | 'batch' | 'filter' | 'redundant' | 'order';
  severity: 'info' | 'warning' | 'error';
  message: string;
  line?: number;
  originalCode?: string;
  suggestedCode?: string;
  estimatedSavings?: string;
}

export interface QueryPlan {
  /** Detected tool calls */
  toolCalls: ToolCall[];
  /** Optimization suggestions */
  suggestions: OptimizationSuggestion[];
  /** Whether code can be auto-optimized */
  canOptimize: boolean;
  /** Optimized code (if canOptimize is true) */
  optimizedCode?: string;
  /** Estimated improvement */
  estimatedImprovement?: {
    timeReduction: string;
    tokenReduction: string;
  };
  /** Warnings about the code */
  warnings: string[];
}

/**
 * Extract tool calls from code
 */
function extractToolCalls(code: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // Match patterns like: await toolName(...) or toolName.call(...)
  const patterns = [
    // await tool.method(args)
    /(?:const|let|var)?\s*\w*\s*=?\s*(await)?\s*(\w+)\.(\w+)\s*\(([^)]*)\)/g,
    // await callTool('name', args)
    /(?:const|let|var)?\s*\w*\s*=?\s*(await)?\s*callTool\s*\(\s*['"](\w+)['"]\s*,?\s*([^)]*)\)/g,
    // await mcp.toolName(args)
    /(?:const|let|var)?\s*\w*\s*=?\s*(await)?\s*mcp\.(\w+)\s*\(([^)]*)\)/g,
  ];

  const lines = code.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;

      while ((match = pattern.exec(line)) !== null) {
        const isAwaited = match[1] === 'await';
        const toolName = match[2] || match[3];
        const args = match[match.length - 1] || '';

        calls.push({
          name: toolName,
          args: args.trim(),
          line: lineNum + 1,
          isAsync: true, // Assume all tool calls are async
          isAwaited,
        });
      }
    }
  }

  return calls;
}

/**
 * Detect redundant/duplicate tool calls
 */
function detectRedundantCalls(calls: ToolCall[]): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];
  const seen = new Map<string, ToolCall>();

  for (const call of calls) {
    const key = `${call.name}:${call.args}`;
    const existing = seen.get(key);

    if (existing) {
      suggestions.push({
        type: 'redundant',
        severity: 'warning',
        message: `Duplicate tool call: ${call.name} with same arguments on lines ${existing.line} and ${call.line}. Consider caching the result.`,
        line: call.line,
        suggestedCode: `// Cache result from line ${existing.line} instead of calling again`,
        estimatedSavings: '50-100% for this call',
      });
    } else {
      seen.set(key, call);
    }
  }

  return suggestions;
}

/**
 * Detect parallelization opportunities
 */
function detectParallelOpportunities(_code: string, calls: ToolCall[]): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];

  // Find sequential awaits that could be parallelized
  const sequentialAwaits: ToolCall[][] = [];
  let currentGroup: ToolCall[] = [];

  for (const call of calls) {
    if (call.isAwaited) {
      currentGroup.push(call);
    } else {
      if (currentGroup.length > 1) {
        sequentialAwaits.push([...currentGroup]);
      }
      currentGroup = [];
    }
  }

  if (currentGroup.length > 1) {
    sequentialAwaits.push(currentGroup);
  }

  // Analyze each group for independence
  for (const group of sequentialAwaits) {
    if (group.length < 2) continue;

    // Check if calls are independent (simple heuristic: different tool names or no shared variables)
    const toolNames = group.map(c => c.name);
    const uniqueTools = new Set(toolNames);

    if (uniqueTools.size === group.length) {
      // All different tools - likely independent
      const lines = group.map(c => c.line).join(', ');
      const toolList = group.map(c => c.name).join(', ');

      suggestions.push({
        type: 'parallel',
        severity: 'info',
        message: `Sequential awaits on lines ${lines} (${toolList}) could potentially run in parallel with Promise.all().`,
        line: group[0].line,
        suggestedCode: `const [${group.map((_, i) => `result${i + 1}`).join(', ')}] = await Promise.all([
  ${group.map(c => `${c.name}(${c.args})`).join(',\n  ')}
]);`,
        estimatedSavings: `${Math.round((1 - 1 / group.length) * 100)}% time reduction`,
      });
    }
  }

  return suggestions;
}

/**
 * Detect missing result filtering
 */
function detectFilteringOpportunities(_code: string, calls: ToolCall[]): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];

  // Look for database/query tools that might benefit from filtering
  const queryTools = calls.filter(c =>
    c.name.includes('query') ||
    c.name.includes('select') ||
    c.name.includes('get') ||
    c.name.includes('list') ||
    c.name.includes('fetch')
  );

  for (const call of queryTools) {
    // Check if SELECT * pattern
    if (call.args.includes('SELECT *') || call.args.includes('select *')) {
      suggestions.push({
        type: 'filter',
        severity: 'warning',
        message: `SELECT * on line ${call.line} returns all columns. Consider selecting only needed fields to reduce token usage.`,
        line: call.line,
        estimatedSavings: '30-70% token reduction',
      });
    }

    // Check if no LIMIT clause
    if (
      (call.args.toLowerCase().includes('select') || call.args.toLowerCase().includes('from')) &&
      !call.args.toLowerCase().includes('limit') &&
      !call.args.toLowerCase().includes('top')
    ) {
      suggestions.push({
        type: 'filter',
        severity: 'info',
        message: `Query on line ${call.line} has no LIMIT clause. Consider adding a limit to prevent large result sets.`,
        line: call.line,
        estimatedSavings: 'Variable - depends on data size',
      });
    }
  }

  return suggestions;
}

/**
 * Detect potential batching opportunities
 */
function detectBatchingOpportunities(calls: ToolCall[]): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];

  // Group calls by tool name
  const toolGroups = new Map<string, ToolCall[]>();
  for (const call of calls) {
    const existing = toolGroups.get(call.name) || [];
    existing.push(call);
    toolGroups.set(call.name, existing);
  }

  // Look for tools called multiple times with different args
  for (const [toolName, group] of toolGroups) {
    if (group.length >= 3) {
      const lines = group.map(c => c.line).join(', ');
      suggestions.push({
        type: 'batch',
        severity: 'info',
        message: `Tool '${toolName}' is called ${group.length} times (lines ${lines}). Consider batching these calls if the tool supports it, or using code execution to process results together.`,
        estimatedSavings: '40-60% round-trip reduction',
      });
    }
  }

  return suggestions;
}

/**
 * Check for common anti-patterns
 */
function detectAntiPatterns(code: string): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];

  // N+1 query pattern
  if (code.includes('for') && code.includes('await') && code.includes('.query')) {
    suggestions.push({
      type: 'batch',
      severity: 'warning',
      message: 'Potential N+1 query pattern detected (await inside loop). Consider fetching all data in a single query with JOINs or WHERE IN clause.',
      estimatedSavings: '80-95% reduction for large datasets',
    });
  }

  // Fetching all then filtering
  if (code.includes('.filter(') && (code.includes('.query') || code.includes('.fetch'))) {
    suggestions.push({
      type: 'filter',
      severity: 'info',
      message: 'Data appears to be fetched then filtered in JavaScript. Consider applying filters in the query/API call instead.',
      estimatedSavings: '50-90% token reduction',
    });
  }

  // Multiple schema loads
  const schemaMatches = code.match(/get.*schema|schema.*get/gi);
  if (schemaMatches && schemaMatches.length > 3) {
    suggestions.push({
      type: 'cache',
      severity: 'info',
      message: `Multiple schema loads detected (${schemaMatches.length}). Consider caching schemas or using batch schema loading.`,
      estimatedSavings: '60-80% token reduction',
    });
  }

  return suggestions;
}

/**
 * Generate optimized code (when possible)
 */
function generateOptimizedCode(
  _code: string,
  _calls: ToolCall[],
  suggestions: OptimizationSuggestion[]
): { canOptimize: boolean; optimizedCode?: string } {
  // For now, we only auto-optimize simple parallelization cases
  const parallelSuggestions = suggestions.filter(s => s.type === 'parallel');

  if (parallelSuggestions.length === 0) {
    return { canOptimize: false };
  }

  // Simple case: if we have exactly one parallel suggestion and it's straightforward
  // In a real implementation, this would be much more sophisticated
  // For now, just return the suggestion

  return {
    canOptimize: false, // Conservative - don't auto-modify code
  };
}

/**
 * Analyze code and generate query plan
 */
export function analyzeCode(code: string): QueryPlan {
  const toolCalls = extractToolCalls(code);
  const suggestions: OptimizationSuggestion[] = [];
  const warnings: string[] = [];

  // Detect various optimization opportunities
  suggestions.push(...detectRedundantCalls(toolCalls));
  suggestions.push(...detectParallelOpportunities(code, toolCalls));
  suggestions.push(...detectFilteringOpportunities(code, toolCalls));
  suggestions.push(...detectBatchingOpportunities(toolCalls));
  suggestions.push(...detectAntiPatterns(code));

  // Sort by severity
  const severityOrder = { error: 0, warning: 1, info: 2 };
  suggestions.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Check if code can be auto-optimized
  const { canOptimize, optimizedCode } = generateOptimizedCode(code, toolCalls, suggestions);

  // Generate warnings
  if (toolCalls.length > 10) {
    warnings.push(`High number of tool calls (${toolCalls.length}). Consider using code batching.`);
  }

  const unawaited = toolCalls.filter(c => !c.isAwaited);
  if (unawaited.length > 0) {
    warnings.push(`${unawaited.length} async tool call(s) not awaited. Results may be lost.`);
  }

  // Estimate improvement
  let estimatedImprovement;
  if (suggestions.length > 0) {
    const parallelCount = suggestions.filter(s => s.type === 'parallel').length;
    const redundantCount = suggestions.filter(s => s.type === 'redundant').length;

    if (parallelCount > 0 || redundantCount > 0) {
      estimatedImprovement = {
        timeReduction: parallelCount > 0 ? `Up to ${parallelCount * 30}%` : 'Minimal',
        tokenReduction: redundantCount > 0 ? `Up to ${redundantCount * 20}%` : 'Minimal',
      };
    }
  }

  return {
    toolCalls,
    suggestions,
    canOptimize,
    optimizedCode,
    estimatedImprovement,
    warnings,
  };
}

/**
 * Quick check if code has optimization opportunities
 */
export function hasOptimizationOpportunities(code: string): boolean {
  const plan = analyzeCode(code);
  return plan.suggestions.length > 0 || plan.warnings.length > 0;
}

/**
 * Get a summary of the query plan
 */
export function getQueryPlanSummary(plan: QueryPlan): string {
  const parts: string[] = [];

  parts.push(`Found ${plan.toolCalls.length} tool calls.`);

  if (plan.suggestions.length > 0) {
    const byType = plan.suggestions.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const typeSummary = Object.entries(byType)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');

    parts.push(`Optimization opportunities: ${typeSummary}.`);
  } else {
    parts.push('No optimization opportunities detected.');
  }

  if (plan.warnings.length > 0) {
    parts.push(`Warnings: ${plan.warnings.join(' ')}`);
  }

  if (plan.estimatedImprovement) {
    parts.push(
      `Estimated improvement: ${plan.estimatedImprovement.timeReduction} time, ${plan.estimatedImprovement.tokenReduction} tokens.`
    );
  }

  return parts.join(' ');
}
