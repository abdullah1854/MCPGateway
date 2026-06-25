import { strict as assert } from 'assert';
import { CircuitBreaker, CircuitBreakerManager } from '../backend/circuit-breaker.js';

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
  console.log('Running circuit breaker tests...\n');

  await runTest('CIRCUIT-001: closed circuit opens after failure threshold and fails fast', () => {
    const breaker = new CircuitBreaker('backend-a', {
      failureThreshold: 2,
      resetTimeout: 10_000,
      failureWindow: 60_000,
    });

    assert.equal(breaker.canExecute(), true);
    breaker.recordFailure(new Error('first'));
    assert.equal(breaker.getState(), 'CLOSED');
    breaker.recordFailure(new Error('second'));
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.canExecute(), false);
    assert.equal(breaker.getStats().failures, 2);
  });

  await runTest('CIRCUIT-002: open circuit probes half-open then closes after successes', () => {
    const breaker = new CircuitBreaker('backend-b', {
      failureThreshold: 1,
      resetTimeout: 0,
      halfOpenSuccessThreshold: 2,
      failureWindow: 60_000,
    });

    breaker.recordFailure(new Error('down'));
    assert.equal(breaker.getState(), 'HALF_OPEN');
    assert.equal(breaker.canExecute(), true);
    breaker.recordSuccess();
    assert.equal(breaker.getState(), 'HALF_OPEN');
    breaker.recordSuccess();
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.getStats().failures, 0);
  });

  await runTest('CIRCUIT-003: half-open failure reopens and manager reset clears all breakers', async () => {
    const manager = new CircuitBreakerManager({
      failureThreshold: 1,
      resetTimeout: 1,
      halfOpenSuccessThreshold: 1,
      failureWindow: 60_000,
    });
    const breaker = manager.getBreaker('backend-c');
    assert.equal(manager.getBreaker('backend-c'), breaker);

    breaker.recordFailure(new Error('down'));
    assert.equal(breaker.getStats().state, 'OPEN');
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(breaker.canExecute(), true);
    assert.equal(breaker.getStats().state, 'HALF_OPEN');
    breaker.recordFailure(new Error('still down'));
    assert.equal(breaker.getStats().state, 'OPEN');

    manager.resetAll();
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(manager.getAllStats()['backend-c'].failures, 0);
  });

  console.log(`\nCircuit breaker tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
