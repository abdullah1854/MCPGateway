import { optimizeApiResponse } from '../response-optimizer.js';

/**
 * Estimate tokens for a given object (roughly 4 chars per token)
 */
export function estimateTokens(obj: unknown): number {
    return Math.ceil(JSON.stringify(obj).length / 4);
}

/**
 * Filter results by token budget
 */
export function filterByTokenBudget(results: unknown[], budget: number): { items: unknown[]; truncated: boolean; tokensUsed: number } {
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

/**
 * Apply filtering to tool results for context efficiency
 * Now includes default value omission for additional token savings
 */
export function applyResultFilter(
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
