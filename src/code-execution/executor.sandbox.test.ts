/**
 * Basic safety tests for CodeExecutor sandbox.
 * 
 * These are lightweight, self-contained tests that can be run with:
 * 
 *   npx tsx src/code-execution/executor.sandbox.test.ts
 * 
 * They focus on common escape vectors and confirm they are rejected or fail.
 */

import { BackendManager } from '../backend/index.js';
import { CodeExecutor } from './executor.js';

/**
 * Minimal fake BackendManager that never actually calls tools.
 * The goal is only to exercise the sandbox, not backend behavior.
 */
class FakeBackendManager extends BackendManager {
  constructor() {
    super();
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    console.log(`✔ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    console.error(`✘ ${name} FAILED`, error);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const backendManager = new FakeBackendManager();
  const executor = new CodeExecutor(backendManager);

  await runTest('cannot access global process', async () => {
    const result = await executor.execute('console.log(typeof process);');
    if (result.success) {
      const joined = result.output.join('\n');
      if (joined.includes('object') || joined.includes('function')) {
        throw new Error('process should not be accessible in sandbox');
      }
    }
  });

  await runTest('cannot construct Function via constructor escape', async () => {
    const code = `
      try {
        const F = ({}).constructor.constructor;
        console.log(typeof F);
      } catch (e) {
        console.log('error');
      }
    `;
    const result = await executor.execute(code);
    const joined = result.output.join('\n');
    if (joined.includes('function')) {
      throw new Error('Function constructor escape appears to be possible');
    }
  });

  await runTest('eval is not available', async () => {
    const result = await executor.execute('try { eval("1+1"); } catch (e) { console.log("eval-blocked"); }');
    const joined = result.output.join('\n');
    if (!joined.includes('eval-blocked')) {
      throw new Error('eval should not be callable');
    }
  });

  await runTest('timeout terminates long-running code', async () => {
    const result = await executor.execute(
      `
        let i = 0;
        while (true) { i++; }
      `,
      { timeout: 500 }
    );
    if (result.success) {
      throw new Error('Infinite loop should not complete successfully');
    }
  });
}

// Only run if this file is executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Running CodeExecutor sandbox safety tests...');
  void main();
}


