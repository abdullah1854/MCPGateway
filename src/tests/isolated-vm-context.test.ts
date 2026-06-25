/**
 * Behavior tests for isolated-vm context propagation.
 *
 * Unlike the executor-selection tests in sandbox-isolation.test.ts (which mock
 * compileScript/run as no-ops), these tests run the ACTUAL generated isolate
 * bootstrap through a realistic `isolated-vm`-shaped mock backed by Node's `vm`
 * module. This proves that injected params/context, console capture, the callTool
 * bridge, and PII tokenization are wired into the code that really runs inside the
 * isolate.
 *
 * Run with: npx tsx src/tests/isolated-vm-context.test.ts
 */

import * as vm from 'vm';
import { BackendManager } from '../backend/index.js';
import { CodeExecutor } from '../code-execution/executor.js';
import { IsolatedVmExecutor } from '../code-execution/sandbox/isolated-vm-executor.js';
import {
  IsolationCapability,
  SandboxConsole,
  SandboxExecuteRequest,
  SandboxExecutor,
  SandboxExecutorFactory,
  SandboxToolFunction,
} from '../code-execution/sandbox/isolation.js';

let failures = 0;

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    process.stdout.write(`• ${name}... `);
    await fn();
    console.log('✔');
  } catch (error) {
    console.log('✘ FAILED');
    console.error(error);
    failures += 1;
    process.exitCode = 1;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeBackendManager extends BackendManager {}

interface IsolateEvents {
  constructed: number;
  disposed: number;
}

/**
 * A realistic `isolated-vm` stand-in that actually evaluates the generated
 * bootstrap source in a fresh Node vm context. Globals injected with
 * `jail.setSync(...)` become real globals in the evaluated bootstrap, and
 * `Reference` objects expose `applySync`/`apply` that call the host function,
 * mirroring how the executor bridges console capture and callTool.
 */
function makeRealisticIvm(events: IsolateEvents): unknown {
  class Reference {
    constructor(public fn: (...args: unknown[]) => unknown) {}
    applySync(_thisArg: unknown, args: unknown[] = []): unknown {
      return this.fn(...args);
    }
    async apply(_thisArg: unknown, args: unknown[] = []): Promise<unknown> {
      return await this.fn(...args);
    }
    derefInto(): unknown {
      return this;
    }
  }

  class Context {
    globals: Record<string, unknown> = {};
    global = {
      setSync: (name: string, value: unknown): void => {
        this.globals[name] = value;
      },
      derefInto: (): unknown => this.globals,
    };
    release(): void {
      /* no-op */
    }
  }

  class Isolate {
    constructor(_opts: { memoryLimit: number }) {
      events.constructed += 1;
    }
    async createContext(): Promise<Context> {
      return new Context();
    }
    async compileScript(
      code: string,
    ): Promise<{ run: (ctx: Context, opts?: unknown) => Promise<unknown> }> {
      return {
        run: async (ctx: Context): Promise<unknown> => {
          const sandbox: Record<string, unknown> = { ...ctx.globals };
          vm.createContext(sandbox);
          const completion = vm.runInContext(code, sandbox, { timeout: 5000 });
          return await completion;
        },
      };
    }
    dispose(): void {
      events.disposed += 1;
    }
  }

  return { Isolate, Reference };
}

function makeReq(overrides: Partial<SandboxExecuteRequest>): SandboxExecuteRequest {
  const noopConsole: SandboxConsole = {
    log: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
  };
  return {
    code: 'console.log("noop");',
    timeoutMs: 5000,
    memoryLimitMb: 128,
    buildVmSandbox: () => ({}),
    consoleCapture: noopConsole,
    toolFunctions: {} as Record<string, SandboxToolFunction>,
    context: {},
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log('Running isolated-vm context propagation tests...\n');

  await runTest('VAL-SANDBOX-011: injected params/context are accessible inside the isolate', async () => {
    const events: IsolateEvents = { constructed: 0, disposed: 0 };
    const logs: unknown[][] = [];
    const exec = new IsolatedVmExecutor(makeRealisticIvm(events), 128);
    const result = await exec.execute(
      makeReq({
        code: 'console.log({ sum: params.a + params.b, name }); return params.a + params.b;',
        context: { params: { a: 2, b: 3 }, name: 'widget' },
        consoleCapture: {
          log: (...args: unknown[]) => logs.push(args),
          error: () => {},
          warn: () => {},
          info: () => {},
        },
      }),
    );
    assert(result === 5, `return value should use injected params, got ${String(result)}`);
    const joined = logs
      .map((l) => l.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
      .join('\n');
    assert(joined.includes('"sum":5'), 'console output should reflect injected params');
    assert(joined.includes('widget'), 'top-level context identifier should be accessible');
    assert(events.disposed === 1, 'isolate should be disposed after success');
  });

  await runTest('VAL-SANDBOX-001: console capture inside the isolate reaches the host', async () => {
    const events: IsolateEvents = { constructed: 0, disposed: 0 };
    const logs: unknown[][] = [];
    const exec = new IsolatedVmExecutor(makeRealisticIvm(events), 128);
    await exec.execute(
      makeReq({
        code: 'console.log("hello", 123); console.error("boom");',
        consoleCapture: {
          log: (...args: unknown[]) => logs.push(args),
          error: () => {},
          warn: () => {},
          info: () => {},
        },
      }),
    );
    const flat = logs.map((l) => l.map((x) => String(x)).join(' '));
    assert(flat.some((line) => line.includes('hello') && line.includes('123')), 'log call should reach host');
    assert(flat.some((line) => line.includes('[ERROR]') && line.includes('boom')), 'console.error should route through host log');
  });

  await runTest('VAL-SANDBOX-012: callTool bridge inside the isolate invokes the host tool function', async () => {
    const events: IsolateEvents = { constructed: 0, disposed: 0 };
    const calls: Array<[unknown, unknown]> = [];
    const toolFunctions: Record<string, SandboxToolFunction> = {
      callTool: async (name: unknown, args: unknown) => {
        calls.push([name, args]);
        return { success: true, data: { echoed: args } };
      },
    };
    const exec = new IsolatedVmExecutor(makeRealisticIvm(events), 128);
    const result = await exec.execute(
      makeReq({
        code: 'const r = await callTool("my_tool", { x: 7 }); return r.success ? r.data.echoed.x : null;',
        toolFunctions,
      }),
    );
    assert(result === 7, `callTool result should round-trip into the isolate, got ${String(result)}`);
    assert(calls.length === 1, `host callTool should be invoked once, got ${calls.length}`);
    assert(calls[0][0] === 'my_tool', 'tool name should be forwarded to host');
    assert(JSON.stringify(calls[0][1]) === JSON.stringify({ x: 7 }), 'tool args should be forwarded to host');
  });

  await runTest('VAL-SANDBOX-012: missing callTool host function fails closed inside isolate', async () => {
    const events: IsolateEvents = { constructed: 0, disposed: 0 };
    const exec = new IsolatedVmExecutor(makeRealisticIvm(events), 128);
    const result = await exec.execute(
      makeReq({
        code: 'const r = await callTool("anything", {}); return r.success;',
        toolFunctions: {},
      }),
    );
    assert(result === false, 'callTool without a host bridge should report failure, not throw');
  });

  await runTest('VAL-SANDBOX-011: function-valued context is neutralized before injection', async () => {
    const events: IsolateEvents = { constructed: 0, disposed: 0 };
    const logs: unknown[][] = [];
    const exec = new IsolatedVmExecutor(makeRealisticIvm(events), 128);
    await exec.execute(
      makeReq({
        code: 'console.log(typeof evil); console.log(JSON.stringify(data));',
        context: { evil: () => 'pwned', data: { ok: 1 } },
        consoleCapture: {
          log: (...args: unknown[]) => logs.push(args),
          error: () => {},
          warn: () => {},
          info: () => {},
        },
      }),
    );
    const flat = logs.map((l) => l.map((x) => String(x)).join(' '));
    assert(flat.some((line) => line.includes('undefined')), 'host function context must not be injected');
    assert(flat.some((line) => line.includes('"ok":1')), 'serializable context object should still be injected');
  });

  await runTest('VAL-SANDBOX-001/011: PII tokenization applies to isolate console output and return value', async () => {
    const events: IsolateEvents = { constructed: 0, disposed: 0 };
    const available: IsolationCapability = { available: true, nodeMajor: 22, isolateModule: {} };
    const factory: SandboxExecutorFactory = {
      createVmExecutor(): SandboxExecutor {
        throw new Error('vm executor must not be used on the isolated path');
      },
      createIsolatedExecutor(_capability: IsolationCapability, memoryLimitMb: number): SandboxExecutor {
        return new IsolatedVmExecutor(makeRealisticIvm(events), memoryLimitMb);
      },
    };

    const exec = new CodeExecutor(new FakeBackendManager(), {
      deploymentProfile: 'local-single-user',
      isolateRequested: true,
      isolationProbe: async () => available,
      executorFactory: factory,
    });

    const result = await exec.execute(
      'console.log("contact me at john.doe@example.com"); return { email: "jane.roe@example.com" };',
      { sessionId: 'isolated-pii-session' },
    );

    assert(result.success === true, `isolated execution should succeed: ${result.error}`);
    const outputText = result.output.join('\n');
    assert(outputText.includes('[EMAIL'), 'console PII should be tokenized in isolate output');
    assert(!outputText.includes('john.doe@example.com'), 'raw email must not appear in console output');

    const returnText = JSON.stringify(result.returnValue);
    assert(returnText.includes('[EMAIL'), 'return value PII should be tokenized');
    assert(!returnText.includes('jane.roe@example.com'), 'raw email must not appear in return value');
    assert(events.constructed === 1, 'isolated executor should have run exactly one isolate');
  });

  console.log(
    `\nIsolated-vm context tests completed${failures ? ` with ${failures} failure(s)` : ''}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
