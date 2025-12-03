/**
 * Code Executor - Sandboxed Code Execution Mode
 *
 * Allows agents to write and execute code that interacts with MCP tools.
 * This provides massive token savings (98.7% according to Anthropic) by:
 * - Letting agents write loops, conditionals, and data processing
 * - Only returning console.log output instead of full data
 * - Keeping sensitive data in the execution context
 */

import { BackendManager } from '../backend/index.js';
import { MCPResponse } from '../types.js';
import { logger } from '../logger.js';
import * as vm from 'vm';

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

    // Build the sandbox context
    const sandbox: Record<string, unknown> = {
      console: consoleCapture,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      Math,
      RegExp,
      Error,
      Map,
      Set,
      Promise,
      setTimeout: undefined, // Disabled for security
      setInterval: undefined, // Disabled for security
      ...toolFunctions,
      ...context,
    };

    // Create VM context
    const vmContext = vm.createContext(sandbox);

    try {
      // Wrap code in async function to support await
      const wrappedCode = `
        (async () => {
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
