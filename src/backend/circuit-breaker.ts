/**
 * Circuit Breaker Pattern for Backend Connections
 *
 * Prevents cascading failures when backends are unhealthy by:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Backend failing, requests fail fast without calling backend
 * - HALF_OPEN: Testing if backend recovered, limited requests allowed
 *
 * @see https://martinfowler.com/bliki/CircuitBreaker.html
 */

import { logger } from '../logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
    /** Number of consecutive failures before opening circuit */
    failureThreshold: number;
    /** Time in ms before attempting to close circuit (move to HALF_OPEN) */
    resetTimeout: number;
    /** Number of successful calls in HALF_OPEN before closing circuit */
    halfOpenSuccessThreshold: number;
    /** Time window in ms for counting failures (sliding window) */
    failureWindow: number;
}

export interface CircuitBreakerStats {
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailureTime: number | null;
    lastSuccessTime: number | null;
    openedAt: number | null;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 5,
    resetTimeout: 30000, // 30 seconds
    halfOpenSuccessThreshold: 2,
    failureWindow: 60000, // 1 minute
};

export class CircuitBreaker {
    private state: CircuitState = 'CLOSED';
    private failures: number = 0;
    private successes: number = 0;
    private failureTimestamps: number[] = [];
    private lastFailureTime: number | null = null;
    private lastSuccessTime: number | null = null;
    private openedAt: number | null = null;
    private config: CircuitBreakerConfig;
    private backendId: string;

    constructor(backendId: string, config: Partial<CircuitBreakerConfig> = {}) {
        this.backendId = backendId;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Check if a request should be allowed through
     */
    canExecute(): boolean {
        this.cleanupOldFailures();

        switch (this.state) {
            case 'CLOSED':
                return true;

            case 'OPEN':
                // Check if we should transition to HALF_OPEN
                if (this.openedAt && Date.now() - this.openedAt >= this.config.resetTimeout) {
                    this.transitionTo('HALF_OPEN');
                    return true;
                }
                return false;

            case 'HALF_OPEN':
                // Allow limited requests to test recovery
                return true;

            default:
                return true;
        }
    }

    /**
     * Record a successful call
     */
    recordSuccess(): void {
        this.lastSuccessTime = Date.now();

        switch (this.state) {
            case 'HALF_OPEN':
                this.successes++;
                if (this.successes >= this.config.halfOpenSuccessThreshold) {
                    this.transitionTo('CLOSED');
                }
                break;

            case 'CLOSED':
                // Reset failure count on success
                this.failures = 0;
                this.failureTimestamps = [];
                break;
        }
    }

    /**
     * Record a failed call
     */
    recordFailure(error?: Error): void {
        const now = Date.now();
        this.lastFailureTime = now;
        this.failureTimestamps.push(now);
        this.cleanupOldFailures();

        switch (this.state) {
            case 'CLOSED':
                this.failures = this.failureTimestamps.length;
                if (this.failures >= this.config.failureThreshold) {
                    this.transitionTo('OPEN');
                    logger.warn(`Circuit breaker OPENED for backend ${this.backendId}`, {
                        failures: this.failures,
                        threshold: this.config.failureThreshold,
                        error: error?.message,
                    });
                }
                break;

            case 'HALF_OPEN':
                // Any failure in HALF_OPEN immediately reopens the circuit
                this.transitionTo('OPEN');
                logger.warn(`Circuit breaker re-OPENED for backend ${this.backendId} (HALF_OPEN test failed)`, {
                    error: error?.message,
                });
                break;
        }
    }

    /**
     * Get current circuit breaker stats
     */
    getStats(): CircuitBreakerStats {
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            openedAt: this.openedAt,
        };
    }

    /**
     * Get current state
     */
    getState(): CircuitState {
        // Check for automatic transition before returning
        if (this.state === 'OPEN' && this.openedAt) {
            if (Date.now() - this.openedAt >= this.config.resetTimeout) {
                this.transitionTo('HALF_OPEN');
            }
        }
        return this.state;
    }

    /**
     * Reset the circuit breaker to CLOSED state
     */
    reset(): void {
        this.transitionTo('CLOSED');
        this.failures = 0;
        this.successes = 0;
        this.failureTimestamps = [];
        this.lastFailureTime = null;
        this.lastSuccessTime = null;
        this.openedAt = null;
    }

    /**
     * Transition to a new state
     */
    private transitionTo(newState: CircuitState): void {
        const oldState = this.state;
        this.state = newState;

        switch (newState) {
            case 'OPEN':
                this.openedAt = Date.now();
                this.successes = 0;
                break;

            case 'HALF_OPEN':
                this.successes = 0;
                logger.info(`Circuit breaker HALF_OPEN for backend ${this.backendId} (testing recovery)`);
                break;

            case 'CLOSED':
                this.openedAt = null;
                this.failures = 0;
                this.failureTimestamps = [];
                if (oldState !== 'CLOSED') {
                    logger.info(`Circuit breaker CLOSED for backend ${this.backendId} (recovered)`);
                }
                break;
        }
    }

    /**
     * Remove failure timestamps outside the failure window
     */
    private cleanupOldFailures(): void {
        const cutoff = Date.now() - this.config.failureWindow;
        this.failureTimestamps = this.failureTimestamps.filter(ts => ts > cutoff);
        this.failures = this.failureTimestamps.length;
    }
}

/**
 * Circuit Breaker Manager - manages circuit breakers for multiple backends
 */
export class CircuitBreakerManager {
    private breakers = new Map<string, CircuitBreaker>();
    private defaultConfig: Partial<CircuitBreakerConfig>;

    constructor(config: Partial<CircuitBreakerConfig> = {}) {
        this.defaultConfig = config;
    }

    /**
     * Get or create a circuit breaker for a backend
     */
    getBreaker(backendId: string): CircuitBreaker {
        let breaker = this.breakers.get(backendId);
        if (!breaker) {
            breaker = new CircuitBreaker(backendId, this.defaultConfig);
            this.breakers.set(backendId, breaker);
        }
        return breaker;
    }

    /**
     * Remove a circuit breaker for a backend
     */
    removeBreaker(backendId: string): void {
        this.breakers.delete(backendId);
    }

    /**
     * Get all circuit breaker stats
     */
    getAllStats(): Record<string, CircuitBreakerStats> {
        const stats: Record<string, CircuitBreakerStats> = {};
        for (const [id, breaker] of this.breakers) {
            stats[id] = breaker.getStats();
        }
        return stats;
    }

    /**
     * Reset all circuit breakers
     */
    resetAll(): void {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }
}
