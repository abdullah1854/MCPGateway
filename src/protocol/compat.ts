import { MCPServerCapabilities } from '../types.js';

export function supportsCompletion(capabilities: MCPServerCapabilities | undefined): boolean {
  return Boolean(capabilities?.completions ?? capabilities?.completion);
}

export function buildCompletionCapability(
  hasCompletionSupport: boolean,
): Pick<MCPServerCapabilities, 'completions'> {
  return hasCompletionSupport ? { completions: {} } : {};
}
