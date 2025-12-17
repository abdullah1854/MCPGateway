/**
 * Session Context Cache - Conversation-Aware Token Optimization
 *
 * Tracks what schemas and data have been sent in a session to avoid
 * resending information already in the AI's context window.
 *
 * This provides massive savings for multi-turn conversations where
 * the same tools are used repeatedly.
 */

import { createHash } from 'crypto';
import { logger } from '../logger.js';

export interface SentItem {
  hash: string;
  sentAt: number;
  type: 'schema' | 'result' | 'skill';
  name: string;
  tokens: number;
}

export interface SessionContextStats {
  totalItemsSent: number;
  totalTokensSent: number;
  schemasInContext: number;
  resultsInContext: number;
  skillsInContext: number;
  duplicatesAvoided: number;
  tokensSaved: number;
}

/**
 * Session context tracker for a single session
 */
export class SessionContext {
  private sentItems = new Map<string, SentItem>();
  private duplicatesAvoided = 0;
  private tokensSaved = 0;

  // Items older than this threshold might be out of context window
  private maxItemAge = 30 * 60 * 1000; // 30 minutes

  /**
   * Generate a content hash for deduplication
   */
  static hash(content: unknown): string {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return createHash('sha256').update(str).digest('hex').substring(0, 16);
  }

  /**
   * Estimate tokens for content
   */
  static estimateTokens(content: unknown): number {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return Math.ceil(str.length / 4);
  }

  /**
   * Check if an item has been sent in this session
   */
  hasBeenSent(hash: string): boolean {
    const item = this.sentItems.get(hash);
    if (!item) return false;

    // Check if item is too old (might be out of context window)
    if (Date.now() - item.sentAt > this.maxItemAge) {
      this.sentItems.delete(hash);
      return false;
    }

    return true;
  }

  /**
   * Check if a schema has been sent
   */
  hasSchemaBeenSent(toolName: string, schema: unknown): boolean {
    const hash = SessionContext.hash({ type: 'schema', name: toolName, schema });
    return this.hasBeenSent(hash);
  }

  /**
   * Check if a result pattern has been sent (for similar queries)
   */
  hasResultPatternBeenSent(toolName: string, args: unknown): boolean {
    const hash = SessionContext.hash({ type: 'result', name: toolName, args });
    return this.hasBeenSent(hash);
  }

  /**
   * Mark an item as sent
   */
  markSent(
    type: 'schema' | 'result' | 'skill',
    name: string,
    content: unknown
  ): void {
    const hash = SessionContext.hash({ type, name, content });
    const tokens = SessionContext.estimateTokens(content);

    this.sentItems.set(hash, {
      hash,
      sentAt: Date.now(),
      type,
      name,
      tokens,
    });

    // Prune old items to prevent memory growth
    this.pruneOldItems();
  }

  /**
   * Mark a schema as sent
   */
  markSchemaSent(toolName: string, schema: unknown): void {
    this.markSent('schema', toolName, schema);
  }

  /**
   * Mark a result as sent
   */
  markResultSent(toolName: string, args: unknown, result: unknown): void {
    this.markSent('result', toolName, { args, resultHash: SessionContext.hash(result) });
  }

  /**
   * Record that we avoided a duplicate
   */
  recordDuplicateAvoided(tokens: number): void {
    this.duplicatesAvoided++;
    this.tokensSaved += tokens;
  }

  /**
   * Get a reference to a previously sent item
   */
  getReference(type: 'schema' | 'result' | 'skill', name: string, content: unknown): string | null {
    const hash = SessionContext.hash({ type, name, content });
    const item = this.sentItems.get(hash);
    if (item && Date.now() - item.sentAt < this.maxItemAge) {
      return `[Previously sent: ${type}:${name}]`;
    }
    return null;
  }

  /**
   * Get optimized response - return reference if already sent, otherwise full content
   */
  getOptimizedContent<T>(
    type: 'schema' | 'result' | 'skill',
    name: string,
    content: T
  ): { content: T | string; wasCached: boolean; tokensSaved: number } {
    const hash = SessionContext.hash({ type, name, content });
    const tokens = SessionContext.estimateTokens(content);

    if (this.hasBeenSent(hash)) {
      this.recordDuplicateAvoided(tokens);
      return {
        content: `[See ${type} "${name}" sent earlier in conversation]`,
        wasCached: true,
        tokensSaved: tokens,
      };
    }

    this.markSent(type, name, content);
    return {
      content,
      wasCached: false,
      tokensSaved: 0,
    };
  }

  /**
   * Remove items that are likely out of context
   */
  private pruneOldItems(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [hash, item] of this.sentItems) {
      if (now - item.sentAt > this.maxItemAge) {
        toDelete.push(hash);
      }
    }

    for (const hash of toDelete) {
      this.sentItems.delete(hash);
    }
  }

  /**
   * Get session statistics
   */
  getStats(): SessionContextStats {
    let schemasInContext = 0;
    let resultsInContext = 0;
    let skillsInContext = 0;
    let totalTokensSent = 0;

    for (const item of this.sentItems.values()) {
      totalTokensSent += item.tokens;
      switch (item.type) {
        case 'schema':
          schemasInContext++;
          break;
        case 'result':
          resultsInContext++;
          break;
        case 'skill':
          skillsInContext++;
          break;
      }
    }

    return {
      totalItemsSent: this.sentItems.size,
      totalTokensSent,
      schemasInContext,
      resultsInContext,
      skillsInContext,
      duplicatesAvoided: this.duplicatesAvoided,
      tokensSaved: this.tokensSaved,
    };
  }

  /**
   * Clear session context
   */
  clear(): void {
    this.sentItems.clear();
    this.duplicatesAvoided = 0;
    this.tokensSaved = 0;
  }

  /**
   * Get list of schemas currently in context
   */
  getSchemasInContext(): string[] {
    return Array.from(this.sentItems.values())
      .filter(item => item.type === 'schema')
      .map(item => item.name);
  }
}

/**
 * Session context manager - manages contexts for multiple sessions
 */
class SessionContextManager {
  private sessions = new Map<string, SessionContext>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup old sessions every 10 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  /**
   * Get or create context for a session
   */
  getContext(sessionId: string | undefined): SessionContext {
    if (!sessionId) {
      // Return a new ephemeral context for requests without session ID
      return new SessionContext();
    }

    let context = this.sessions.get(sessionId);
    if (!context) {
      context = new SessionContext();
      this.sessions.set(sessionId, context);
      logger.debug(`Created session context: ${sessionId}`);
    }
    return context;
  }

  /**
   * Remove a session context
   */
  removeContext(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Cleanup old sessions
   */
  private cleanup(): void {
    // For now, just log stats - sessions clean themselves internally
    const sessionCount = this.sessions.size;
    if (sessionCount > 0) {
      logger.debug(`Session context manager: ${sessionCount} active sessions`);
    }
  }

  /**
   * Get aggregate stats across all sessions
   */
  getAggregateStats(): {
    activeSessions: number;
    totalDuplicatesAvoided: number;
    totalTokensSaved: number;
  } {
    let totalDuplicatesAvoided = 0;
    let totalTokensSaved = 0;

    for (const context of this.sessions.values()) {
      const stats = context.getStats();
      totalDuplicatesAvoided += stats.duplicatesAvoided;
      totalTokensSaved += stats.tokensSaved;
    }

    return {
      activeSessions: this.sessions.size,
      totalDuplicatesAvoided,
      totalTokensSaved,
    };
  }

  /**
   * Shutdown cleanup
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }
}

// Singleton instance
export const sessionContextManager = new SessionContextManager();

/**
 * Get session context for a given session ID
 */
export function getSessionContext(sessionId: string | undefined): SessionContext {
  return sessionContextManager.getContext(sessionId);
}
