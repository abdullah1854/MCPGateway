/**
 * Audit Logging
 *
 * Tracks sensitive operations for security compliance and debugging.
 */

import { existsSync, mkdirSync } from 'fs';
import { appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type AuditEventType =
  | 'server_add'
  | 'server_delete'
  | 'server_edit'
  | 'tool_call'
  | 'tool_enable'
  | 'tool_disable'
  | 'backend_enable'
  | 'backend_disable'
  | 'code_execute'
  | 'config_export'
  | 'config_import'
  | 'auth_success'
  | 'auth_failure'
  | 'rate_limit_exceeded';

export interface AuditEvent {
  timestamp: Date;
  eventType: AuditEventType;
  actor?: string;
  ip?: string;
  target?: string;
  details?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
}

export interface AuditQueueStats {
  queued: number;
  dropped: number;
  writeErrors: number;
  flushing: boolean;
}

export interface AuditLoggerOptions {
  logPath?: string;
  persistToFile?: boolean;
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
}

/**
 * Audit Logger - Tracks and persists sensitive operations
 */
export class AuditLogger {
  private logPath: string;
  private inMemoryLog: AuditEvent[] = [];
  private maxInMemory = 1000;
  private persistToFile: boolean;
  private fileQueue: string[] = [];
  private maxQueueSize: number;
  private batchSize: number;
  private flushIntervalMs: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private droppedEvents = 0;
  private writeErrors = 0;

  constructor(options?: AuditLoggerOptions) {
    this.logPath = options?.logPath ?? join(__dirname, '../../logs/audit.log');
    this.persistToFile = options?.persistToFile ?? true;
    this.maxQueueSize = options?.maxQueueSize ?? 10_000;
    this.batchSize = options?.batchSize ?? 100;
    this.flushIntervalMs = options?.flushIntervalMs ?? 100;

    if (this.persistToFile) {
      const logDir = dirname(this.logPath);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    }
  }

  /**
   * Log an audit event
   */
  log(event: Omit<AuditEvent, 'timestamp'>): void {
    const fullEvent: AuditEvent = {
      ...event,
      timestamp: new Date(),
    };

    // Store in memory
    this.inMemoryLog.push(fullEvent);
    if (this.inMemoryLog.length > this.maxInMemory) {
      this.inMemoryLog = this.inMemoryLog.slice(-this.maxInMemory / 2);
    }

    // Log to application logger
    const logLevel = event.success ? 'info' : 'warn';
    logger[logLevel](`Audit: ${event.eventType}`, {
      actor: event.actor,
      target: event.target,
      success: event.success,
      details: event.details,
    });

    // Persist to file
    if (this.persistToFile) {
      this.enqueueFileWrite(fullEvent);
    }
  }

  /**
   * Append event to audit log file
   */
  private enqueueFileWrite(event: AuditEvent): void {
    if (this.fileQueue.length >= this.maxQueueSize) {
      this.droppedEvents++;
      logger.error('Audit log queue overflow', {
        eventType: event.eventType,
        dropped: this.droppedEvents,
        queued: this.fileQueue.length,
      });
      return;
    }

    this.fileQueue.push(JSON.stringify(event) + '\n');
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushPromise) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(error => {
        logger.error('Audit flush failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }

    this.flushPromise = this.flushQueuedEvents();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async flushQueuedEvents(): Promise<void> {
    while (this.fileQueue.length > 0) {
      const batch = this.fileQueue.splice(0, this.batchSize);
      try {
        await appendFile(this.logPath, batch.join(''), 'utf-8');
      } catch (error) {
        this.writeErrors += batch.length;
        logger.error('Failed to write audit log', {
          error: error instanceof Error ? error.message : String(error),
          writeErrors: this.writeErrors,
        });
      }
    }
  }

  getQueueStats(): AuditQueueStats {
    return {
      queued: this.fileQueue.length,
      dropped: this.droppedEvents,
      writeErrors: this.writeErrors,
      flushing: this.flushPromise !== null,
    };
  }

  /**
   * Log server addition
   */
  logServerAdd(serverId: string, actor?: string, ip?: string): void {
    this.log({
      eventType: 'server_add',
      actor,
      ip,
      target: serverId,
      success: true,
    });
  }

  /**
   * Log server deletion
   */
  logServerDelete(serverId: string, actor?: string, ip?: string): void {
    this.log({
      eventType: 'server_delete',
      actor,
      ip,
      target: serverId,
      success: true,
    });
  }

  /**
   * Log server edit
   */
  logServerEdit(serverId: string, changes: Record<string, unknown>, actor?: string, ip?: string): void {
    this.log({
      eventType: 'server_edit',
      actor,
      ip,
      target: serverId,
      details: { changes },
      success: true,
    });
  }

  /**
   * Log tool call
   */
  logToolCall(
    toolName: string,
    success: boolean,
    duration: number,
    actor?: string,
    ip?: string,
    errorMessage?: string
  ): void {
    this.log({
      eventType: 'tool_call',
      actor,
      ip,
      target: toolName,
      details: { duration },
      success,
      errorMessage,
    });
  }

  /**
   * Log code execution
   */
  logCodeExecution(
    codeHash: string,
    success: boolean,
    duration: number,
    actor?: string,
    ip?: string,
    errorMessage?: string
  ): void {
    this.log({
      eventType: 'code_execute',
      actor,
      ip,
      target: codeHash,
      details: { duration },
      success,
      errorMessage,
    });
  }

  /**
   * Log authentication attempt
   */
  logAuth(success: boolean, method: string, actor?: string, ip?: string, errorMessage?: string): void {
    this.log({
      eventType: success ? 'auth_success' : 'auth_failure',
      actor,
      ip,
      details: { method },
      success,
      errorMessage,
    });
  }

  /**
   * Log rate limit exceeded
   */
  logRateLimitExceeded(ip: string, endpoint: string): void {
    this.log({
      eventType: 'rate_limit_exceeded',
      ip,
      target: endpoint,
      success: false,
    });
  }

  /**
   * Log config export
   */
  logConfigExport(actor?: string, ip?: string): void {
    this.log({
      eventType: 'config_export',
      actor,
      ip,
      success: true,
    });
  }

  /**
   * Log config import
   */
  logConfigImport(serverCount: number, actor?: string, ip?: string): void {
    this.log({
      eventType: 'config_import',
      actor,
      ip,
      details: { serverCount },
      success: true,
    });
  }

  /**
   * Get recent audit events
   */
  getRecentEvents(limit: number = 100, eventType?: AuditEventType): AuditEvent[] {
    let events = this.inMemoryLog;

    if (eventType) {
      events = events.filter(e => e.eventType === eventType);
    }

    return events.slice(-limit).reverse();
  }

  /**
   * Get events by time range
   */
  getEventsByTimeRange(startTime: Date, endTime: Date): AuditEvent[] {
    return this.inMemoryLog.filter(
      e => e.timestamp >= startTime && e.timestamp <= endTime
    );
  }

  /**
   * Get event counts by type
   */
  getEventCounts(): Record<AuditEventType, number> {
    const counts: Record<string, number> = {};

    for (const event of this.inMemoryLog) {
      counts[event.eventType] = (counts[event.eventType] || 0) + 1;
    }

    return counts as Record<AuditEventType, number>;
  }

  /**
   * Clear in-memory log (file log persists)
   */
  clearInMemory(): void {
    this.inMemoryLog = [];
  }
}
