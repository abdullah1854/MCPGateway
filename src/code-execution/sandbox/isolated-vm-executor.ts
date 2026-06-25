/**
 * Isolated-vm sandbox executor.
 *
 * Runs untrusted code inside a real V8 isolate with a hard native memory limit and
 * true context separation. Selected for protected profiles and explicit
 * `SANDBOX_ISOLATE=1` requests, and only when the optional native `isolated-vm`
 * dependency is loadable on a supported Node runtime.
 *
 * The `isolated-vm` module is injected (from the capability probe) so this executor
 * can be unit-tested with a mocked isolate constructor and so the native dependency
 * remains optional for builds/typecheck that do not have it installed.
 */

import { agentError } from '../../errors/agent-errors.js';
import {
  SandboxExecuteRequest,
  SandboxExecutor,
  isMemoryLimitError,
} from './isolation.js';

interface IvmReference {
  applySync?: (...args: unknown[]) => unknown;
  apply?: (...args: unknown[]) => unknown;
  derefInto?: () => unknown;
}

interface IvmContext {
  global: { setSync: (name: string, value: unknown) => void } & IvmReference;
  release?: () => void;
}

interface IvmScript {
  run: (context: IvmContext, opts?: { timeout?: number; promise?: boolean }) => Promise<unknown>;
}

interface IvmIsolate {
  createContext: () => Promise<IvmContext>;
  compileScript: (code: string) => Promise<IvmScript>;
  dispose: () => void;
}

interface IvmModule {
  Isolate: new (opts: { memoryLimit: number }) => IvmIsolate;
  Reference: new (value: unknown) => IvmReference;
  ExternalCopy?: new (value: unknown) => { copyInto: () => unknown };
}

const DEFAULT_MEMORY_LIMIT_MB = 128;

export class IsolatedVmExecutor implements SandboxExecutor {
  readonly mode = 'isolated' as const;
  private ivm: IvmModule;
  private memoryLimitMb: number;

  constructor(isolateModule: unknown, memoryLimitMb: number = DEFAULT_MEMORY_LIMIT_MB) {
    this.ivm = isolateModule as IvmModule;
    this.memoryLimitMb = memoryLimitMb > 0 ? memoryLimitMb : DEFAULT_MEMORY_LIMIT_MB;
  }

  async execute(req: SandboxExecuteRequest): Promise<unknown> {
    const memoryLimit = req.memoryLimitMb > 0 ? req.memoryLimitMb : this.memoryLimitMb;
    const isolate = new this.ivm.Isolate({ memoryLimit });

    try {
      const context = await isolate.createContext();
      const jail = context.global;

      jail.setSync('global', jail.derefInto ? jail.derefInto() : undefined);

      const logRef = new this.ivm.Reference((...args: unknown[]) => {
        req.consoleCapture.log(...args.map((a) => safeParse(a)));
      });
      jail.setSync('_hostLog', logRef);

      const callToolRef = new this.ivm.Reference(async (name: unknown, args: unknown) => {
        const fn = req.toolFunctions['callTool'];
        const result = fn
          ? await fn(name, safeParse(args))
          : { success: false, error: 'callTool is unavailable in this sandbox.' };
        return JSON.stringify(result);
      });
      jail.setSync('_hostCallTool', callToolRef);

      const bootstrap = `
        'use strict';
        const console = {
          log: (...args) => { _hostLog.applySync(undefined, args.map((a) => JSON.stringify(a))); },
        };
        console.error = (...a) => console.log('[ERROR]', ...a);
        console.warn = (...a) => console.log('[WARN]', ...a);
        console.info = (...a) => console.log('[INFO]', ...a);
        const callTool = async (name, args) => {
          const raw = await _hostCallTool.apply(undefined, [name, JSON.stringify(args ?? {})], { result: { promise: true } });
          return JSON.parse(raw);
        };
        (async () => {
          ${req.code}
        })();
      `;

      const script = await isolate.compileScript(bootstrap);
      const result = await script.run(context, { timeout: req.timeoutMs, promise: true });

      if (context.release) {
        context.release();
      }

      return result;
    } catch (error) {
      if (isMemoryLimitError(error)) {
        throw new Error(
          agentError({
            what: 'Code execution exceeded the configured isolate memory limit.',
            cause: `The script allocated more than the ${memoryLimit}MB isolate memory limit.`,
            action:
              'Process data in smaller batches, avoid unbounded allocations, or raise SANDBOX_MEMORY_LIMIT_MB.',
          }),
        );
      }
      throw error;
    } finally {
      try {
        isolate.dispose();
      } catch {
        // Isolate may already be disposed; ignore.
      }
    }
  }
}

function safeParse(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
