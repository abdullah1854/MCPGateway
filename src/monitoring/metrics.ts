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

/**
 * Metrics Collector - Tracks and exposes gateway metrics
 */
export class MetricsCollector {
  private toolCalls: ToolCallMetric[] = [];
  private backendMetrics = new Map<string, BackendMetrics>();
  private requestCount = 0;
  private errorCount = 0;
  private startTime = Date.now();
  private maxHistorySize = 10000;

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

    // Trim history if too large
    if (this.toolCalls.length > this.maxHistorySize) {
      this.toolCalls = this.toolCalls.slice(-this.maxHistorySize / 2);
    }

    // Update backend metrics
    this.updateBackendMetrics(backend, duration, success);
  }

  /**
   * Update aggregated backend metrics
   */
  private updateBackendMetrics(backend: string, duration: number, success: boolean): void {
    let metrics = this.backendMetrics.get(backend);

    if (!metrics) {
      metrics = {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalDuration: 0,
        avgDuration: 0,
        lastCallTime: 0,
      };
      this.backendMetrics.set(backend, metrics);
    }

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
    let calls = this.toolCalls;

    if (backend) {
      calls = calls.filter(c => c.backend === backend);
    }

    if (calls.length === 0) {
      return { p50: 0, p90: 0, p95: 0, p99: 0 };
    }

    const durations = calls.map(c => c.duration).sort((a, b) => a - b);

    return {
      p50: durations[Math.floor(durations.length * 0.5)] || 0,
      p90: durations[Math.floor(durations.length * 0.9)] || 0,
      p95: durations[Math.floor(durations.length * 0.95)] || 0,
      p99: durations[Math.floor(durations.length * 0.99)] || 0,
    };
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
    lines.push('# HELP mcp_gateway_error_rate Current error rate');
    lines.push('# TYPE mcp_gateway_error_rate gauge');
    lines.push(`mcp_gateway_error_rate ${this.getErrorRate()}`);

    // Backend metrics
    lines.push('');
    lines.push('# HELP mcp_backend_calls_total Total calls per backend');
    lines.push('# TYPE mcp_backend_calls_total counter');
    for (const [backend, metrics] of this.backendMetrics) {
      lines.push(`mcp_backend_calls_total{backend="${backend}"} ${metrics.totalCalls}`);
    }

    lines.push('');
    lines.push('# HELP mcp_backend_errors_total Errors per backend');
    lines.push('# TYPE mcp_backend_errors_total counter');
    for (const [backend, metrics] of this.backendMetrics) {
      lines.push(`mcp_backend_errors_total{backend="${backend}"} ${metrics.failedCalls}`);
    }

    lines.push('');
    lines.push('# HELP mcp_backend_latency_avg_ms Average latency per backend in ms');
    lines.push('# TYPE mcp_backend_latency_avg_ms gauge');
    for (const [backend, metrics] of this.backendMetrics) {
      lines.push(`mcp_backend_latency_avg_ms{backend="${backend}"} ${metrics.avgDuration.toFixed(2)}`);
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
    for (const [backend, info] of Object.entries(status)) {
      const connected = info.status === 'connected' ? 1 : 0;
      lines.push(`mcp_backend_connected{backend="${backend}"} ${connected}`);
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
    backends: Record<string, BackendMetrics>;
    latency: { p50: number; p90: number; p95: number; p99: number };
  } {
    return {
      uptime: Date.now() - this.startTime,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      errorRate: this.getErrorRate(),
      backends: Object.fromEntries(this.backendMetrics),
      latency: this.getLatencyPercentiles(),
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.toolCalls = [];
    this.backendMetrics.clear();
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
  }
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
