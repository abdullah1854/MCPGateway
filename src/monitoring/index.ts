/**
 * Monitoring & Observability Module
 *
 * Provides Prometheus metrics, latency tracking, error rates,
 * and audit logging for the MCP Gateway.
 */

export { MetricsCollector, createMetricsRoutes } from './metrics.js';
export { AuditLogger } from './audit.js';
export type { AuditEvent, AuditEventType } from './audit.js';
