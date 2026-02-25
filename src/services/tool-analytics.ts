/**
 * Tool Usage Analytics Service
 *
 * Tracks per-tool metrics: call count, success rate, latency distribution,
 * hourly aggregations, and backend load distribution.
 *
 * All data is in-memory with a configurable rolling window.
 */

export interface ToolCallRecord {
  toolName: string;
  backendId: string;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export interface ToolStats {
  name: string;
  backendId: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastCalledAt: number | null;
  callsPerHour: number[]; // last 24 hours, index 0 = current hour
}

export interface AnalyticsSummary {
  topTools: Array<{ name: string; calls: number }>;
  slowestTools: Array<{ name: string; avgMs: number }>;
  errorProneTools: Array<{ name: string; errorRate: number }>;
  backendLoad: Array<{ backendId: string; calls: number; percentage: number }>;
  totalCallsToday: number;
  totalCallsAllTime: number;
  hourlyDistribution: number[]; // 24 buckets
}

export interface ToolAnalyticsConfig {
  /** Max records to keep in memory */
  maxRecords: number;
}

const DEFAULT_CONFIG: ToolAnalyticsConfig = { maxRecords: 50_000 };

export class ToolAnalyticsService {
  private records: ToolCallRecord[] = [];
  private config: ToolAnalyticsConfig;
  private totalAllTime = 0;

  constructor(config?: Partial<ToolAnalyticsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  recordToolCall(
    toolName: string,
    backendId: string,
    durationMs: number,
    success: boolean,
  ): void {
    this.records.push({
      toolName,
      backendId,
      durationMs,
      success,
      timestamp: Date.now(),
    });
    this.totalAllTime++;

    // Trim if over max
    if (this.records.length > this.config.maxRecords) {
      this.records = this.records.slice(-Math.floor(this.config.maxRecords * 0.75));
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getToolStats(toolName: string): ToolStats | null {
    const records = this.records.filter(r => r.toolName === toolName);
    if (records.length === 0) return null;
    return this.computeToolStats(toolName, records);
  }

  getSummary(): AnalyticsSummary {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    // Group records by tool
    const byTool = new Map<string, ToolCallRecord[]>();
    const byBackend = new Map<string, number>();
    let todayCalls = 0;

    for (const r of this.records) {
      if (!byTool.has(r.toolName)) byTool.set(r.toolName, []);
      byTool.get(r.toolName)!.push(r);

      byBackend.set(r.backendId, (byBackend.get(r.backendId) ?? 0) + 1);

      if (r.timestamp >= todayMs) todayCalls++;
    }

    // Compute per-tool stats
    const toolStatsList: ToolStats[] = [];
    for (const [name, recs] of byTool) {
      toolStatsList.push(this.computeToolStats(name, recs));
    }

    // Top 10 most called
    const topTools = [...toolStatsList]
      .sort((a, b) => b.totalCalls - a.totalCalls)
      .slice(0, 10)
      .map(t => ({ name: t.name, calls: t.totalCalls }));

    // Top 10 slowest (min 5 calls)
    const slowestTools = [...toolStatsList]
      .filter(t => t.totalCalls >= 5)
      .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)
      .slice(0, 10)
      .map(t => ({ name: t.name, avgMs: Math.round(t.avgLatencyMs) }));

    // Top 10 error-prone (min 5 calls)
    const errorProneTools = [...toolStatsList]
      .filter(t => t.totalCalls >= 5 && t.errorCount > 0)
      .sort((a, b) => (b.errorCount / b.totalCalls) - (a.errorCount / a.totalCalls))
      .slice(0, 10)
      .map(t => ({
        name: t.name,
        errorRate: Math.round((t.errorCount / t.totalCalls) * 10000) / 100,
      }));

    // Backend load
    const totalCalls = this.records.length || 1;
    const backendLoad = [...byBackend.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([backendId, calls]) => ({
        backendId,
        calls,
        percentage: Math.round((calls / totalCalls) * 10000) / 100,
      }));

    // Hourly distribution (last 24h)
    const hourlyDistribution = new Array<number>(24).fill(0);
    const currentHour = new Date().getHours();
    for (const r of this.records) {
      const age = now - r.timestamp;
      if (age > 24 * 60 * 60 * 1000) continue;
      const recordHour = new Date(r.timestamp).getHours();
      // Offset so index 0 = current hour
      const offset = (recordHour - currentHour + 24) % 24;
      hourlyDistribution[offset]++;
    }

    return {
      topTools,
      slowestTools,
      errorProneTools,
      backendLoad,
      totalCallsToday: todayCalls,
      totalCallsAllTime: this.totalAllTime,
      hourlyDistribution,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private computeToolStats(name: string, records: ToolCallRecord[]): ToolStats {
    const backendId = records[records.length - 1]?.backendId ?? 'unknown';
    const durations = records.map(r => r.durationMs).sort((a, b) => a - b);
    const successCount = records.filter(r => r.success).length;
    const errorCount = records.length - successCount;
    const avgLatency = durations.reduce((s, d) => s + d, 0) / durations.length;
    const p95Index = Math.min(Math.floor(durations.length * 0.95), durations.length - 1);

    // Calls per hour (last 24h)
    const now = Date.now();
    const currentHour = new Date().getHours();
    const callsPerHour = new Array<number>(24).fill(0);
    for (const r of records) {
      const age = now - r.timestamp;
      if (age > 24 * 60 * 60 * 1000) continue;
      const recordHour = new Date(r.timestamp).getHours();
      const offset = (recordHour - currentHour + 24) % 24;
      callsPerHour[offset]++;
    }

    return {
      name,
      backendId,
      totalCalls: records.length,
      successCount,
      errorCount,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
      p95LatencyMs: durations[p95Index] ?? 0,
      lastCalledAt: records[records.length - 1]?.timestamp ?? null,
      callsPerHour,
    };
  }

  clear(): void {
    this.records = [];
    this.totalAllTime = 0;
  }
}
