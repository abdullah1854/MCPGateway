/**
 * Default sandbox executor factory.
 *
 * Produces concrete executors for the isolation policy. The factory is the single
 * seam through which executors are instantiated, so tests can inject a spy factory
 * to prove that protected fail-closed paths never construct or invoke the vm
 * executor.
 */

import {
  IsolationCapability,
  SandboxExecutor,
  SandboxExecutorFactory,
} from './isolation.js';
import { VmExecutor } from './vm-executor.js';
import { IsolatedVmExecutor } from './isolated-vm-executor.js';

export class DefaultSandboxExecutorFactory implements SandboxExecutorFactory {
  createVmExecutor(): SandboxExecutor {
    return new VmExecutor();
  }

  createIsolatedExecutor(
    capability: IsolationCapability,
    memoryLimitMb: number,
  ): SandboxExecutor {
    if (!capability.available || !capability.isolateModule) {
      throw new Error('Cannot create isolated executor: isolation capability unavailable.');
    }
    return new IsolatedVmExecutor(capability.isolateModule, memoryLimitMb);
  }
}

export const defaultSandboxExecutorFactory = new DefaultSandboxExecutorFactory();
