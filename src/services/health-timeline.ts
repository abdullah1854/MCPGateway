/**
 * Health Timeline Service
 *
 * Tracks backend health events over time, maintaining a rolling window
 * of events and computing uptime percentages over configurable windows.
 */

import { logger } from '../logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HealthEventType =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'circuit_open'
  | 'circuit_closed'
  | 'reconnect_attempt';

export interface HealthEvent {
  backendId: string;
  event: HealthEventType;
  timestamp: number;
  details?: string;
}

export interface BackendHealth {
  backendId: string;
  currentStatus: string;
  uptime1h: number;
  uptime24h: number;
  uptime7d: number;
  events: HealthEvent[];
  lastEventAt: number;
  consecutiveFailures: number;
}

export interface HealthTimelineConfig {
  /** Maximum number of events to retain (rolling window). Default: 1000 */
  maxEvents: number;
}

// ─── Time constants ──────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * TWENTY_FOUR_HOURS_MS;

// ─── Service ─────────────────────────────────────────────────────────────────

export class HealthTimelineService {
  private events: HealthEvent[] = [];
  private config: HealthTimelineConfig;

  /**
   * Tracks the latest known status per backend so we can compute uptime
   * without relying on external state.
   */
  private currentStatuses = new Map<string, string>();

  /** Consecutive failure counter per backend (errors without a subsequent connect). */
  private consecutiveFailures = new Map<string, number>();

  constructor(config?: Partial<HealthTimelineConfig>) {
    this.config = {
      maxEvents: config?.maxEvents ?? 1000,
    };
  }

  // ── Recording ────────────────────────────────────────────────────────────

  /**
   * Record a health event for a backend.
   */
  recordEvent(backendId: string, event: HealthEventType, details?: string): void {
    const entry: HealthEvent = {
      backendId,
      event,
      timestamp: Date.now(),
      details,
    };

    this.events.push(entry);

    // Enforce rolling window
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(this.events.length - this.config.maxEvents);
    }

    // Update derived state
    this.updateDerivedState(backendId, event);

    logger.debug(`Health event recorded: ${backendId} -> ${event}`, { details });
  }

  private updateDerivedState(backendId: string, event: HealthEventType): void {
    switch (event) {
      case 'connected':
      case 'circuit_closed':
        this.currentStatuses.set(backendId, 'connected');
        this.consecutiveFailures.set(backendId, 0);
        break;
      case 'disconnected':
        this.currentStatuses.set(backendId, 'disconnected');
        this.consecutiveFailures.set(
          backendId,
          (this.consecutiveFailures.get(backendId) ?? 0) + 1,
        );
        break;
      case 'error':
        this.currentStatuses.set(backendId, 'error');
        this.consecutiveFailures.set(
          backendId,
          (this.consecutiveFailures.get(backendId) ?? 0) + 1,
        );
        break;
      case 'circuit_open':
        this.currentStatuses.set(backendId, 'circuit_open');
        this.consecutiveFailures.set(
          backendId,
          (this.consecutiveFailures.get(backendId) ?? 0) + 1,
        );
        break;
      case 'reconnect_attempt':
        // Does not change status or failure count
        break;
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Get health information for a single backend.
   */
  getBackendHealth(backendId: string): BackendHealth {
    const backendEvents = this.events.filter(e => e.backendId === backendId);
    const now = Date.now();

    return {
      backendId,
      currentStatus: this.currentStatuses.get(backendId) ?? 'unknown',
      uptime1h: this.computeUptime(backendEvents, now - ONE_HOUR_MS, now),
      uptime24h: this.computeUptime(backendEvents, now - TWENTY_FOUR_HOURS_MS, now),
      uptime7d: this.computeUptime(backendEvents, now - SEVEN_DAYS_MS, now),
      events: backendEvents,
      lastEventAt: backendEvents.length > 0
        ? backendEvents[backendEvents.length - 1].timestamp
        : 0,
      consecutiveFailures: this.consecutiveFailures.get(backendId) ?? 0,
    };
  }

  /**
   * Get health information for all tracked backends.
   */
  getAllBackendHealth(): BackendHealth[] {
    const backendIds = new Set<string>();
    for (const e of this.events) {
      backendIds.add(e.backendId);
    }
    // Also include backends that have a status but may have been pruned from events
    for (const id of this.currentStatuses.keys()) {
      backendIds.add(id);
    }

    return Array.from(backendIds)
      .sort()
      .map(id => this.getBackendHealth(id));
  }

  /**
   * Return raw events, optionally filtered by backend.
   */
  getEvents(backendId?: string, limit?: number): HealthEvent[] {
    let result = backendId
      ? this.events.filter(e => e.backendId === backendId)
      : [...this.events];

    if (limit && limit > 0) {
      result = result.slice(-limit);
    }
    return result;
  }

  // ── Uptime calculation ───────────────────────────────────────────────────

  /**
   * Compute uptime percentage for a backend over [windowStart, windowEnd].
   *
   * Algorithm:
   *   Walk through events chronologically. Between each pair of timestamps the
   *   backend is in whatever state the *preceding* event put it in. We count
   *   time spent in "connected" state as uptime.
   *
   *   If there are no events in the window we assume the backend was in
   *   whatever state was active at the start of the window (or "unknown" if we
   *   have no data at all). "unknown" counts as downtime.
   */
  private computeUptime(
    backendEvents: HealthEvent[],
    windowStart: number,
    windowEnd: number,
  ): number {
    if (windowEnd <= windowStart) return 0;

    const windowDuration = windowEnd - windowStart;

    // Gather all events sorted by time (they should already be, but be safe)
    const sorted = [...backendEvents].sort((a, b) => a.timestamp - b.timestamp);

    // Determine the state at windowStart by finding the latest event before it
    let stateAtStart: string = 'unknown';
    for (const e of sorted) {
      if (e.timestamp <= windowStart) {
        stateAtStart = this.eventToStatus(e.event);
      } else {
        break;
      }
    }

    // Filter to events within the window
    const windowEvents = sorted.filter(
      e => e.timestamp > windowStart && e.timestamp <= windowEnd,
    );

    if (windowEvents.length === 0) {
      // No state changes in window; uptime depends entirely on the initial state
      return stateAtStart === 'connected' ? 100 : 0;
    }

    let uptimeMs = 0;
    let currentState = stateAtStart;
    let cursor = windowStart;

    for (const e of windowEvents) {
      const segmentDuration = e.timestamp - cursor;
      if (currentState === 'connected') {
        uptimeMs += segmentDuration;
      }
      currentState = this.eventToStatus(e.event);
      cursor = e.timestamp;
    }

    // Remaining time after last event in window
    const tailDuration = windowEnd - cursor;
    if (currentState === 'connected') {
      uptimeMs += tailDuration;
    }

    return Math.round((uptimeMs / windowDuration) * 10000) / 100; // 2 decimal places
  }

  /**
   * Map a HealthEventType to a simple status string for uptime tracking.
   */
  private eventToStatus(event: HealthEventType): string {
    switch (event) {
      case 'connected':
      case 'circuit_closed':
        return 'connected';
      case 'disconnected':
      case 'error':
      case 'circuit_open':
        return 'down';
      case 'reconnect_attempt':
        // A reconnect attempt doesn't change the status
        return 'down';
      default:
        return 'unknown';
    }
  }

  // ── Maintenance ──────────────────────────────────────────────────────────

  /**
   * Clear all events (useful for testing or manual resets).
   */
  clear(): void {
    this.events = [];
    this.currentStatuses.clear();
    this.consecutiveFailures.clear();
  }

  /**
   * Total number of events currently stored.
   */
  get eventCount(): number {
    return this.events.length;
  }
}
