/**
 * Code Executor - Sandboxed Code Execution Mode
 *
 * Allows agents to write and execute code that interacts with MCP tools.
 * This provides massive token savings (98.7% according to Anthropic) by:
 * - Letting agents write loops, conditionals, and data processing
 * - Only returning console.log output instead of full data
 * - Keeping sensitive data in the execution context
 *
 * SECURITY: This sandbox is hardened against constructor-based escapes by:
 * - Creating safe wrapper objects instead of exposing native constructors
 * - Freezing all exposed objects to prevent prototype pollution
 * - Blocking access to Function, eval, and other dangerous globals
 * - Recursively freezing all objects to prevent prototype chain escapes
 * - Using primitive wrappers that cannot leak constructors
 */

import { BackendManager } from '../backend/index.js';
import { AuthorizationContext, MCPResponse } from '../types.js';
import { logger } from '../logger.js';
import { PIITokenizer, getPIITokenizerForSession } from './pii-tokenizer.js';
import {
  agentError,
  sanitizeErrorMessage,
  toolAllowlistDeniedMessage,
} from '../errors/agent-errors.js';
import { DeploymentProfile, parseDeploymentProfile } from '../deployment-profile.js';
import {
  IsolationCapability,
  SandboxExecutorFactory,
  decideIsolation,
  isProtectedProfile,
  probeIsolationCapability,
} from './sandbox/isolation.js';
import { defaultSandboxExecutorFactory } from './sandbox/factory.js';
import {
  createAnonymousAuthorizationContext,
  enforceAuthorization,
  AuthorizationSource,
} from '../middleware/authorization.js';
import { AuditLogger } from '../monitoring/audit.js';

/**
 * Deep freeze an object and all nested objects to prevent prototype access
 */
function deepFreeze<T extends object>(obj: T, seen = new WeakSet()): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (seen.has(obj)) {
    return obj;
  }
  seen.add(obj);

  // Freeze the object itself
  Object.freeze(obj);

  // Recursively freeze all properties
  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object') {
      deepFreeze(value as object, seen);
    }
  }

  return obj;
}

/**
 * Create a safe primitive wrapper that cannot leak its constructor
 * This wraps values so that .constructor access returns undefined
 */
function createSafeWrapper<T>(fn: T): T {
  if (typeof fn !== 'function') {
    return fn;
  }

  // Create a new function that wraps the original
  const wrapper = function (this: unknown, ...args: unknown[]) {
    return (fn as (...args: unknown[]) => unknown).apply(this, args);
  };

  // Override constructor to prevent escape
  Object.defineProperty(wrapper, 'constructor', {
    value: undefined,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // Freeze the wrapper
  Object.freeze(wrapper);

  return wrapper as T;
}

function safeParseProfile(raw?: string): DeploymentProfile {
  try {
    return parseDeploymentProfile(raw);
  } catch {
    return 'local-single-user';
  }
}

export interface ExecutionOptions {
  /** Maximum execution time in milliseconds */
  timeout?: number;
  /** Maximum memory in MB (approximation via output limits) */
  maxOutputSize?: number;
  /** Whether to capture console.log output */
  captureConsole?: boolean;
  /** Pretty-print objects in console output (more tokens) */
  prettyConsole?: boolean;
  /** Context variables to inject */
  context?: Record<string, unknown>;
  /** Session ID to scope stateful features like PII tokenization */
  sessionId?: string;
  authorization?: AuthorizationContext;
  auditLogger?: AuditLogger;
  source?: AuthorizationSource;
}

export type SandboxErrorKind =
  | 'syntax'
  | 'timeout'
  | 'tool_not_found'
  | 'reference'
  | 'runtime'
  | 'security';

export interface ExecutionResult {
  success: boolean;
  output: string[];
  error?: string;
  /** Classified error category for agent-friendly handling */
  errorKind?: SandboxErrorKind;
  /** Actionable tips — present on both success and failure */
  hints?: string[];
  executionTime: number;
  returnValue?: unknown;
}

const SANDBOX_EXAMPLES = {
  basicCall: `const r = await callTool('gateway_list_tool_names', { limit: 5 });
console.log(r.success ? r.data : r.error);`,
  filteredCall: `const r = await callTool('gateway_call_tool_filtered', {
  toolName: 'your_backend_tool',
  args: {},
  filter: { maxRows: 10, format: 'summary' },
});
console.log(r);`,
  batch: `const [a, b] = await Promise.all([
  callTool('tool_one', {}),
  callTool('tool_two', {}),
]);
console.log({ a: a.data, b: b.data });`,
} as const;

function classifySandboxError(message: string, error: unknown): SandboxErrorKind {
  const lower = message.toLowerCase();

  if (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
  ) {
    return 'timeout';
  }

  if (
    error instanceof SyntaxError ||
    lower.includes('syntaxerror') ||
    lower.includes('unexpected token') ||
    lower.includes('unexpected identifier') ||
    lower.includes('invalid or unexpected token')
  ) {
    return 'syntax';
  }

  if (lower.includes('access denied') || lower.includes('code generation')) {
    return 'security';
  }

  const refMatch = message.match(/(?:ReferenceError:\s*)?([A-Za-z_][A-Za-z0-9_]*) is not defined$/);
  if (refMatch) {
    const name = refMatch[1];
    if (name.includes('_') || name.endsWith('Tool') || /^[a-z]+_[a-z0-9_]+$/i.test(name)) {
      return 'tool_not_found';
    }
    return 'reference';
  }

  if (lower.includes('tool not found') || lower.includes('not registered with any connected backend') || lower.includes('tool not allowed')) {
    return 'tool_not_found';
  }

  return 'runtime';
}

function formatSandboxError(
  kind: SandboxErrorKind,
  rawMessage: string,
  timeoutMs: number
): { error: string; hints: string[] } {
  const hints: string[] = [];

  switch (kind) {
    case 'syntax':
      hints.push('Code runs inside an async IIFE — use await at top level; check matching braces/parentheses.');
      hints.push(`Example:\n${SANDBOX_EXAMPLES.basicCall}`);
      return {
        error: `[SYNTAX] ${rawMessage}\nFix the JavaScript/TypeScript syntax above, then retry.`,
        hints,
      };

    case 'timeout':
      hints.push(`Limit is ${timeoutMs}ms. Remove infinite loops; avoid unbounded awaits on slow tools.`);
      hints.push('Use gateway_call_tool_filtered with filter.maxRows for large results instead of loading everything in sandbox.');
      hints.push(`Example:\n${SANDBOX_EXAMPLES.filteredCall}`);
      return {
        error: agentError({
          what: `Code execution timed out after ${timeoutMs}ms.`,
          cause: 'The script ran too long or awaited a slow tool call.',
          action: 'Reduce batch size, add filters/maxRows on tool calls, or increase the timeout option.',
        }),
        hints,
      };

    case 'tool_not_found': {
      const nameMatch = rawMessage.match(/Tool "([^"]+)"|Tool not found: ([^\s.]+)/i);
      const toolName = nameMatch?.[1] ?? nameMatch?.[2];
      hints.push('Discover exact names with gateway_search_tools or gateway_list_tool_names first.');
      hints.push('In sandbox, call await callTool(\'exact_tool_name\', args) — hyphens become underscores in auto-generated helpers only when present.');
      hints.push(`Example:\n${SANDBOX_EXAMPLES.basicCall.replace('gateway_list_tool_names', toolName ?? 'exact_tool_name')}`);
      return {
        error: toolName
          ? agentError({
              what: `Tool "${toolName}" is not available in this sandbox.`,
              cause: 'The tool name may be misspelled, disabled, or its backend is offline.',
              action: 'Call gateway_search_tools or gateway_list_tool_names to find the correct name, then retry.',
            })
          : sanitizeErrorMessage(rawMessage),
        hints,
      };
    }

    case 'reference':
      hints.push('Only sandbox globals, injected context, and registered tool helpers exist.');
      hints.push(`Example:\n${SANDBOX_EXAMPLES.basicCall}`);
      return {
        error: `[REFERENCE] ${rawMessage}`,
        hints,
      };

    case 'security':
      hints.push('eval, Function, require, process, and timers are blocked in the sandbox.');
      hints.push('Use callTool() for MCP tools and console.log() for output.');
      return {
        error: agentError({
          what: 'Code execution blocked a sandbox escape attempt.',
          cause: sanitizeErrorMessage(rawMessage),
          action: 'Use only allowed sandbox APIs and gateway tool functions via callTool().',
        }),
        hints,
      };

    default:
      hints.push('Check console output captured before the failure; use console.log for debugging.');
      hints.push(`Example:\n${SANDBOX_EXAMPLES.basicCall}`);
      return {
        error: `[RUNTIME] ${rawMessage}`,
        hints,
      };
  }
}

function buildSuccessHints(output: string[], returnValue: unknown): string[] {
  const hints = [
    'output[] = console.log lines sent back to you; returnValue = async script result (often undefined if you only log).',
    'Log summaries for large objects: console.log(JSON.stringify({ count: rows.length, sample: rows.slice(0, 3) })).',
  ];

  if (output.length === 0 && (returnValue === undefined || returnValue === null)) {
    hints.push('No output captured — add console.log(...) to return data from gateway_execute_code.');
    hints.push(`Example:\n${SANDBOX_EXAMPLES.basicCall}`);
  }

  if (output.some(line => line.length > 5000)) {
    hints.push('Large console output detected — prefer gateway_call_tool_filtered with filter: { maxRows, format: "summary" }.');
  }

  hints.push(`Batch parallel calls:\n${SANDBOX_EXAMPLES.batch}`);

  return hints;
}

interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface CodeExecutorOptions {
  /** Deployment profile governing isolation policy. Defaults to DEPLOYMENT_PROFILE env. */
  deploymentProfile?: DeploymentProfile;
  /** Whether SANDBOX_ISOLATE=1 was requested. Defaults to the env flag. */
  isolateRequested?: boolean;
  /** Isolate memory limit in MB. Defaults to SANDBOX_MEMORY_LIMIT_MB or 128. */
  memoryLimitMb?: number;
  /** Executor factory (injectable for tests/spies). */
  executorFactory?: SandboxExecutorFactory;
  /** Isolation capability probe (injectable for tests). */
  isolationProbe?: (opts?: { force?: boolean }) => Promise<IsolationCapability>;
}

/**
 * Creates a sandboxed environment for executing code with MCP tool access
 */
export class CodeExecutor {
  private backendManager: BackendManager;
  private defaultTimeout = 30000; // 30 seconds
  private maxOutputSize = 1024 * 100; // 100KB max output

  private enforceToolAllowlist: boolean;
  private allowedToolNames: Set<string>;
  private allowedToolPrefixes: string[];

  private deploymentProfile: DeploymentProfile;
  private isolateRequested: boolean;
  private memoryLimitMb: number;
  private executorFactory: SandboxExecutorFactory;
  private isolationProbe: (opts?: { force?: boolean }) => Promise<IsolationCapability>;

  constructor(backendManager: BackendManager, options: CodeExecutorOptions = {}) {
    this.backendManager = backendManager;

    this.deploymentProfile =
      options.deploymentProfile ?? safeParseProfile(process.env.DEPLOYMENT_PROFILE);
    this.isolateRequested = options.isolateRequested ?? process.env.SANDBOX_ISOLATE === '1';
    this.memoryLimitMb =
      options.memoryLimitMb ??
      (Number.parseInt(process.env.SANDBOX_MEMORY_LIMIT_MB ?? '', 10) || 128);
    this.executorFactory = options.executorFactory ?? defaultSandboxExecutorFactory;
    this.isolationProbe = options.isolationProbe ?? probeIsolationCapability;

    const requireAllowlist = process.env.CODE_EXECUTION_REQUIRE_ALLOWLIST === '1';
    const allowedTools = (process.env.CODE_EXECUTION_ALLOWED_TOOLS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const allowedPrefixes = (process.env.CODE_EXECUTION_ALLOWED_TOOL_PREFIXES ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    this.allowedToolNames = new Set(allowedTools);
    this.allowedToolPrefixes = allowedPrefixes;
    this.enforceToolAllowlist = requireAllowlist || allowedTools.length > 0 || allowedPrefixes.length > 0;
  }

  private isProgrammaticToolAllowed(toolName: string): boolean {
    if (!this.enforceToolAllowlist) {
      return true;
    }

    if (this.allowedToolNames.has(toolName)) {
      return true;
    }

    for (const prefix of this.allowedToolPrefixes) {
      if (toolName.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  private getTokenizer(sessionId: string | undefined): PIITokenizer | null {
    return getPIITokenizerForSession(sessionId);
  }

  /**
   * Generate a TypeScript SDK interface for all available tools
   */
  generateSDK(): string {
    const backends = this.backendManager.getBackends();
    const sdkParts: string[] = [
      '// Auto-generated MCP Tools SDK',
      '// Use these functions to interact with MCP servers',
      '',
    ];

    for (const [backendId, backend] of backends) {
      if (backend.status !== 'connected') continue;

      sdkParts.push(`// === ${backendId} ===`);

      for (const tool of backend.tools) {
        if (!this.isProgrammaticToolAllowed(tool.name)) continue;
        const toolSafeName = this.toSafeIdentifier(tool.name);
        const params = this.generateParamsInterface(tool.inputSchema);

        sdkParts.push(`/**`);
        sdkParts.push(` * ${tool.description || tool.name}`);
        sdkParts.push(` */`);
        sdkParts.push(`async function ${toolSafeName}(${params}): Promise<any>;`);
        sdkParts.push('');
      }
    }

    sdkParts.push('// Helper functions');
    sdkParts.push('function console.log(...args: any[]): void;');
    sdkParts.push('function JSON.stringify(value: any, replacer?: any, space?: number): string;');
    sdkParts.push('function JSON.parse(text: string): any;');

    return sdkParts.join('\n');
  }

  /**
   * Create a hardened sandbox context that prevents escapes via constructor access
   *
   * Security measures:
   * 1. All functions are wrapped to hide their constructors
   * 2. All objects are deep-frozen to prevent prototype pollution
   * 3. Dangerous globals are explicitly set to undefined
   * 4. Return values from tool calls are sanitized
   */
  private createHardenedSandbox(
    consoleCapture: Record<string, (...args: unknown[]) => void>,
    toolFunctions: Record<string, (...args: unknown[]) => Promise<ToolCallResult>>,
    context: Record<string, unknown>
  ): Record<string, unknown> {
    // Create safe versions of built-ins that don't expose constructors
    // All functions are wrapped using createSafeWrapper to prevent .constructor escapes

    const safeJSON = deepFreeze({
      parse: createSafeWrapper((text: string) => JSON.parse(text)),
      stringify: createSafeWrapper((value: unknown, replacer?: unknown, space?: unknown) =>
        JSON.stringify(value, replacer as Parameters<typeof JSON.stringify>[1], space as number)),
    });

    // Create safe Math with all functions wrapped
    const safeMath: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(Math)) {
      const value = (Math as unknown as Record<string, unknown>)[key];
      if (typeof value === 'function') {
        safeMath[key] = createSafeWrapper(value as (...args: unknown[]) => unknown);
      } else {
        safeMath[key] = value;
      }
    }
    deepFreeze(safeMath);

    // Safe Array - expose static methods only, not the constructor
    const safeArray = deepFreeze({
      isArray: createSafeWrapper((arg: unknown) => Array.isArray(arg)),
      from: createSafeWrapper(<T>(iterable: Iterable<T>) => Array.from(iterable)),
      of: createSafeWrapper(<T>(...items: T[]) => Array.of(...items)),
    });

    // Safe Object - expose static methods only
    const safeObject = deepFreeze({
      keys: createSafeWrapper((obj: object) => Object.keys(obj)),
      values: createSafeWrapper((obj: object) => Object.values(obj)),
      entries: createSafeWrapper((obj: object) => Object.entries(obj)),
      assign: createSafeWrapper(<T extends object>(target: T, ...sources: object[]) => Object.assign(target, ...sources)),
      freeze: createSafeWrapper(<T extends object>(obj: T) => Object.freeze(obj)),
      fromEntries: createSafeWrapper((entries: Iterable<readonly [PropertyKey, unknown]>) => Object.fromEntries(entries)),
    });

    // Safe String - callable as String(value) for type conversion, plus static methods
    const safeStringFn = function (...args: unknown[]) {
      return String(...(args as [unknown]));
    };
    Object.defineProperty(safeStringFn, 'constructor', {
      value: undefined, writable: false, configurable: false, enumerable: false,
    });
    (safeStringFn as unknown as Record<string, unknown>).fromCharCode = createSafeWrapper((...codes: number[]) => String.fromCharCode(...codes));
    (safeStringFn as unknown as Record<string, unknown>).fromCodePoint = createSafeWrapper((...codePoints: number[]) => String.fromCodePoint(...codePoints));
    const safeString = Object.freeze(safeStringFn);

    // Safe Number - callable as Number(value) for type conversion, plus static methods and constants
    const safeNumberFn = function (...args: unknown[]) {
      return Number(...(args as [unknown]));
    };
    Object.defineProperty(safeNumberFn, 'constructor', {
      value: undefined, writable: false, configurable: false, enumerable: false,
    });
    const numberStatics: Record<string, unknown> = {
      isNaN: createSafeWrapper((value: unknown) => Number.isNaN(value)),
      isFinite: createSafeWrapper((value: unknown) => Number.isFinite(value)),
      isInteger: createSafeWrapper((value: unknown) => Number.isInteger(value)),
      isSafeInteger: createSafeWrapper((value: unknown) => Number.isSafeInteger(value)),
      parseFloat: createSafeWrapper((string: string) => Number.parseFloat(string)),
      parseInt: createSafeWrapper((string: string, radix?: number) => Number.parseInt(string, radix)),
      MAX_VALUE: Number.MAX_VALUE,
      MIN_VALUE: Number.MIN_VALUE,
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
      NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
      NaN: Number.NaN,
    };
    for (const [k, v] of Object.entries(numberStatics)) {
      (safeNumberFn as unknown as Record<string, unknown>)[k] = v;
    }
    const safeNumber = Object.freeze(safeNumberFn);

    // Safe Date - allows `new Date()` while preventing constructor escapes
    // Returns a safe wrapper object with common date methods wrapped via createSafeWrapper
    function SafeDate(...args: unknown[]): object {
      const realDate = args.length === 0
        ? new Date()
        : new Date(...(args as ConstructorParameters<typeof Date>));

      // Create a safe wrapper that exposes date methods without leaking constructor
      // All methods are wrapped with createSafeWrapper for consistent security model
      const wrapper = {
        getTime: createSafeWrapper(() => realDate.getTime()),
        getFullYear: createSafeWrapper(() => realDate.getFullYear()),
        getMonth: createSafeWrapper(() => realDate.getMonth()),
        getDate: createSafeWrapper(() => realDate.getDate()),
        getDay: createSafeWrapper(() => realDate.getDay()),
        getHours: createSafeWrapper(() => realDate.getHours()),
        getMinutes: createSafeWrapper(() => realDate.getMinutes()),
        getSeconds: createSafeWrapper(() => realDate.getSeconds()),
        getMilliseconds: createSafeWrapper(() => realDate.getMilliseconds()),
        getUTCFullYear: createSafeWrapper(() => realDate.getUTCFullYear()),
        getUTCMonth: createSafeWrapper(() => realDate.getUTCMonth()),
        getUTCDate: createSafeWrapper(() => realDate.getUTCDate()),
        getUTCDay: createSafeWrapper(() => realDate.getUTCDay()),
        getUTCHours: createSafeWrapper(() => realDate.getUTCHours()),
        getUTCMinutes: createSafeWrapper(() => realDate.getUTCMinutes()),
        getUTCSeconds: createSafeWrapper(() => realDate.getUTCSeconds()),
        getUTCMilliseconds: createSafeWrapper(() => realDate.getUTCMilliseconds()),
        getTimezoneOffset: createSafeWrapper(() => realDate.getTimezoneOffset()),
        toISOString: createSafeWrapper(() => realDate.toISOString()),
        toJSON: createSafeWrapper(() => realDate.toJSON()),
        toDateString: createSafeWrapper(() => realDate.toDateString()),
        toTimeString: createSafeWrapper(() => realDate.toTimeString()),
        toLocaleDateString: createSafeWrapper((...localeArgs: unknown[]) => realDate.toLocaleDateString(...(localeArgs as Parameters<typeof realDate.toLocaleDateString>))),
        toLocaleTimeString: createSafeWrapper((...localeArgs: unknown[]) => realDate.toLocaleTimeString(...(localeArgs as Parameters<typeof realDate.toLocaleTimeString>))),
        toLocaleString: createSafeWrapper((...localeArgs: unknown[]) => realDate.toLocaleString(...(localeArgs as Parameters<typeof realDate.toLocaleString>))),
        toString: createSafeWrapper(() => realDate.toString()),
        valueOf: createSafeWrapper(() => realDate.valueOf()),
      };

      // Hide constructor to prevent escape
      Object.defineProperty(wrapper, 'constructor', {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });

      return Object.freeze(wrapper);
    }

    // Add static methods to SafeDate
    (SafeDate as unknown as Record<string, unknown>).now = createSafeWrapper(() => Date.now());
    (SafeDate as unknown as Record<string, unknown>).parse = createSafeWrapper((dateString: string) => Date.parse(dateString));
    (SafeDate as unknown as Record<string, unknown>).UTC = createSafeWrapper((...args: number[]) => Date.UTC(...(args as Parameters<typeof Date.UTC>)));

    // Hide SafeDate's own constructor
    Object.defineProperty(SafeDate, 'constructor', {
      value: undefined,
      writable: false,
      configurable: false,
      enumerable: false,
    });

    const safeDate = Object.freeze(SafeDate);

    // Wrap tool functions to prevent constructor access
    // Return values are sanitized to prevent prototype chain access
    const safeToolFunctions: Record<string, (...args: unknown[]) => Promise<ToolCallResult>> = {};
    for (const [name, fn] of Object.entries(toolFunctions)) {
      // Create a wrapper that can't be used to escape and sanitizes return values
      const wrapper = async (...args: unknown[]): Promise<ToolCallResult> => {
        const result = await fn(...args);
        // Sanitize the result to prevent constructor access on returned objects
        return JSON.parse(JSON.stringify(result)) as ToolCallResult;
      };
      // Override constructor on the wrapper
      Object.defineProperty(wrapper, 'constructor', {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
      safeToolFunctions[name] = Object.freeze(wrapper);
    }

    // Create safe console with wrapped functions
    const safeConsole: Record<string, (...args: unknown[]) => void> = {};
    for (const [name, fn] of Object.entries(consoleCapture)) {
      safeConsole[name] = createSafeWrapper(fn);
    }
    deepFreeze(safeConsole);

    // Sanitize user context - neutralize anything that could leak host capability.
    // Host functions must NEVER execute inside the sandbox (a host closure would run
    // with host scope and could return host globals), so they are dropped entirely.
    const safeContext: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'function') {
        safeContext[key] = undefined;
      } else if (typeof value === 'object' && value !== null) {
        // Deep freeze and sanitize objects via JSON round-trip
        try {
          safeContext[key] = deepFreeze(JSON.parse(JSON.stringify(value)));
        } catch {
          // If not serializable, skip it
          safeContext[key] = undefined;
        }
      } else {
        safeContext[key] = value;
      }
    }

    // Build the final sandbox - explicitly block dangerous globals
    const sandbox: Record<string, unknown> = {
      // Safe built-ins (frozen, no constructor access)
      console: safeConsole,
      JSON: safeJSON,
      Array: safeArray,
      Object: safeObject,
      String: safeString,
      Number: safeNumber,
      Date: safeDate,
      Math: safeMath,

      // Primitives that are safe - wrapped versions
      undefined: undefined,
      null: null,
      NaN: NaN,
      Infinity: Infinity,
      isNaN: createSafeWrapper((value: unknown) => isNaN(value as number)),
      isFinite: createSafeWrapper((value: unknown) => isFinite(value as number)),
      parseFloat: createSafeWrapper((string: string) => parseFloat(string)),
      parseInt: createSafeWrapper((string: string, radix?: number) => parseInt(string, radix)),
      encodeURI: createSafeWrapper((uri: string) => encodeURI(uri)),
      decodeURI: createSafeWrapper((uri: string) => decodeURI(uri)),
      encodeURIComponent: createSafeWrapper((component: string) => encodeURIComponent(component)),
      decodeURIComponent: createSafeWrapper((component: string) => decodeURIComponent(component)),

      // Timer functions - BLOCKED: Scheduled callbacks can execute after execution timeout
      // expires, causing resource exhaustion, memory leaks, or timing side-channel attacks.
      // Sandbox execution must complete within the defined timeout window.
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      clearTimeout: undefined,
      clearInterval: undefined,
      clearImmediate: undefined,

      // Explicitly block dangerous globals
      Function: undefined,
      eval: undefined,
      process: undefined,
      global: undefined,
      globalThis: undefined,
      require: undefined,
      module: undefined,
      exports: undefined,
      __dirname: undefined,
      __filename: undefined,
      Buffer: undefined,
      Proxy: undefined,
      Reflect: undefined,
      WebAssembly: undefined,
      // Also block Symbol which can be used for some escapes
      Symbol: undefined,
      // Block AsyncFunction and GeneratorFunction
      AsyncFunction: undefined,
      GeneratorFunction: undefined,
      AsyncGeneratorFunction: undefined,

      // Tool functions (wrapped and frozen)
      ...safeToolFunctions,

      // User context (sanitized)
      ...safeContext,
    };

    // Deep freeze the entire sandbox
    return deepFreeze(sandbox);
  }

  /**
   * Execute code in a sandboxed environment with access to MCP tools
   *
   * Threat model (high level):
   * - Prevent access to host process (no process, require, globalThis, etc.)
   * - Prevent dynamic code generation (no eval / Function / AsyncFunction)
   * - Make common constructor-based escape patterns fail safely
   * - Bound execution time and output size to reduce DoS risk
   */
  async execute(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const {
      timeout = this.defaultTimeout,
      maxOutputSize = this.maxOutputSize,
      captureConsole = true,
      prettyConsole = false,
      context = {},
      sessionId,
      authorization = createAnonymousAuthorizationContext(),
      auditLogger,
      source = 'sandbox',
    } = options;

    const tokenizer = this.getTokenizer(sessionId);

    const startTime = Date.now();
    const output: string[] = [];
    let totalOutputSize = 0;

    // Once execution settles (success, error, or timeout) no further side effects
    // may be observed. This neutralizes delayed console output, runaway
    // timer/microtask chains, and post-timeout tool calls in the vm path.
    let finished = false;

    const codeDecision = enforceAuthorization({
      action: 'code_execute',
      authorization,
      sessionId,
      source,
    }, auditLogger);
    if (!codeDecision.allowed) {
      return {
        success: false,
        output: [],
        error: agentError({
          what: 'Code execution was denied by authorization policy.',
          cause: codeDecision.reason,
          action: 'Use an API key or OAuth token with the code:execute scope.',
        }),
        errorKind: 'security',
        hints: ['Required scope: code:execute'],
        executionTime: Date.now() - startTime,
      };
    }

    // Resolve the isolation policy BEFORE building or running any sandbox. For
    // protected profiles (and SANDBOX_ISOLATE=1) without available isolation we
    // fail closed here and never construct or invoke the vm executor.
    const strongIsolationRequired =
      isProtectedProfile(this.deploymentProfile) || this.isolateRequested;
    const capability: IsolationCapability = strongIsolationRequired
      ? await this.isolationProbe()
      : { available: false, nodeMajor: 0 };

    const decision = decideIsolation({
      profile: this.deploymentProfile,
      isolateRequested: this.isolateRequested,
      capability,
    });

    if (!decision.allowed) {
      logger.error('Code execution blocked: strong isolation unavailable', {
        profile: this.deploymentProfile,
        isolateRequested: this.isolateRequested,
        reason: decision.reason,
      });
      return {
        success: false,
        output: [],
        error: agentError({
          what: 'Code execution is disabled because strong isolation is unavailable.',
          cause: `${decision.reason}; ${decision.detail}.`,
          action:
            'Run with DEPLOYMENT_PROFILE=local-single-user for trusted local use, or install a supported isolated-vm runtime for protected profiles.',
        }),
        errorKind: 'security',
        hints: [
          'Protected deployment profiles never fall back to the Node vm sandbox.',
          'Strong isolation (isolated-vm) must be available and compatible to run code under this profile.',
        ],
        executionTime: Date.now() - startTime,
      };
    }

    // Create tool call functions
    const toolFunctions = this.createToolFunctions(
      tokenizer,
      () => finished,
      authorization,
      auditLogger,
      source,
      sessionId,
    );

    // Create console capture
    const consoleCapture = {
      log: (...args: unknown[]) => {
        if (!captureConsole || finished) return;
        const line = args
          .map(arg => {
            if (typeof arg === 'object' && arg !== null) {
              try {
                return prettyConsole ? JSON.stringify(arg, null, 2) : JSON.stringify(arg);
              } catch {
                return '[Unserializable object]';
              }
            }
            return String(arg);
          })
          .join(' ');

        const safeLine = tokenizer ? tokenizer.tokenize(line).text : line;

        totalOutputSize += safeLine.length;
        if (totalOutputSize <= maxOutputSize) {
          output.push(safeLine);
        } else if (output[output.length - 1] !== '[Output truncated...]') {
          output.push('[Output truncated...]');
        }
      },
      error: (...args: unknown[]) => {
        consoleCapture.log('[ERROR]', ...args);
      },
      warn: (...args: unknown[]) => {
        consoleCapture.log('[WARN]', ...args);
      },
      info: (...args: unknown[]) => {
        consoleCapture.log('[INFO]', ...args);
      },
    };

    const timeoutMs = Number.isFinite(timeout) ? Math.max(timeout, 1) : this.defaultTimeout;

    const executor =
      decision.mode === 'isolated'
        ? this.executorFactory.createIsolatedExecutor(capability, this.memoryLimitMb)
        : this.executorFactory.createVmExecutor();

    try {
      const returnValue = await executor.execute({
        code,
        timeoutMs,
        memoryLimitMb: this.memoryLimitMb,
        buildVmSandbox: () =>
          this.createHardenedSandbox(consoleCapture, toolFunctions, context),
        consoleCapture,
        toolFunctions,
        context,
      });

      finished = true;

      const sanitizedReturnValue = this.sanitizeReturnValue(returnValue);
      const tokenizedReturnValue = tokenizer
        ? tokenizer.tokenizeObject(sanitizedReturnValue).result
        : sanitizedReturnValue;

      return {
        success: true,
        output,
        hints: buildSuccessHints(output, tokenizedReturnValue),
        executionTime: Date.now() - startTime,
        returnValue: tokenizedReturnValue,
      };
    } catch (error) {
      finished = true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorKind = classifySandboxError(errorMessage, error);
      const formatted = formatSandboxError(errorKind, errorMessage, timeoutMs);
      logger.error('Code execution error', { error: errorMessage, errorKind });

      return {
        success: false,
        output,
        error: formatted.error,
        errorKind,
        hints: formatted.hints,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Create tool call functions for the sandbox
   */
  private createToolFunctions(
    tokenizer: PIITokenizer | null,
    isFinished: () => boolean = () => false,
    authorization: AuthorizationContext = createAnonymousAuthorizationContext(),
    auditLogger?: AuditLogger,
    source: AuthorizationSource = 'sandbox',
    sessionId?: string,
  ): Record<string, (...args: unknown[]) => Promise<ToolCallResult>> {
    const functions: Record<string, (...args: unknown[]) => Promise<ToolCallResult>> = {};
    const backends = this.backendManager.getBackends();

    const finishedResult = (): ToolCallResult => ({
      success: false,
      error: 'Code execution already finished; tool calls after completion are blocked.',
    });

    for (const [, backend] of backends) {
      if (backend.status !== 'connected') continue;

      for (const tool of backend.tools) {
        if (!this.isProgrammaticToolAllowed(tool.name)) continue;
        const safeName = this.toSafeIdentifier(tool.name);

        functions[safeName] = async (args: unknown = {}) => {
          if (isFinished()) return finishedResult();
          const decision = enforceAuthorization({
            action: 'tool_call',
            authorization,
            toolName: tool.name,
            sessionId,
            source,
          }, auditLogger);
          if (!decision.allowed) {
            return { success: false, error: decision.reason };
          }
          try {
            const response: MCPResponse = await this.backendManager.callTool(
              tool.name,
              tokenizer ? tokenizer.detokenizeObject(args) : args
            );

            if (response.error) {
              const msg = response.error.message;
              const isNotFound = /tool not found|not registered with any connected backend/i.test(msg);
              return {
                success: false,
                error: isNotFound
                  ? `${msg} Use gateway_search_tools to find the exact name.`
                  : msg,
              };
            }

            return {
              success: true,
              data: response.result,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        };
      }
    }

    // Add a generic callTool function
    functions['callTool'] = async (toolName: unknown, args: unknown = {}) => {
      if (isFinished()) return finishedResult();
      if (typeof toolName !== 'string') {
        return {
          success: false,
          error: agentError({
            what: 'callTool requires a string tool name.',
            cause: 'The first argument was not a string.',
            action: 'Pass a valid tool name string; use gateway_search_tools to discover names.',
          }),
        };
      }

      if (!this.isProgrammaticToolAllowed(toolName)) {
        return { success: false, error: toolAllowlistDeniedMessage(toolName) };
      }
      const decision = enforceAuthorization({
        action: 'tool_call',
        authorization,
        toolName,
        sessionId,
        source,
      }, auditLogger);
      if (!decision.allowed) {
        return { success: false, error: decision.reason };
      }

      try {
        const response: MCPResponse = await this.backendManager.callTool(
          toolName,
          tokenizer ? tokenizer.detokenizeObject(args) : args
        );

        if (response.error) {
          const msg = response.error.message;
          const isNotFound = /tool not found|not registered with any connected backend/i.test(msg);
          return {
            success: false,
            error: isNotFound
              ? `${msg} Use gateway_search_tools to find the exact name.`
              : msg,
          };
        }

        return {
          success: true,
          data: response.result,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    return functions;
  }

  /**
   * Convert a tool name to a safe JavaScript identifier
   */
  private toSafeIdentifier(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  /**
   * Generate TypeScript params interface from JSON schema
   */
  private generateParamsInterface(schema: { properties?: Record<string, unknown>; required?: string[] }): string {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      return '';
    }

    const required = new Set(schema.required || []);
    const params: string[] = [];

    for (const [name, prop] of Object.entries(schema.properties)) {
      const optional = required.has(name) ? '' : '?';
      const type = this.schemaToType(prop as Record<string, unknown>);
      params.push(`${name}${optional}: ${type}`);
    }

    return `params: { ${params.join('; ')} }`;
  }

  /**
   * Convert JSON schema type to TypeScript type
   */
  private schemaToType(schema: Record<string, unknown>): string {
    const type = schema.type as string;

    switch (type) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array': {
        const items = schema.items as Record<string, unknown> | undefined;
        return items ? `${this.schemaToType(items)}[]` : 'any[]';
      }
      case 'object':
        return 'Record<string, any>';
      default:
        return 'any';
    }
  }

  /**
   * Sanitize return value for safe serialization
   */
  private sanitizeReturnValue(value: unknown): unknown {
    if (value === undefined || value === null) {
      return value;
    }

    // Handle circular references and large objects
    try {
      const str = JSON.stringify(value);
      if (str.length > this.maxOutputSize) {
        return '[Return value too large]';
      }
      return JSON.parse(str);
    } catch {
      return '[Unable to serialize return value]';
    }
  }
}
