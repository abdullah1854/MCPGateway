/**
 * Prometheus Metrics
 *
 * Exposes metrics in Prometheus format for monitoring:
 * - Tool call latency
 * - Error rates per backend
 * - Request counts
 * - Token usage estimation
 */

import { Router, Request, Response } from 'express';
import { BackendManager } from '../backend/index.js';

interface ToolCallMetric {
  toolName: string;
  backend: string;
  duration: number;
  success: boolean;
  timestamp: number;
}

interface BackendMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalDuration: number;
  avgDuration: number;
  lastCallTime: number;
}

interface MetricsCollectorConfig {
  maxLatencySamples: number;
  maxBackendLabels: number;
}

const DEFAULT_METRICS_CONFIG: MetricsCollectorConfig = {
  maxLatencySamples: 10_000,
  maxBackendLabels: 100,
};
const OTHER_BACKEND_LABEL = '__other__';

class RingBuffer<T> {
  private readonly values: Array<T | undefined>;
  private nextIndex = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.values = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    if (this.capacity <= 0) {
      return;
    }
    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.nextIndex - this.count + i + this.capacity) % this.capacity;
      const value = this.values[index];
      if (value !== undefined) {
        result.push(value);
      }
    }
    return result;
  }

  clear(): void {
    this.values.fill(undefined);
    this.nextIndex = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}

/**
 * Metrics Collector - Tracks and exposes gateway metrics
 */
export class MetricsCollector {
  private toolCalls: RingBuffer<ToolCallMetric>;
  private backendLatency = new Map<string, RingBuffer<number>>();
  private backendMetrics = new Map<string, BackendMetrics>();
  private requestCount = 0;
  private errorCount = 0;
  private authFailureCount = 0;
  private rateLimitExceededCount = 0;
  private startTime = Date.now();
  private config: MetricsCollectorConfig;

  constructor(config?: Partial<MetricsCollectorConfig>) {
    this.config = { ...DEFAULT_METRICS_CONFIG, ...config };
    this.toolCalls = new RingBuffer<ToolCallMetric>(this.config.maxLatencySamples);
  }

  /**
   * Record a tool call
   */
  recordToolCall(
    toolName: string,
    backend: string,
    duration: number,
    success: boolean
  ): void {
    const metric: ToolCallMetric = {
      toolName,
      backend,
      duration,
      success,
      timestamp: Date.now(),
    };

    this.toolCalls.push(metric);

    // Update backend metrics
    this.updateBackendMetrics(backend, duration, success);
  }

  /**
   * Update aggregated backend metrics
   */
  private updateBackendMetrics(backend: string, duration: number, success: boolean): void {
    const backendLabel = this.boundBackendLabel(backend);
    let metrics = this.backendMetrics.get(backendLabel);

    if (!metrics) {
      metrics = {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalDuration: 0,
        avgDuration: 0,
        lastCallTime: 0,
      };
      this.backendMetrics.set(backendLabel, metrics);
    }

    let latency = this.backendLatency.get(backendLabel);
    if (!latency) {
      latency = new RingBuffer<number>(this.config.maxLatencySamples);
      this.backendLatency.set(backendLabel, latency);
    }
    latency.push(duration);

    metrics.totalCalls++;
    metrics.totalDuration += duration;
    metrics.avgDuration = metrics.totalDuration / metrics.totalCalls;
    metrics.lastCallTime = Date.now();

    if (success) {
      metrics.successfulCalls++;
    } else {
      metrics.failedCalls++;
    }
  }

  /**
   * Record a request
   */
  recordRequest(isError: boolean = false): void {
    this.requestCount++;
    if (isError) {
      this.errorCount++;
    }
  }

  /**
   * Record an authentication failure
   */
  recordAuthFailure(): void {
    this.authFailureCount++;
  }

  /**
   * Record a rate limit hit
   */
  recordRateLimitExceeded(): void {
    this.rateLimitExceededCount++;
  }

  /**
   * Get metrics for a specific backend
   */
  getBackendMetrics(backend: string): BackendMetrics | undefined {
    return this.backendMetrics.get(backend);
  }

  /**
   * Get all backend metrics
   */
  getAllBackendMetrics(): Map<string, BackendMetrics> {
    return this.backendMetrics;
  }

  /**
   * Get tool call latency percentiles
   */
  getLatencyPercentiles(backend?: string): {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  } {
    const durations = backend
      ? (this.backendLatency.get(this.boundBackendLabel(backend))?.toArray() ?? [])
      : this.toolCalls.toArray().map(c => c.duration);

    return percentileSnapshot(durations);
  }

  /**
   * Get error rate
   */
  getErrorRate(): number {
    return this.requestCount > 0 ? this.errorCount / this.requestCount : 0;
  }

  /**
   * Estimate token usage for a request
   */
  estimateTokens(data: unknown): number {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    // Rough estimation: ~4 characters per token
    return Math.ceil(str.length / 4);
  }

  /**
   * Generate Prometheus format metrics
   */
  generatePrometheusMetrics(backendManager: BackendManager): string {
    const lines: string[] = [];
    const now = Date.now();

    // Help and type declarations
    lines.push('# HELP mcp_gateway_uptime_seconds Gateway uptime in seconds');
    lines.push('# TYPE mcp_gateway_uptime_seconds gauge');
    lines.push(`mcp_gateway_uptime_seconds ${(now - this.startTime) / 1000}`);

    lines.push('');
    lines.push('# HELP mcp_gateway_requests_total Total number of requests');
    lines.push('# TYPE mcp_gateway_requests_total counter');
    lines.push(`mcp_gateway_requests_total ${this.requestCount}`);

    lines.push('');
    lines.push('# HELP mcp_gateway_errors_total Total number of errors');
    lines.push('# TYPE mcp_gateway_errors_total counter');
    lines.push(`mcp_gateway_errors_total ${this.errorCount}`);

    lines.push('');
    lines.push('# HELP mcp_gateway_auth_failures_total Total number of authentication failures');
    lines.push('# TYPE mcp_gateway_auth_failures_total counter');
    lines.push(`mcp_gateway_auth_failures_total ${this.authFailureCount}`);

    lines.push('');
    lines.push('# HELP mcp_gateway_rate_limit_exceeded_total Total number of rate limit violations');
    lines.push('# TYPE mcp_gateway_rate_limit_exceeded_total counter');
    lines.push(`mcp_gateway_rate_limit_exceeded_total ${this.rateLimitExceededCount}`);

    lines.push('');
    lines.push('# HELP mcp_gateway_error_rate Current error rate');
    lines.push('# TYPE mcp_gateway_error_rate gauge');
    lines.push(`mcp_gateway_error_rate ${this.getErrorRate()}`);

    // Backend metrics
    lines.push('');
    lines.push('# HELP mcp_backend_calls_total Total calls per backend');
    lines.push('# TYPE mcp_backend_calls_total counter');
    for (const [backend, metrics] of this.backendMetrics) {
      lines.push(`mcp_backend_calls_total{backend="${escapeLabelValue(backend)}"} ${metrics.totalCalls}`);
    }

    lines.push('');
    lines.push('# HELP mcp_backend_errors_total Errors per backend');
    lines.push('# TYPE mcp_backend_errors_total counter');
    for (const [backend, metrics] of this.backendMetrics) {
      lines.push(`mcp_backend_errors_total{backend="${escapeLabelValue(backend)}"} ${metrics.failedCalls}`);
    }

    lines.push('');
    lines.push('# HELP mcp_backend_latency_avg_ms Average latency per backend in ms');
    lines.push('# TYPE mcp_backend_latency_avg_ms gauge');
    for (const [backend, metrics] of this.backendMetrics) {
      lines.push(`mcp_backend_latency_avg_ms{backend="${escapeLabelValue(backend)}"} ${metrics.avgDuration.toFixed(2)}`);
    }

    // Latency percentiles
    const percentiles = this.getLatencyPercentiles();
    lines.push('');
    lines.push('# HELP mcp_tool_latency_ms Tool call latency percentiles');
    lines.push('# TYPE mcp_tool_latency_ms summary');
    lines.push(`mcp_tool_latency_ms{quantile="0.5"} ${percentiles.p50}`);
    lines.push(`mcp_tool_latency_ms{quantile="0.9"} ${percentiles.p90}`);
    lines.push(`mcp_tool_latency_ms{quantile="0.95"} ${percentiles.p95}`);
    lines.push(`mcp_tool_latency_ms{quantile="0.99"} ${percentiles.p99}`);

    // Backend status
    const status = backendManager.getStatus();
    lines.push('');
    lines.push('# HELP mcp_backend_connected Backend connection status (1=connected, 0=disconnected)');
    lines.push('# TYPE mcp_backend_connected gauge');
    const statusEntries = Object.entries(status).slice(0, this.config.maxBackendLabels);
    for (const [backend, info] of statusEntries) {
      const connected = info.status === 'connected' ? 1 : 0;
      lines.push(`mcp_backend_connected{backend="${escapeLabelValue(backend)}"} ${connected}`);
    }
    if (Object.keys(status).length > statusEntries.length) {
      lines.push(`mcp_backend_connected_overflow_total ${Object.keys(status).length - statusEntries.length}`);
    }

    // Tool counts
    lines.push('');
    lines.push('# HELP mcp_tools_total Total number of tools');
    lines.push('# TYPE mcp_tools_total gauge');
    lines.push(`mcp_tools_total ${backendManager.getAllTools().length}`);

    lines.push('');
    lines.push('# HELP mcp_tools_enabled Number of enabled tools');
    lines.push('# TYPE mcp_tools_enabled gauge');
    lines.push(`mcp_tools_enabled ${backendManager.getEnabledTools().length}`);

    return lines.join('\n');
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    uptime: number;
    requestCount: number;
    errorCount: number;
    errorRate: number;
    authFailures: number;
    rateLimitExceeded: number;
    backends: Record<string, BackendMetrics>;
    latency: { p50: number; p90: number; p95: number; p99: number };
  } {
    return {
      uptime: Date.now() - this.startTime,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      errorRate: this.getErrorRate(),
      authFailures: this.authFailureCount,
      rateLimitExceeded: this.rateLimitExceededCount,
      backends: Object.fromEntries(this.backendMetrics),
      latency: this.getLatencyPercentiles(),
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.backendMetrics.clear();
    this.requestCount = 0;
    this.errorCount = 0;
    this.authFailureCount = 0;
    this.rateLimitExceededCount = 0;
    this.startTime = Date.now();
    this.toolCalls.clear();
    this.backendLatency.clear();
  }

  getRetainedToolCallCount(): number {
    return this.toolCalls.size;
  }

  private boundBackendLabel(backend: string): string {
    if (this.backendMetrics.has(backend)) {
      return backend;
    }
    if (this.backendMetrics.size < this.config.maxBackendLabels) {
      return backend;
    }
    return OTHER_BACKEND_LABEL;
  }
}

function percentileSnapshot(values: number[]): { p50: number; p90: number; p95: number; p99: number } {
  if (values.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.min(Math.floor(sorted.length * 0.5), sorted.length - 1)] ?? 0,
    p90: sorted[Math.min(Math.floor(sorted.length * 0.9), sorted.length - 1)] ?? 0,
    p95: sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)] ?? 0,
    p99: sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)] ?? 0,
  };
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Create metrics routes
 */
export function createMetricsRoutes(
  backendManager: BackendManager,
  metricsCollector: MetricsCollector
): Router {
  const router = Router();

  // Prometheus format metrics
  router.get('/metrics', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(metricsCollector.generatePrometheusMetrics(backendManager));
  });

  // JSON format metrics
  router.get('/metrics/json', (_req: Request, res: Response) => {
    res.json(metricsCollector.getSummary());
  });

  // Reset metrics (requires confirmation - for testing/admin use only)
  router.post('/metrics/reset', (req: Request, res: Response) => {
    const { confirm } = req.body;

    if (confirm !== 'reset-confirmed') {
      res.status(400).json({
        success: false,
        error: 'Metrics reset requires confirmation. Send { "confirm": "reset-confirmed" }',
      });
      return;
    }

    metricsCollector.reset();
    res.json({ success: true, message: 'Metrics reset' });
  });

  return router;
}
