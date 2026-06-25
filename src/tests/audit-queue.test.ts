import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLogger } from '../monitoring/audit.js';

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

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), 'audit-queue-'));
  const result = fn(dir);
  if (result instanceof Promise) {
    return result.finally(() => rmSync(dir, { recursive: true, force: true }));
  }
  rmSync(dir, { recursive: true, force: true });
  return result;
}

async function main(): Promise<void> {
  console.log('Running audit queue tests...\n');

  await runTest('AUDIT-QUEUE-001: file writes are queued and flushed in batches', async () =>
    withTempDir(async dir => {
      const logPath = join(dir, 'audit.log');
      const audit = new AuditLogger({
        logPath,
        batchSize: 2,
        flushIntervalMs: 60_000,
      });

      audit.log({ eventType: 'config_export', success: true, actor: 'tester' });
      audit.log({ eventType: 'auth_failure', success: false, actor: 'tester' });
      audit.log({ eventType: 'rate_limit_exceeded', success: false, ip: '127.0.0.1' });

      assert.equal(audit.getQueueStats().queued, 3);
      await audit.flush();

      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 3);
      assert.equal(audit.getQueueStats().queued, 0);
      assert.equal(audit.getQueueStats().dropped, 0);
      assert.equal(audit.getQueueStats().writeErrors, 0);
    }));

  await runTest('AUDIT-QUEUE-001: queue overflow increments drop counter', async () =>
    withTempDir(async dir => {
      const audit = new AuditLogger({
        logPath: join(dir, 'audit.log'),
        maxQueueSize: 2,
        flushIntervalMs: 60_000,
      });

      audit.log({ eventType: 'config_export', success: true });
      audit.log({ eventType: 'config_import', success: true, details: { serverCount: 1 } });
      audit.log({ eventType: 'auth_failure', success: false });

      assert.equal(audit.getQueueStats().queued, 2);
      assert.equal(audit.getQueueStats().dropped, 1);
      await audit.flush();

      const lines = readFileSync(join(dir, 'audit.log'), 'utf-8').trim().split('\n');
      assert.equal(lines.length, 2);
    }));

  await runTest('AUDIT-QUEUE-001: write failures increment error counter', async () =>
    withTempDir(async dir => {
      const audit = new AuditLogger({
        logPath: dir,
        flushIntervalMs: 60_000,
      });

      audit.log({ eventType: 'config_export', success: true });
      await audit.flush();

      assert.equal(audit.getQueueStats().queued, 0);
      assert.equal(audit.getQueueStats().writeErrors, 1);
    }));

  console.log(`\nAudit queue tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
