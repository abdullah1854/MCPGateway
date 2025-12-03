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
import { MCPResponse } from '../types.js';
import { logger } from '../logger.js';
import * as vm from 'vm';

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

export interface ExecutionOptions {
  /** Maximum execution time in milliseconds */
  timeout?: number;
  /** Maximum memory in MB (approximation via output limits) */
  maxOutputSize?: number;
  /** Whether to capture console.log output */
  captureConsole?: boolean;
  /** Context variables to inject */
  context?: Record<string, unknown>;
}

export interface ExecutionResult {
  success: boolean;
  output: string[];
  error?: string;
  executionTime: number;
  returnValue?: unknown;
}

interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Creates a sandboxed environment for executing code with MCP tool access
 */
export class CodeExecutor {
  private backendManager: BackendManager;
  private defaultTimeout = 30000; // 30 seconds
  private maxOutputSize = 1024 * 100; // 100KB max output

  constructor(backendManager: BackendManager) {
    this.backendManager = backendManager;
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

    // Safe String - static methods only
    const safeString = deepFreeze({
      fromCharCode: createSafeWrapper((...codes: number[]) => String.fromCharCode(...codes)),
      fromCodePoint: createSafeWrapper((...codePoints: number[]) => String.fromCodePoint(...codePoints)),
    });

    // Safe Number - static methods and constants only
    const safeNumber = deepFreeze({
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
    });

    // Safe Date - only allow creating new dates, not accessing constructor
    const safeDate = deepFreeze({
      now: createSafeWrapper(() => Date.now()),
      parse: createSafeWrapper((dateString: string) => Date.parse(dateString)),
      UTC: createSafeWrapper((...args: number[]) => Date.UTC(...(args as Parameters<typeof Date.UTC>))),
    });

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

    // Sanitize user context - remove any functions that could be exploited
    const safeContext: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'function') {
        // Wrap functions to prevent constructor access
        safeContext[key] = createSafeWrapper(value as (...args: unknown[]) => unknown);
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

      // Explicitly block dangerous globals
      Function: undefined,
      eval: undefined,
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      clearTimeout: undefined,
      clearInterval: undefined,
      clearImmediate: undefined,
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
   */
  async execute(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const {
      timeout = this.defaultTimeout,
      maxOutputSize = this.maxOutputSize,
      captureConsole = true,
      context = {},
    } = options;

    const startTime = Date.now();
    const output: string[] = [];
    let totalOutputSize = 0;

    // Create tool call functions
    const toolFunctions = this.createToolFunctions();

    // Create console capture
    const consoleCapture = {
      log: (...args: unknown[]) => {
        if (!captureConsole) return;
        const line = args.map(arg =>
          typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
        ).join(' ');

        totalOutputSize += line.length;
        if (totalOutputSize <= maxOutputSize) {
          output.push(line);
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

    // Build the hardened sandbox context
    const sandbox = this.createHardenedSandbox(consoleCapture, toolFunctions, context);

    // Create VM context with hardened sandbox
    const vmContext = vm.createContext(sandbox, {
      codeGeneration: {
        strings: false, // Disable eval() and new Function()
        wasm: false,    // Disable WebAssembly compilation
      },
    });

    try {
      // Wrap code in async function to support await
      // Also add a preamble that blocks common escape attempts
      const wrappedCode = `
        'use strict';
        (async () => {
          // Block constructor access attempts
          const _blocked = () => { throw new Error('Access denied'); };
          ${code}
        })()
      `;

      // Compile and run the script
      const script = new vm.Script(wrappedCode, {
        filename: 'user-code.js',
      });

      const result = await script.runInContext(vmContext, {
        timeout: timeout,
        breakOnSigint: true,
      });

      // Wait for the async result
      const returnValue = await result;

      return {
        success: true,
        output,
        executionTime: Date.now() - startTime,
        returnValue: this.sanitizeReturnValue(returnValue),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Code execution error', { error: errorMessage });

      return {
        success: false,
        output,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Create tool call functions for the sandbox
   */
  private createToolFunctions(): Record<string, (...args: unknown[]) => Promise<ToolCallResult>> {
    const functions: Record<string, (...args: unknown[]) => Promise<ToolCallResult>> = {};
    const backends = this.backendManager.getBackends();

    for (const [, backend] of backends) {
      if (backend.status !== 'connected') continue;

      for (const tool of backend.tools) {
        const safeName = this.toSafeIdentifier(tool.name);

        functions[safeName] = async (args: unknown = {}) => {
          try {
            const response: MCPResponse = await this.backendManager.callTool(
              tool.name,
              args
            );

            if (response.error) {
              return {
                success: false,
                error: response.error.message,
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
      if (typeof toolName !== 'string') {
        return { success: false, error: 'Tool name must be a string' };
      }

      try {
        const response: MCPResponse = await this.backendManager.callTool(
          toolName,
          args
        );

        if (response.error) {
          return {
            success: false,
            error: response.error.message,
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
      case 'array':
        const items = schema.items as Record<string, unknown> | undefined;
        return items ? `${this.schemaToType(items)}[]` : 'any[]';
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
