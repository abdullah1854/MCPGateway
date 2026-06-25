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

      // Injected execution context (params and other JSON-serializable values) is
      // passed across the isolate boundary as a single primitive JSON string, then
      // re-hydrated and bound to top-level identifiers inside the bootstrap so user
      // code can reference it exactly as it would in the vm path. Host functions and
      // other non-serializable values are dropped so they cannot leak host scope.
      const safeContext = sanitizeContext(req.context);
      jail.setSync('_hostContextJson', JSON.stringify(safeContext));

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
        const _ctx = JSON.parse(_hostContextJson);
        ${buildContextDeclarations(safeContext)}
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

/**
 * Reduce injected context to JSON-serializable values only. Functions, symbols,
 * `undefined`, and circular/non-serializable values are dropped so a host closure
 * can never execute with host scope inside the isolate.
 */
function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
      continue;
    }
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        continue;
      }
      safe[key] = JSON.parse(serialized);
    } catch {
      // Non-serializable (e.g. circular) values are intentionally dropped.
    }
  }
  return safe;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED_BINDINGS = new Set([
  'console',
  'callTool',
  'global',
  'globalThis',
  '_ctx',
  '_hostLog',
  '_hostCallTool',
  '_hostContextJson',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'await',
]);

/**
 * Bind each sanitized context key to a top-level `const` inside the bootstrap so
 * user code can reference injected params directly. Keys that are not valid
 * identifiers or that would shadow bootstrap bindings stay reachable via `_ctx`.
 */
function buildContextDeclarations(context: Record<string, unknown>): string {
  const keys = Object.keys(context).filter(
    (key) => IDENTIFIER_PATTERN.test(key) && !RESERVED_BINDINGS.has(key),
  );
  if (keys.length === 0) {
    return '';
  }
  return keys.map((key) => `const ${key} = _ctx[${JSON.stringify(key)}];`).join('\n        ');
}
