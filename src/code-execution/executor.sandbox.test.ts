/**
 * Comprehensive safety and functionality tests for CodeExecutor sandbox.
 * 
 * Run with: npx tsx src/code-execution/executor.sandbox.test.ts
 */

import { BackendManager } from '../backend/index.js';
import { MCPResponse, MCPTool } from '../types.js';
import { CodeExecutor } from './executor.js';

class FakeBackendManager extends BackendManager {
  constructor() {
    super();
  }
}

/** Fake backend exposing tools and recording tool-call attempts that reach it. */
class FakeBackendWithTools extends BackendManager {
  callLog: string[] = [];
  private fakeBackends: Map<string, { status: string; tools: MCPTool[] }>;

  constructor(toolNames: string[]) {
    super();
    const tools: MCPTool[] = toolNames.map(name => ({
      name,
      description: `fake ${name}`,
      inputSchema: { type: 'object', properties: {} },
    }));
    this.fakeBackends = new Map([['fake', { status: 'connected', tools }]]);
  }

  getBackends(): Map<string, never> {
    return this.fakeBackends as unknown as Map<string, never>;
  }

  async callTool(toolName: string): Promise<MCPResponse> {
    this.callLog.push(toolName);
    return { jsonrpc: '2.0', id: 0, result: { ok: true, tool: toolName } } as MCPResponse;
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
  const executor = new CodeExecutor(backendManager, { deploymentProfile: 'local-single-user' });

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
    if (result.errorKind !== 'timeout') throw new Error(`Expected errorKind timeout, got ${result.errorKind}`);
    if (!result.error?.includes('timed out after 200ms')) throw new Error(`Unexpected error: ${result.error}`);
    if (!result.hints?.length) throw new Error('Expected timeout hints');
  });

  // 4b. Syntax error classification
  await runTest('classifies syntax errors with hints', async () => {
    const result = await executor.execute('const x = {');
    if (result.success) throw new Error('Should have failed');
    if (result.errorKind !== 'syntax') throw new Error(`Expected syntax, got ${result.errorKind}`);
    if (!result.error?.includes('[SYNTAX]')) throw new Error(`Unexpected error: ${result.error}`);
  });

  // 4c. Tool reference errors
  await runTest('classifies missing tool helpers', async () => {
    const result = await executor.execute('await mssql_prod_missing_tool({});');
    if (result.success) throw new Error('Should have failed');
    if (result.errorKind !== 'tool_not_found') throw new Error(`Expected tool_not_found, got ${result.errorKind}`);
  });

  // 4d. Success hints
  await runTest('includes success hints', async () => {
    const result = await executor.execute('console.log("ok");');
    if (!result.success) throw new Error(`Failed: ${result.error}`);
    if (!result.hints?.some(h => h.includes('output[]'))) throw new Error('Missing output hint');
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

  // 9. Dangerous host globals are inaccessible (VAL-SANDBOX-008)
  await runTest('blocks dangerous host globals', async () => {
    const globals = [
      'process', 'require', 'module', 'exports', 'Buffer', 'global', 'globalThis',
      'Function', 'eval', 'WebAssembly', 'Proxy', 'Reflect', 'Symbol',
    ];
    for (const name of globals) {
      const r = await executor.execute(`console.log(typeof ${name})`);
      if (!r.success || r.output[0] !== 'undefined') {
        throw new Error(`${name} should be undefined, got ${JSON.stringify(r.output)} success=${r.success}`);
      }
    }
    // Dynamic code generation and module loading must be blocked
    const fn = await executor.execute('Function("return process")()');
    if (fn.success) throw new Error('Function constructor should be blocked');
    const ev = await executor.execute('eval("1+1")');
    if (ev.success) throw new Error('eval should be blocked');
    const imp = await executor.execute('await import("fs")');
    if (imp.success) throw new Error('dynamic import should be blocked');
    const req = await executor.execute('require("fs")');
    if (req.success) throw new Error('require should be blocked');
  });

  // 10. Constructor / prototype-chain escapes fail safely (VAL-SANDBOX-009)
  await runTest('blocks constructor code-generation escapes', async () => {
    const payloads = [
      '(function(){}).constructor("return process")()',
      '({}).constructor.constructor("return this")()',
      '[].constructor.constructor("return globalThis")()',
      '(async function(){}).constructor("return process")()',
    ];
    for (const code of payloads) {
      const r = await executor.execute(code);
      if (r.success) throw new Error(`Escape payload should fail: ${code}`);
      if (r.errorKind !== 'security') {
        throw new Error(`Expected security errorKind for: ${code}, got ${r.errorKind}`);
      }
    }
    // Follow-up execution remains clean
    const ok = await executor.execute('console.log(1 + 1)');
    if (!ok.success || ok.output[0] !== '2') throw new Error('Follow-up execution should be clean');
  });

  // 11. Prototype pollution does not poison later executions (VAL-SANDBOX-009)
  await runTest('prototype pollution does not persist across executions', async () => {
    await executor.execute('({}).__proto__.polluted = 42; console.log("set");');
    const r = await executor.execute('console.log(typeof ({}).polluted)');
    if (!r.success || r.output[0] !== 'undefined') {
      throw new Error(`Prototype pollution leaked: ${JSON.stringify(r.output)}`);
    }
  });

  // 12. `this` smuggling and indirect globals are blocked (VAL-SANDBOX-010)
  await runTest('blocks this smuggling and sloppy global leakage', async () => {
    // Function-call `this` must be undefined under strict mode (no host global).
    const payloads = [
      'console.log(typeof (function(){ return this; })())',
      'console.log(typeof (function(){ return this; }).bind(undefined)())',
      'console.log(typeof (function(){ return this; }).call(undefined))',
    ];
    for (const code of payloads) {
      const r = await executor.execute(code);
      if (!r.success) throw new Error(`Payload threw unexpectedly: ${code} -> ${r.error}`);
      if (r.output[0] !== 'undefined') {
        throw new Error(`this leaked host scope for: ${code}, got ${r.output[0]}`);
      }
    }
    // Top-level `this` is the frozen sandbox, never host process/require/Function.
    const top = await executor.execute(
      'console.log([typeof this.process, typeof this.require, typeof this.Function].join(","))',
    );
    if (top.output[0] !== 'undefined,undefined,undefined') {
      throw new Error(`Top-level this exposed host capability: ${top.output[0]}`);
    }
  });

  // 13. Non-whitelisted globals cannot expose host capability (VAL-SANDBOX-019)
  await runTest('standard globals cannot reach host capability', async () => {
    // Even where standard constructors exist, they cannot generate code or reach process.
    const checks = [
      'try { new Error().constructor.constructor("return process")(); console.log("LEAK"); } catch { console.log("blocked"); }',
      'try { Promise.constructor("return process")(); console.log("LEAK"); } catch { console.log("blocked"); }',
      'console.log(typeof process === "undefined" ? "no-process" : "LEAK")',
    ];
    for (const code of checks) {
      const r = await executor.execute(code);
      const out = r.output.join('');
      if (out.includes('LEAK')) throw new Error(`Host capability leaked: ${code} -> ${out}`);
    }
    const ok = await executor.execute('console.log("clean")');
    if (!ok.success || ok.output[0] !== 'clean') throw new Error('Follow-up should be clean');
  });

  // 14. Timer APIs are unavailable (VAL-SANDBOX-020)
  await runTest('timer APIs are unavailable', async () => {
    for (const timer of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']) {
      const r = await executor.execute(`console.log(typeof ${timer})`);
      if (r.output[0] !== 'undefined') throw new Error(`${timer} should be undefined`);
    }
    const r = await executor.execute('setTimeout(() => {}, 0)');
    if (r.success) throw new Error('Calling setTimeout should fail');
  });

  // 15. Synchronous memory-growth payloads are bounded and host survives (VAL-SANDBOX-005)
  await runTest('bounds synchronous memory growth and host survives', async () => {
    const r = await executor.execute('const a = []; while (true) { a.push(Math.random()); }', { timeout: 300 });
    if (r.success) throw new Error('Unbounded allocation should not succeed');
    // Gateway remains alive: a subsequent execution works
    const alive = await executor.execute('console.log("alive")');
    if (!alive.success || alive.output[0] !== 'alive') throw new Error('Host did not survive memory payload');
  });

  // 16. Async hangs are stopped at timeout with no delayed side effects (VAL-SANDBOX-007)
  await runTest('async hang stops at timeout with no delayed side effects', async () => {
    const code = `
      console.log('before-hang');
      await new Promise(() => {}); // never resolves
      console.log('after-hang');   // must never run
    `;
    const r = await executor.execute(code, { timeout: 150 });
    if (r.success) throw new Error('Hanging await should time out');
    if (r.errorKind !== 'timeout') throw new Error(`Expected timeout, got ${r.errorKind}`);
    if (!r.output.includes('before-hang')) throw new Error('Pre-hang output missing');
    if (r.output.includes('after-hang')) throw new Error('Delayed side effect ran after hang');
    // Wait past the timeout window: the suspended continuation must stay suspended.
    await new Promise(resolve => setTimeout(resolve, 200));
    if (r.output.includes('after-hang')) throw new Error('Delayed side effect ran after timeout');
  });

  // 17. Context injection is sanitized (VAL-SANDBOX-011)
  await runTest('sanitizes malicious context injection', async () => {
    // Primitives remain usable
    const ok = await executor.execute('console.log(a + ":" + b)', { context: { a: 1, b: 'x' } });
    if (ok.output[0] !== '1:x') throw new Error(`Primitive context failed: ${ok.output[0]}`);

    // Host functions are neutralized (never executed in sandbox)
    const fn = await executor.execute('console.log(typeof evil)', { context: { evil: () => 'host' } });
    if (fn.output[0] !== 'undefined') throw new Error(`Function context not neutralized: ${fn.output[0]}`);

    // Circular objects are neutralized rather than leaking
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circ = await executor.execute('console.log(typeof bad)', { context: { bad: circular } });
    if (circ.output[0] !== 'undefined') throw new Error(`Circular context not neutralized: ${circ.output[0]}`);

    // Getter that returns host capability is neutralized
    const withGetter: Record<string, unknown> = {};
    Object.defineProperty(withGetter, 'leak', { enumerable: true, get: () => process });
    const get = await executor.execute('console.log(typeof danger)', { context: { danger: withGetter } });
    if (get.output[0] && get.output[0].includes('process')) {
      throw new Error('Getter leaked host process');
    }
  });

  // 18. Output and return values remain bounded (VAL-SANDBOX-013)
  await runTest('bounds large console output', async () => {
    const r = await executor.execute("for (let i = 0; i < 5000; i++) console.log('x'.repeat(200));");
    if (!r.success) throw new Error(`Should succeed: ${r.error}`);
    if (!r.output.includes('[Output truncated...]')) throw new Error('Expected truncation marker');
  });

  await runTest('bounds oversized return values', async () => {
    const r = await executor.execute("return 'x'.repeat(200000);");
    if (!r.success) throw new Error(`Should succeed: ${r.error}`);
    if (r.returnValue !== '[Return value too large]') {
      throw new Error(`Expected bounded return sentinel, got ${typeof r.returnValue}`);
    }
    // Public response field names remain stable
    for (const field of ['success', 'output', 'returnValue', 'hints', 'executionTime']) {
      if (!(field in r)) throw new Error(`Missing response field: ${field}`);
    }
  });

  // 19. Error classifications remain actionable (VAL-SANDBOX-014)
  await runTest('classifies error kinds with hints', async () => {
    const cases: Array<{ code: string; kind: string; opts?: { timeout?: number } }> = [
      { code: 'const x = {', kind: 'syntax' },
      { code: 'while (true) {}', kind: 'timeout', opts: { timeout: 150 } },
      { code: 'await unknown_helper_tool({})', kind: 'tool_not_found' },
      { code: 'undefinedVariable.foo()', kind: 'reference' },
      { code: 'eval("x")', kind: 'runtime' },
      { code: '(function(){}).constructor("return 1")()', kind: 'security' },
    ];
    for (const c of cases) {
      const r = await executor.execute(c.code, c.opts);
      if (r.success) throw new Error(`Expected failure for: ${c.code}`);
      if (r.errorKind !== c.kind) throw new Error(`Expected ${c.kind} for "${c.code}", got ${r.errorKind}`);
      if (!r.hints?.length) throw new Error(`Expected hints for: ${c.code}`);
    }
  });

  // 20. Tool helper allowlist remains fail-closed (VAL-SANDBOX-012)
  await runTest('tool helper allowlist is fail-closed', async () => {
    const prev = process.env.CODE_EXECUTION_ALLOWED_TOOLS;
    process.env.CODE_EXECUTION_ALLOWED_TOOLS = 'allowed_tool';
    try {
      const backend = new FakeBackendWithTools(['allowed_tool', 'denied_tool']);
      const ex = new CodeExecutor(backend, { deploymentProfile: 'local-single-user' });

      const allowed = await ex.execute("const r = await callTool('allowed_tool', {}); console.log(r.success);");
      if (!allowed.success) throw new Error(`Allowed call failed: ${allowed.error}`);
      if (allowed.output[0] !== 'true') throw new Error(`Allowed tool did not succeed: ${allowed.output[0]}`);
      if (!backend.callLog.includes('allowed_tool')) throw new Error('Allowed tool did not reach backend');

      const denied = await ex.execute("const r = await callTool('denied_tool', {}); console.log(r.success);");
      if (denied.output[0] !== 'false') throw new Error(`Denied tool should report failure: ${denied.output[0]}`);
      if (backend.callLog.includes('denied_tool')) throw new Error('Denied tool must NOT reach backend');
    } finally {
      if (prev === undefined) delete process.env.CODE_EXECUTION_ALLOWED_TOOLS;
      else process.env.CODE_EXECUTION_ALLOWED_TOOLS = prev;
    }
  });

  console.log('\nAll tests completed.');
}

// Run tests
main().catch(console.error);
