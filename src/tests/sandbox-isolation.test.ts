/**
 * Sandbox isolation policy, executor-factory, fail-closed, isolated-executor, and
 * cross-entrypoint tests.
 *
 * Run with: npx tsx src/tests/sandbox-isolation.test.ts
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackendManager } from '../backend/index.js';
import { CodeExecutor } from '../code-execution/executor.js';
import { SkillsManager } from '../code-execution/skills.js';
import { WorkspaceManager } from '../code-execution/workspace.js';
import { IsolatedVmExecutor } from '../code-execution/sandbox/isolated-vm-executor.js';
import {
  IsolationCapability,
  SandboxExecuteRequest,
  SandboxExecutor,
  SandboxExecutorFactory,
  decideIsolation,
  getNodeMajor,
  nodeSupportsIsolatedVm,
  probeIsolationCapability,
  resetIsolationCapabilityCache,
} from '../code-execution/sandbox/isolation.js';
import { DeploymentProfile } from '../deployment-profile.js';

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

/** Records which executors the factory was asked to build/run. */
class SpyExecutorFactory implements SandboxExecutorFactory {
  vmCreated = 0;
  isolatedCreated = 0;
  vmExecuted = 0;
  isolatedExecuted = 0;
  lastMemoryLimit: number | undefined;

  createVmExecutor(): SandboxExecutor {
    this.vmCreated += 1;
    const self = this;
    return {
      mode: 'vm',
      async execute(): Promise<unknown> {
        self.vmExecuted += 1;
        return undefined;
      },
    };
  }

  createIsolatedExecutor(_capability: IsolationCapability, memoryLimitMb: number): SandboxExecutor {
    this.isolatedCreated += 1;
    this.lastMemoryLimit = memoryLimitMb;
    const self = this;
    return {
      mode: 'isolated',
      async execute(): Promise<unknown> {
        self.isolatedExecuted += 1;
        return 'isolated-result';
      },
    };
  }
}

const available: IsolationCapability = { available: true, nodeMajor: 22, isolateModule: {} };
const unavailable: IsolationCapability = {
  available: false,
  nodeMajor: 25,
  reason: 'isolated-vm does not support Node 25',
};

const PROTECTED_PROFILES: DeploymentProfile[] = ['shared-local', 'remote-private', 'remote-public'];

async function main(): Promise<void> {
  console.log('Running sandbox isolation tests...\n');

  // ---- Policy: decideIsolation ----------------------------------------------

  await runTest('VAL-SANDBOX-016: local-single-user without isolate flag selects vm', () => {
    const d = decideIsolation({
      profile: 'local-single-user',
      isolateRequested: false,
      capability: unavailable,
    });
    assert(d.allowed && d.mode === 'vm', 'expected vm mode for local-single-user');
  });

  await runTest('VAL-SANDBOX-004: SANDBOX_ISOLATE=1 + available selects isolated', () => {
    const d = decideIsolation({
      profile: 'local-single-user',
      isolateRequested: true,
      capability: available,
    });
    assert(d.allowed && d.mode === 'isolated', 'expected isolated mode');
  });

  await runTest('VAL-SANDBOX-004: SANDBOX_ISOLATE=1 + unavailable fails closed (no vm)', () => {
    const d = decideIsolation({
      profile: 'local-single-user',
      isolateRequested: true,
      capability: unavailable,
    });
    assert(!d.allowed, 'expected fail-closed');
    assert(d.mode === null, 'fail-closed must not select any executor mode');
  });

  await runTest('VAL-SANDBOX-002/016: protected profiles never select vm', () => {
    for (const profile of PROTECTED_PROFILES) {
      for (const isolateRequested of [false, true]) {
        const denied = decideIsolation({ profile, isolateRequested, capability: unavailable });
        assert(!denied.allowed, `${profile} should fail closed when isolation unavailable`);
        assert(denied.mode !== 'vm', `${profile} must never choose vm`);
        const allowedIso = decideIsolation({ profile, isolateRequested, capability: available });
        assert(
          allowedIso.allowed && allowedIso.mode === 'isolated',
          `${profile} should select isolated when available`,
        );
      }
    }
  });

  await runTest('VAL-SANDBOX-003: Node major support matrix', () => {
    for (const major of [20, 21, 22, 23, 24]) {
      assert(nodeSupportsIsolatedVm(major), `Node ${major} should be supported`);
    }
    for (const major of [18, 19, 25, 26, 27]) {
      assert(!nodeSupportsIsolatedVm(major), `Node ${major} should be unsupported`);
    }
  });

  await runTest('VAL-SANDBOX-003/017: real runtime probe reports Node 25 unsupported', async () => {
    resetIsolationCapabilityCache();
    const cap = await probeIsolationCapability({ force: true });
    if (!nodeSupportsIsolatedVm(getNodeMajor())) {
      assert(cap.available === false, 'expected isolation unavailable on unsupported Node');
      assert(/node/i.test(cap.reason ?? ''), 'reason should mention Node');
    } else {
      assert(typeof cap.available === 'boolean', 'capability must resolve');
    }
  });

  // ---- CodeExecutor fail-closed (no vm fallback) ----------------------------

  await runTest('VAL-SANDBOX-018: protected fail-closed never instantiates vm executor', async () => {
    const spy = new SpyExecutorFactory();
    const exec = new CodeExecutor(new FakeBackendManager(), {
      deploymentProfile: 'remote-public',
      isolationProbe: async () => unavailable,
      executorFactory: spy,
    });
    const result = await exec.execute('console.log(1 + 1);');
    assert(result.success === false, 'protected fail-closed must not succeed');
    assert(result.errorKind === 'security', `expected security errorKind, got ${result.errorKind}`);
    assert(spy.vmCreated === 0, 'vm executor must NOT be created on fail-closed');
    assert(spy.vmExecuted === 0, 'vm executor must NOT be executed on fail-closed');
    assert(spy.isolatedCreated === 0, 'isolated executor must NOT be created when unavailable');
  });

  await runTest('VAL-SANDBOX-022: fail-closed error shape is stable and redacted', async () => {
    const exec = new CodeExecutor(new FakeBackendManager(), {
      deploymentProfile: 'shared-local',
      isolationProbe: async () => unavailable,
    });
    const result = await exec.execute('console.log("x");');
    assert(result.success === false, 'must fail closed');
    assert(typeof result.error === 'string' && result.error.length > 0, 'must have error string');
    assert(Array.isArray(result.hints) && result.hints.length > 0, 'must include hints');
    assert(typeof result.executionTime === 'number', 'must include executionTime');
    assert(!/\bat \//.test(result.error ?? ''), 'must not leak stack trace paths');
    assert(!/Bearer|api[_-]?key/i.test(result.error ?? ''), 'must not leak secrets');
  });

  await runTest('VAL-SANDBOX-002: local-single-user uses vm executor', async () => {
    const spy = new SpyExecutorFactory();
    const exec = new CodeExecutor(new FakeBackendManager(), {
      deploymentProfile: 'local-single-user',
      executorFactory: spy,
    });
    await exec.execute('console.log(1);');
    assert(spy.vmCreated === 1, 'expected one vm executor');
    assert(spy.isolatedCreated === 0, 'must not create isolated executor for local');
  });

  await runTest('VAL-SANDBOX-004: SANDBOX_ISOLATE=1 + available selects isolated executor', async () => {
    const spy = new SpyExecutorFactory();
    const exec = new CodeExecutor(new FakeBackendManager(), {
      deploymentProfile: 'local-single-user',
      isolateRequested: true,
      isolationProbe: async () => available,
      executorFactory: spy,
      memoryLimitMb: 64,
    });
    await exec.execute('console.log(1);');
    assert(spy.isolatedCreated === 1, 'expected isolated executor');
    assert(spy.vmCreated === 0, 'must not create vm executor');
    assert(spy.lastMemoryLimit === 64, `memory limit should pass through, got ${spy.lastMemoryLimit}`);
  });

  await runTest('VAL-SANDBOX-017: local execution never probes isolation', async () => {
    let probeCalls = 0;
    const exec = new CodeExecutor(new FakeBackendManager(), {
      deploymentProfile: 'local-single-user',
      isolationProbe: async () => {
        probeCalls += 1;
        return unavailable;
      },
    });
    const result = await exec.execute('console.log("ok");');
    assert(result.success === true, 'local execution must succeed without isolate');
    assert(probeCalls === 0, 'isolation probe must not run for trusted local path');
  });

  await runTest('VAL-SANDBOX-023: local vm host wrappers block constructor escape', async () => {
    const exec = new CodeExecutor(new FakeBackendManager(), {
      deploymentProfile: 'local-single-user',
    });
    const payloads = [
      'String.__proto__.constructor("return process")()',
      'String.prototype?.constructor?.constructor("return process")()',
      'Number.__proto__.constructor("return process")()',
      'Number.prototype?.constructor?.constructor("return process")()',
      'Date.__proto__.constructor("return process")()',
      'Date.prototype?.constructor?.constructor("return process")()',
      'Math.max.__proto__.constructor("return process")()',
      'JSON.parse.__proto__.constructor("return process")()',
      'console.log.__proto__.constructor("return process")()',
    ];

    for (const payload of payloads) {
      const result = await exec.execute(`
        try {
          const value = ${payload};
          console.log(typeof value, value?.versions?.node || 'no');
        } catch (error) {
          console.log('ERR', error instanceof Error ? error.message : String(error));
        }
      `);
      assert(result.success === true, `payload should be handled without executor failure: ${payload}`);
      const output = JSON.stringify(result.output ?? []);
      assert(!output.includes(process.versions.node), `payload reached host process: ${payload}`);
      assert(!output.includes('object'), `payload returned host object: ${payload}`);
    }
  });

  // ---- IsolatedVmExecutor with mocked isolate -------------------------------

  await runTest('VAL-SANDBOX-021: isolated executor uses memory limit and disposes (success)', async () => {
    const events = { constructed: [] as Array<{ memoryLimit: number }>, disposed: 0 };
    const mockIvm = makeMockIvm(events, { result: 'done' });
    const executor = new IsolatedVmExecutor(mockIvm, 128);
    const result = await executor.execute(makeIsolatedRequest({ memoryLimitMb: 96 }));
    assert(result === 'done', 'should return isolate result');
    assert(events.constructed.length === 1, 'isolate constructed once');
    assert(events.constructed[0].memoryLimit === 96, `memoryLimit should be 96, got ${events.constructed[0].memoryLimit}`);
    assert(events.disposed === 1, 'isolate disposed after success');
  });

  await runTest('VAL-SANDBOX-021: isolated executor disposes after failure', async () => {
    const events = { constructed: [] as Array<{ memoryLimit: number }>, disposed: 0 };
    const mockIvm = makeMockIvm(events, { throwError: new Error('boom') });
    const executor = new IsolatedVmExecutor(mockIvm, 128);
    let threw = false;
    try {
      await executor.execute(makeIsolatedRequest({ memoryLimitMb: 32 }));
    } catch {
      threw = true;
    }
    assert(threw, 'should propagate failure');
    assert(events.disposed === 1, 'isolate disposed after failure');
  });

  await runTest('VAL-SANDBOX-021: memory-limit failure is classified distinctly', async () => {
    const events = { constructed: [] as Array<{ memoryLimit: number }>, disposed: 0 };
    const mockIvm = makeMockIvm(events, {
      throwError: new Error('Array buffer allocation failed: reached heap limit'),
    });
    const executor = new IsolatedVmExecutor(mockIvm, 128);
    let message = '';
    try {
      await executor.execute(makeIsolatedRequest({ memoryLimitMb: 16 }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(/memory limit/i.test(message), `expected memory-limit classification, got: ${message}`);
    assert(events.disposed === 1, 'isolate disposed after memory failure');
  });

  // ---- Cross-entrypoint parity (skills + skill-chain) -----------------------

  const tmpRoot = mkdtempSync(join(tmpdir(), 'mcpgw-sandbox-'));
  try {
    await runTest('VAL-SANDBOX-015: skill + skill-chain fail closed under protected profile', async () => {
      const spy = new SpyExecutorFactory();
      const protectedExec = new CodeExecutor(new FakeBackendManager(), {
        deploymentProfile: 'shared-local',
        isolationProbe: async () => unavailable,
        executorFactory: spy,
      });
      const ws = new WorkspaceManager(join(tmpRoot, 'ws1'), join(tmpRoot, 'skills1'));
      const skills = new SkillsManager(ws, protectedExec);
      try {
        skills.createSkill({
          name: 'echo-skill',
          description: 'echo',
          version: '1.0.0',
          tags: [],
          inputs: [],
          code: 'console.log("hi");',
        });
        const single = await skills.executeSkill('echo-skill', {});
        assert(single.success === false, 'skill execution must fail closed');
        assert(single.errorKind === 'security', 'skill fail-closed should be security errorKind');

        const chain = await skills.executeSkillChain(['echo-skill'], {});
        assert(chain[0]?.success === false, 'skill-chain must fail closed');
        assert(spy.vmCreated === 0, 'protected skill paths must never create vm executor');
      } finally {
        skills.cleanup();
      }
    });

    await runTest('VAL-SANDBOX-001/015: skill executes under local-single-user', async () => {
      const localExec = new CodeExecutor(new FakeBackendManager(), {
        deploymentProfile: 'local-single-user',
      });
      const ws = new WorkspaceManager(join(tmpRoot, 'ws2'), join(tmpRoot, 'skills2'));
      const skills = new SkillsManager(ws, localExec);
      try {
        skills.createSkill({
          name: 'echo-local',
          description: 'echo',
          version: '1.0.0',
          tags: [],
          inputs: [],
          code: 'console.log("hello-skill");',
        });
        const single = await skills.executeSkill('echo-local', {});
        assert(single.success === true, `skill should succeed locally: ${single.error}`);
        assert(single.output.join('\n').includes('hello-skill'), 'skill output captured');
      } finally {
        skills.cleanup();
      }
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\nSandbox isolation tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
}

interface MockEvents {
  constructed: Array<{ memoryLimit: number }>;
  disposed: number;
}

function makeMockIvm(
  events: MockEvents,
  behavior: { result?: unknown; throwError?: Error },
): unknown {
  class Reference {
    constructor(public value: unknown) {}
    applySync(): unknown {
      return undefined;
    }
    apply(): Promise<unknown> {
      return Promise.resolve('{}');
    }
    derefInto(): unknown {
      return {};
    }
  }

  class Isolate {
    constructor(opts: { memoryLimit: number }) {
      events.constructed.push(opts);
    }
    async createContext(): Promise<unknown> {
      return {
        global: {
          setSync(): void {},
          derefInto(): unknown {
            return {};
          },
        },
      };
    }
    async compileScript(): Promise<unknown> {
      return {
        run: async (): Promise<unknown> => {
          if (behavior.throwError) {
            throw behavior.throwError;
          }
          return behavior.result;
        },
      };
    }
    dispose(): void {
      events.disposed += 1;
    }
  }

  return { Isolate, Reference };
}

function makeIsolatedRequest(overrides: Partial<SandboxExecuteRequest>): SandboxExecuteRequest {
  return {
    code: 'console.log("noop");',
    timeoutMs: 1000,
    memoryLimitMb: 128,
    buildVmSandbox: () => ({}),
    consoleCapture: {
      log: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
    },
    toolFunctions: {},
    context: {},
    ...overrides,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
