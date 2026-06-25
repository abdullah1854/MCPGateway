/**
 * VM-based sandbox executor.
 *
 * Wraps Node's built-in `vm` module. This is NOT a security boundary and is only
 * selected for the trusted `local-single-user` profile (see isolation policy). It
 * preserves the historical execution semantics: async IIFE wrapper, frozen
 * sandbox, codeGeneration disabled, synchronous vm timeout, and a wall-clock race
 * so awaited work cannot hang past the timeout.
 */

import * as vm from 'vm';
import { agentError } from '../../errors/agent-errors.js';
import { SandboxExecuteRequest, SandboxExecutor } from './isolation.js';

export class VmExecutor implements SandboxExecutor {
  readonly mode = 'vm' as const;

  async execute(req: SandboxExecuteRequest): Promise<unknown> {
    const sandbox = req.buildVmSandbox();

    const vmContext = vm.createContext(sandbox, {
      codeGeneration: {
        strings: false,
        wasm: false,
      },
    });

    const timeoutMs = Number.isFinite(req.timeoutMs) ? Math.max(req.timeoutMs, 1) : 30000;

    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            agentError({
              what: `Code execution timed out after ${timeoutMs}ms.`,
              cause: 'The script ran too long or awaited a slow tool call.',
              action:
                'Reduce batch size, add filters/maxRows on tool calls, or increase the timeout option.',
            }),
          ),
        );
      }, timeoutMs);
    });

    try {
      const wrappedCode = `
        'use strict';
        (async () => {
          // Block constructor access attempts
          const _blocked = () => { throw new Error('Access denied'); };
          ${req.code}
        })()
      `;

      const script = new vm.Script(wrappedCode, {
        filename: 'user-code.js',
      });

      const runPromise = script.runInContext(vmContext, {
        timeout: timeoutMs,
        breakOnSigint: true,
      });

      return await Promise.race([runPromise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
