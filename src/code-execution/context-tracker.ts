/**
 * Context Window Tracking - Layer 13
 *
 * Tracks cumulative token usage per session to prevent context overflow.
 * Provides warnings and recommendations as context fills up.
 */

import { logger } from '../logger.js';

export interface ContextUsage {
  /** Total tokens used in this session */
  tokensUsed: number;
  /** Estimated context limit */
  contextLimit: number;
  /** Percentage of context used */
  percentUsed: number;
  /** Warning level: null, 'low', 'medium', 'high', 'critical' */
  warning: 'low' | 'medium' | 'high' | 'critical' | null;
  /** Recommendation for the user */
  recommendation: string | null;
  /** Breakdown by category */
  breakdown: {
    schemas: number;
    results: number;
    code: number;
    other: number;
  };
  /** Recent token usage history */
  recentCalls: Array<{
    tool: string;
    tokens: number;
    timestamp: number;
  }>;
}

export interface TokenEntry {
  category: 'schema' | 'result' | 'code' | 'other';
  tool?: string;
  tokens: number;
  timestamp: number;
}

/**
 * Context tracker for a single session
 */
export class ContextTracker {
  private entries: TokenEntry[] = [];
  private contextLimit: number;
  private maxHistorySize = 100;

  // Warning thresholds
  private readonly THRESHOLDS = {
    low: 50,      // 50% - start being careful
    medium: 70,   // 70% - consider summarization
    high: 85,     // 85% - use micro schemas
    critical: 95, // 95% - stop non-essential calls
  };

  constructor(contextLimit = 128000) {
    this.contextLimit = contextLimit;
  }

  /**
   * Set context limit (different models have different limits)
   */
  setContextLimit(limit: number): void {
    this.contextLimit = limit;
  }

  /**
   * Estimate tokens from content
   */
  static estimateTokens(content: unknown): number {
    if (content === null || content === undefined) return 0;
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    // Rough estimate: ~4 chars per token for English text/JSON
    return Math.ceil(str.length / 4);
  }

  /**
   * Track token usage
   */
  track(category: TokenEntry['category'], tokens: number, tool?: string): void {
    this.entries.push({
      category,
      tool,
      tokens,
      timestamp: Date.now(),
    });

    // Prune old entries if too many
    if (this.entries.length > this.maxHistorySize * 2) {
      this.entries = this.entries.slice(-this.maxHistorySize);
    }
  }

  /**
   * Track schema loading
   */
  trackSchema(toolName: string, schema: unknown): void {
    const tokens = ContextTracker.estimateTokens(schema);
    this.track('schema', tokens, toolName);
  }

  /**
   * Track tool result
   */
  trackResult(toolName: string, result: unknown): void {
    const tokens = ContextTracker.estimateTokens(result);
    this.track('result', tokens, toolName);
  }

  /**
   * Track code execution
   */
  trackCode(code: string, result: unknown): void {
    const codeTokens = ContextTracker.estimateTokens(code);
    const resultTokens = ContextTracker.estimateTokens(result);
    this.track('code', codeTokens + resultTokens);
  }

  /**
   * Get total tokens used
   */
  getTotalTokens(): number {
    return this.entries.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  /**
   * Get breakdown by category
   */
  getBreakdown(): ContextUsage['breakdown'] {
    const breakdown = { schemas: 0, results: 0, code: 0, other: 0 };

    for (const entry of this.entries) {
      switch (entry.category) {
        case 'schema':
          breakdown.schemas += entry.tokens;
          break;
        case 'result':
          breakdown.results += entry.tokens;
          break;
        case 'code':
          breakdown.code += entry.tokens;
          break;
        default:
          breakdown.other += entry.tokens;
      }
    }

    return breakdown;
  }

  /**
   * Get warning level based on usage
   */
  getWarningLevel(percentUsed: number): ContextUsage['warning'] {
    if (percentUsed >= this.THRESHOLDS.critical) return 'critical';
    if (percentUsed >= this.THRESHOLDS.high) return 'high';
    if (percentUsed >= this.THRESHOLDS.medium) return 'medium';
    if (percentUsed >= this.THRESHOLDS.low) return 'low';
    return null;
  }

  /**
   * Get recommendation based on current usage
   */
  getRecommendation(percentUsed: number, breakdown: ContextUsage['breakdown']): string | null {
    if (percentUsed < this.THRESHOLDS.low) {
      return null;
    }

    const recommendations: string[] = [];

    if (percentUsed >= this.THRESHOLDS.critical) {
      recommendations.push('CRITICAL: Context nearly full. Complete current task or start new session.');
    } else if (percentUsed >= this.THRESHOLDS.high) {
      recommendations.push('Use micro_schema mode for all schema requests.');
      recommendations.push('Use delta responses for repeated queries.');
    } else if (percentUsed >= this.THRESHOLDS.medium) {
      recommendations.push('Consider using compact or micro schema modes.');
      if (breakdown.results > breakdown.schemas) {
        recommendations.push('Use result filtering (maxRows, fields) to reduce result size.');
      }
    } else {
      recommendations.push('Context usage is moderate. Continue with current approach.');
    }

    // Specific recommendations based on breakdown
    if (breakdown.schemas > this.contextLimit * 0.3) {
      recommendations.push('High schema usage: Use micro_schema or load schemas on-demand.');
    }
    if (breakdown.results > this.contextLimit * 0.4) {
      recommendations.push('High result usage: Use aggregations, filtering, or summarization.');
    }

    return recommendations.join(' ');
  }

  /**
   * Get recent call history
   */
  getRecentCalls(limit = 10): ContextUsage['recentCalls'] {
    return this.entries
      .filter(e => e.tool)
      .slice(-limit)
      .map(e => ({
        tool: e.tool!,
        tokens: e.tokens,
        timestamp: e.timestamp,
      }));
  }

  /**
   * Get full context usage status
   */
  getStatus(): ContextUsage {
    const tokensUsed = this.getTotalTokens();
    const percentUsed = Math.round((tokensUsed / this.contextLimit) * 100);
    const breakdown = this.getBreakdown();
    const warning = this.getWarningLevel(percentUsed);
    const recommendation = this.getRecommendation(percentUsed, breakdown);

    return {
      tokensUsed,
      contextLimit: this.contextLimit,
      percentUsed,
      warning,
      recommendation,
      breakdown,
      recentCalls: this.getRecentCalls(),
    };
  }

  /**
   * Check if we should warn before a potential large operation
   */
  shouldWarn(estimatedTokens: number): { warn: boolean; message: string | null } {
    const currentTokens = this.getTotalTokens();
    const projectedTokens = currentTokens + estimatedTokens;
    const projectedPercent = (projectedTokens / this.contextLimit) * 100;

    if (projectedPercent >= 100) {
      return {
        warn: true,
        message: `Operation would exceed context limit (${projectedPercent.toFixed(0)}% projected). Consider using filtering or summarization.`,
      };
    }

    if (projectedPercent >= this.THRESHOLDS.critical) {
      return {
        warn: true,
        message: `Operation would bring context to ${projectedPercent.toFixed(0)}%. Consider using micro_schema or delta responses.`,
      };
    }

    return { warn: false, message: null };
  }

  /**
   * Get suggested max tokens for next operation based on remaining budget
   */
  getSuggestedBudget(): number {
    const tokensUsed = this.getTotalTokens();
    const remaining = this.contextLimit - tokensUsed;
    // Suggest using at most 20% of remaining context per operation
    return Math.max(100, Math.floor(remaining * 0.2));
  }

  /**
   * Reset tracking (for new conversation)
   */
  reset(): void {
    this.entries = [];
    logger.debug('Context tracker reset');
  }

  /**
   * Get efficiency score (0-100)
   * Higher = more efficient use of context
   */
  getEfficiencyScore(): number {
    const breakdown = this.getBreakdown();
    const total = this.getTotalTokens();

    if (total === 0) return 100;

    // Penalize high schema usage (should use progressive disclosure)
    const schemaRatio = breakdown.schemas / total;
    const schemaPenalty = schemaRatio > 0.3 ? (schemaRatio - 0.3) * 50 : 0;

    // Penalize if results are too large relative to schemas
    const resultRatio = breakdown.results / total;
    const resultPenalty = resultRatio > 0.5 ? (resultRatio - 0.5) * 30 : 0;

    const score = Math.max(0, 100 - schemaPenalty - resultPenalty);
    return Math.round(score);
  }
}

/**
 * Session-scoped context tracker storage
 */
const sessionTrackers = new Map<string, ContextTracker>();

/**
 * Get context tracker for a session
 */
export function getContextTracker(sessionId: string | undefined): ContextTracker {
  if (!sessionId) {
    return new ContextTracker();
  }

  let tracker = sessionTrackers.get(sessionId);
  if (!tracker) {
    tracker = new ContextTracker();
    sessionTrackers.set(sessionId, tracker);
  }
  return tracker;
}

/**
 * Clear tracker for a session
 */
export function clearContextTracker(sessionId: string): void {
  sessionTrackers.delete(sessionId);
}

/**
 * Get aggregate stats across all sessions
 */
export function getAggregateContextStats(): {
  activeSessions: number;
  totalTokensTracked: number;
  averageUsagePercent: number;
} {
  let totalTokens = 0;
  let totalPercent = 0;

  for (const tracker of sessionTrackers.values()) {
    const status = tracker.getStatus();
    totalTokens += status.tokensUsed;
    totalPercent += status.percentUsed;
  }

  const count = sessionTrackers.size;
  return {
    activeSessions: count,
    totalTokensTracked: totalTokens,
    averageUsagePercent: count > 0 ? Math.round(totalPercent / count) : 0,
  };
}
