import assert from 'node:assert/strict';
import { MetricsCollector } from '../monitoring/metrics.js';
import { ToolAnalyticsService } from '../services/tool-analytics.js';

let failures = 0;

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    process.stdout.write(`• ${name}... `);
    await fn();
    console.log('ok');
  } catch (error) {
    console.log('FAILED');
    console.error(error);
    failures += 1;
    process.exitCode = 1;
  }
}

function backendManagerWithStatuses(count: number) {
  const status: Record<string, { status: 'connected' }> = {};
  for (let i = 0; i < count; i++) {
    status[`backend-${i}`] = { status: 'connected' };
  }
  return {
    getStatus: () => status,
    getAllTools: () => [],
    getEnabledTools: () => [],
  };
}

async function main(): Promise<void> {
  console.log('Running observability cost-control tests...\n');

  await runTest('OBS-001: metrics latency samples are retained in a bounded ring buffer', () => {
    const metrics = new MetricsCollector({ maxLatencySamples: 5, maxBackendLabels: 10 });
    for (let i = 1; i <= 20; i++) {
      metrics.recordToolCall('tool', 'backend-a', i, true);
    }

    assert.equal(metrics.getRetainedToolCallCount(), 5);
    assert.deepEqual(metrics.getLatencyPercentiles(), { p50: 18, p90: 20, p95: 20, p99: 20 });
  });

  await runTest('OBS-001: backend labels are capped and overflow aggregates are used', () => {
    const metrics = new MetricsCollector({ maxLatencySamples: 10, maxBackendLabels: 2 });
    metrics.recordToolCall('tool-a', 'backend-a', 10, true);
    metrics.recordToolCall('tool-b', 'backend-b', 20, true);
    metrics.recordToolCall('tool-c', 'backend-c', 30, false);

    const all = metrics.getAllBackendMetrics();
    assert.equal(all.has('backend-a'), true);
    assert.equal(all.has('backend-b'), true);
    assert.equal(all.has('__other__'), true);
    assert.equal(all.size, 3);

    const prometheus = metrics.generatePrometheusMetrics(backendManagerWithStatuses(5) as never);
    assert.match(prometheus, /mcp_backend_connected_overflow_total 3/);
    assert.doesNotMatch(prometheus, /backend-4/);
  });

  await runTest('OBS-001: tool analytics keeps a stable-size ring buffer', () => {
    const analytics = new ToolAnalyticsService({ maxRecords: 3 });
    for (let i = 0; i < 10; i++) {
      analytics.recordToolCall(`tool-${i}`, 'backend-a', i + 1, true);
    }

    assert.equal(analytics.getRetainedRecordCount(), 3);
    assert.equal(analytics.getSummary().totalCallsAllTime, 10);
    assert.equal(analytics.getToolStats('tool-0'), null);
    assert.equal(analytics.getToolStats('tool-9')?.totalCalls, 1);
  });

  console.log(`\nObservability cost-control tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
