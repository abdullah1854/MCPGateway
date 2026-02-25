/**
 * Comprehensive safety and functionality tests for CodeExecutor sandbox.
 * 
 * Run with: npx tsx src/code-execution/executor.sandbox.test.ts
 */

import { BackendManager } from '../backend/index.js';
import { CodeExecutor } from './executor.js';

class FakeBackendManager extends BackendManager {
  constructor() {
    super();
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    process.stdout.write(`• ${name}... `);
    await fn();
    console.log(`✔ (${Date.now() - start}ms)`);
  } catch (error) {
    console.log(`✘ FAILED`);
    console.error(error);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const backendManager = new FakeBackendManager();
  const executor = new CodeExecutor(backendManager);

  console.log('Running CodeExecutor tests...\n');

  // 1. Basic Execution
  await runTest('executes basic arithmetic', async () => {
    const result = await executor.execute('console.log(1 + 2);');
    if (!result.success) throw new Error(`Execution failed: ${result.error}`);
    if (result.output[0] !== '3') throw new Error(`Expected '3', got '${result.output[0]}'`);
  });

  // 2. Console Capture
  await runTest('captures all console levels', async () => {
    const code = `
      console.log('log');
      console.info('info');
      console.warn('warn');
      console.error('error');
    `;
    const result = await executor.execute(code);
    const output = result.output.join('\n');

    if (!output.includes('log')) throw new Error('Missing log');
    if (!output.includes('[INFO] info')) throw new Error('Missing info');
    if (!output.includes('[WARN] warn')) throw new Error('Missing warn');
    if (!output.includes('[ERROR] error')) throw new Error('Missing error');
  });

  // 3. Context Injection
  await runTest('params injection works', async () => {
    const result = await executor.execute(
      'console.log(userId + ":" + isAdmin)',
      { context: { userId: 123, isAdmin: true } }
    );
    if (result.output[0] !== '123:true') throw new Error(`Expected '123:true', got '${result.output[0]}'`);
  });

  // 4. Timeout Enforcement
  await runTest('enforces timeout on infinite loops', async () => {
    const result = await executor.execute(
      'while(true) {}',
      { timeout: 200 }
    );
    if (result.success) throw new Error('Should have timed out');
    if (!result.error?.includes('timed out')) throw new Error(`Unexpected error: ${result.error}`);
  });

  // 5. Async/Await Support (no setTimeout - timers are blocked in sandbox)
  await runTest('supports async/await', async () => {
    const result = await executor.execute(`
      await Promise.resolve();
      console.log('done');
    `);
    if (result.output[0] !== 'done') throw new Error('Async execution failed');
  });

  // 6. Global Access prevention (Sandbox Safety)
  await runTest('blocks access to process/require', async () => {
    const result = await executor.execute('console.log(typeof process)');
    if (result.output[0] !== 'undefined') throw new Error('process execution should be undefined');

    const result2 = await executor.execute('console.log(typeof require)');
    if (result2.output[0] !== 'undefined') throw new Error('require execution should be undefined');
  });

  // 7. PII Tokenization (Integration)
  await runTest('tokenizes PII in output', async () => {
    // Session ID is required to enable PII
    const result = await executor.execute(
      `console.log("Contact me at test@example.com")`,
      { sessionId: 'test-session-1' }
    );

    const output = result.output[0];
    // Should match [EMAIL_1] or similar
    if (output.includes('test@example.com')) throw new Error('PII was not tokenized');
    if (!output.includes('[EMAIL_')) throw new Error(`Expected token, got '${output}'`);
  });

  // 8. SDK Generation
  await runTest('generates SDK string', async () => {
    const sdk = executor.generateSDK();
    if (typeof sdk !== 'string' || !sdk.includes('Auto-generated')) {
      throw new Error('SDK generation failed');
    }
  });

  console.log('\nAll tests completed.');
}

// Run tests
main().catch(console.error);
