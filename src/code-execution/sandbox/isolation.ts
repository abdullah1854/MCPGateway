/**
 * Sandbox isolation policy and executor selection.
 *
 * The gateway supports two code-execution backends:
 * - `vm`: Node's built-in `vm` module. Fast, zero-dependency, but NOT a security
 *   boundary. Only acceptable for the trusted `local-single-user` profile.
 * - `isolated`: a real V8 isolate (via the optional native `isolated-vm` module)
 *   with hard memory limits and true context separation.
 *
 * Protected profiles (anything other than `local-single-user`) and explicit
 * `SANDBOX_ISOLATE=1` requests require strong isolation. When strong isolation is
 * required but unavailable or unsupported (e.g. the native module is missing or the
 * running Node major is not a supported `isolated-vm` target), code execution must
 * FAIL CLOSED and must never silently fall back to `vm`.
 */

import { DeploymentProfile } from '../../deployment-profile.js';

export type SandboxMode = 'vm' | 'isolated';

/** Result of probing whether strong (isolated-vm) isolation can be used. */
export interface IsolationCapability {
  available: boolean;
  nodeMajor: number;
  /** Reason isolation is unavailable (only set when available === false). */
  reason?: string;
  /** Loaded `isolated-vm` module (only set when available === true). */
  isolateModule?: unknown;
}

export interface IsolationDecisionInput {
  profile: DeploymentProfile;
  isolateRequested: boolean;
  capability: IsolationCapability;
}

export type IsolationDecision =
  | { allowed: true; mode: SandboxMode; reason: string }
  | { allowed: false; mode: null; reason: string; detail: string };

/**
 * `isolated-vm` ships prebuilt native bindings only for a bounded range of Node
 * majors. The current mission target (Node 25) is NOT a supported isolated-vm
 * runtime, so protected execution on it must fail closed rather than pretend to be
 * isolated or silently use `vm`.
 */
const MIN_SUPPORTED_NODE_MAJOR = 20;
const MAX_SUPPORTED_NODE_MAJOR = 24;

export function getNodeMajor(version: string = process.versions.node): number {
  const major = parseInt(version.split('.')[0], 10);
  return Number.isFinite(major) ? major : 0;
}

export function nodeSupportsIsolatedVm(nodeMajor: number): boolean {
  return nodeMajor >= MIN_SUPPORTED_NODE_MAJOR && nodeMajor <= MAX_SUPPORTED_NODE_MAJOR;
}

export function isProtectedProfile(profile: DeploymentProfile): boolean {
  return profile !== 'local-single-user';
}

/**
 * Decide which executor (if any) may run code for the given profile/env.
 * Never returns `mode: 'vm'` for protected profiles or when isolation is requested.
 */
export function decideIsolation(input: IsolationDecisionInput): IsolationDecision {
  const protectedProfile = isProtectedProfile(input.profile);
  const strongIsolationRequired = protectedProfile || input.isolateRequested;

  if (!strongIsolationRequired) {
    return {
      allowed: true,
      mode: 'vm',
      reason: 'local-single-user trusted profile uses the vm executor',
    };
  }

  if (input.capability.available) {
    return {
      allowed: true,
      mode: 'isolated',
      reason: protectedProfile
        ? `profile "${input.profile}" requires isolated execution`
        : 'SANDBOX_ISOLATE=1 requires isolated execution',
    };
  }

  const requirement = protectedProfile
    ? `deployment profile "${input.profile}" requires strong isolation for code execution`
    : 'SANDBOX_ISOLATE=1 requires strong isolation for code execution';

  return {
    allowed: false,
    mode: null,
    reason: requirement,
    detail:
      input.capability.reason ??
      'isolated execution (isolated-vm) is unavailable on this runtime',
  };
}

let cachedCapability: IsolationCapability | undefined;

/** Reset the cached capability probe (test helper). */
export function resetIsolationCapabilityCache(): void {
  cachedCapability = undefined;
}

/**
 * Probe whether strong isolation can be used. The native `isolated-vm` dependency
 * is OPTIONAL: a missing module, a load failure, or an unsupported Node major all
 * resolve to `{ available: false }` with a descriptive reason rather than throwing.
 */
export async function probeIsolationCapability(opts?: {
  force?: boolean;
}): Promise<IsolationCapability> {
  if (cachedCapability && !opts?.force) {
    return cachedCapability;
  }

  const nodeMajor = getNodeMajor();

  if (!nodeSupportsIsolatedVm(nodeMajor)) {
    cachedCapability = {
      available: false,
      nodeMajor,
      reason: `isolated-vm does not support Node ${process.versions.node} (supported Node majors: ${MIN_SUPPORTED_NODE_MAJOR}-${MAX_SUPPORTED_NODE_MAJOR})`,
    };
    return cachedCapability;
  }

  try {
    // Indirect specifier so the optional native dependency is not a hard
    // compile/runtime requirement when it is not installed.
    const moduleName = 'isolated-vm';
    const imported = (await import(moduleName)) as { default?: unknown };
    const isolateModule = imported.default ?? imported;
    cachedCapability = { available: true, nodeMajor, isolateModule };
  } catch (err) {
    cachedCapability = {
      available: false,
      nodeMajor,
      reason: `isolated-vm native module is not installed or failed to load: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return cachedCapability;
}

export interface SandboxConsole {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

export interface SandboxToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type SandboxToolFunction = (...args: unknown[]) => Promise<SandboxToolResult>;

/** Everything an executor needs to run one snippet. */
export interface SandboxExecuteRequest {
  code: string;
  timeoutMs: number;
  memoryLimitMb: number;
  /** Builds the frozen vm sandbox context (vm executor only). */
  buildVmSandbox: () => Record<string, unknown>;
  consoleCapture: SandboxConsole;
  toolFunctions: Record<string, SandboxToolFunction>;
  context: Record<string, unknown>;
}

export interface SandboxExecutor {
  readonly mode: SandboxMode;
  execute(req: SandboxExecuteRequest): Promise<unknown>;
}

export interface SandboxExecutorFactory {
  createVmExecutor(): SandboxExecutor;
  createIsolatedExecutor(
    capability: IsolationCapability,
    memoryLimitMb: number,
  ): SandboxExecutor;
}

/** Distinguishes an isolate memory-limit failure from a wall-clock timeout. */
export function isMemoryLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /memory limit|heap (?:out of memory|limit)|out of memory|reached heap/i.test(
    message,
  );
}
