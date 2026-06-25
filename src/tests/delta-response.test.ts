import { strict as assert } from 'assert';
import { applyDelta, DeltaPatch, DeltaResponseManager } from '../code-execution/delta-response.js';

let failures = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`• ${name}... `);
  try {
    await fn();
    console.log('ok');
  } catch (error) {
    failures++;
    console.log('FAILED');
    console.error(error);
  }
}

async function main(): Promise<void> {
  console.log('Running delta response tests...\n');

  await runTest('DELTA-001: generated keys use recursive canonical arguments', () => {
    const a = DeltaResponseManager.generateKey('orders', { filter: { b: 2, a: 1 } });
    const b = DeltaResponseManager.generateKey('orders', { filter: { a: 1, b: 2 } });

    assert.equal(a, b);
  });

  await runTest('DELTA-002: repeated arrays return compact unchanged delta', () => {
    const manager = new DeltaResponseManager();
    const key = DeltaResponseManager.generateKey('inventory', { warehouse: 'sg' });
    const data = [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }];

    const first = manager.getDeltaForArray(key, data);
    const second = manager.getDeltaForArray(key, data);

    assert.equal(first.isDelta, false);
    assert.equal(second.isDelta, true);
    assert.deepEqual(second.data, { type: 'full', previousHash: first.stateHash });
  });

  await runTest('DELTA-003: positional array deltas can reconstruct the current array', () => {
    const manager = new DeltaResponseManager();
    const key = DeltaResponseManager.generateKey('large-list', { page: 1 });
    const previous = [
      { name: 'alpha', body: 'a'.repeat(800) },
      { name: 'bravo', body: 'b'.repeat(800) },
    ];
    const current = [
      { name: 'alpha', body: 'a'.repeat(800) },
      { name: 'bravo', body: 'changed' },
      { name: 'charlie', body: 'c'.repeat(800) },
    ];

    manager.getDeltaForArray(key, previous);
    const delta = manager.getDeltaForArray(key, current);

    assert.equal(delta.isDelta, true);
    assert.deepEqual(applyDelta(previous, delta.data as DeltaPatch), current);
    assert.ok((delta.stats?.savedPercent ?? 0) >= 20);
  });

  await runTest('DELTA-004: invalidateTool removes only matching tool keys', () => {
    const manager = new DeltaResponseManager();
    manager.getDeltaForObject(DeltaResponseManager.generateKey('alpha', { id: 1 }), { ok: true });
    manager.getDeltaForObject(DeltaResponseManager.generateKey('beta', { id: 1 }), { ok: true });

    assert.equal(manager.invalidateTool('alpha'), 1);
    assert.deepEqual(manager.getStats().keys, [DeltaResponseManager.generateKey('beta', { id: 1 })]);
  });

  console.log(`\nDelta response tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
