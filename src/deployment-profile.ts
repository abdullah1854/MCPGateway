/**
 * Deployment profiles — security presets for different gateway exposure levels.
 *
 * Profiles map to industry-standard MCP deployment modes:
 * - local-single-user: stdio/localhost dev (permissive defaults)
 * - shared-local: LAN/shared machine (auth + allowlists)
 * - remote-private: VPN/tunnel remote access (auth + explicit CORS)
 * - remote-public: internet-facing (strictest)
 */

import { GatewayConfig } from './types.js';
import { logger } from './logger.js';

export type DeploymentProfile =
  | 'local-single-user'
  | 'shared-local'
  | 'remote-private'
  | 'remote-public';

const PROFILE_ALIASES: Record<string, DeploymentProfile> = {
  local: 'local-single-user',
  'local-single-user': 'local-single-user',
  shared: 'shared-local',
  'shared-local': 'shared-local',
  remote: 'remote-private',
  'remote-private': 'remote-private',
  public: 'remote-public',
  'remote-public': 'remote-public',
};

export interface ProfileSecurityPolicy {
  profile: DeploymentProfile;
  /** Require AUTH_MODE !== none */
  requireAuth: boolean;
  /** Require CODE_EXECUTION_REQUIRE_ALLOWLIST or explicit allowed tools/prefixes */
  requireCodeExecAllowlist: boolean;
  /** Wildcard CORS (*) is only safe in local-single-user */
  allowWildcardCors: boolean;
  /** Whether X-Forwarded-For may be used for rate limiting */
  trustProxy: boolean;
  requireRedisStore: boolean;
}

export function parseDeploymentProfile(raw?: string): DeploymentProfile {
  const normalized = (raw ?? 'local-single-user').trim().toLowerCase();
  const profile = PROFILE_ALIASES[normalized];
  if (!profile) {
    throw new Error(
      `Invalid DEPLOYMENT_PROFILE "${raw}". Use local-single-user, shared-local, remote-private, or remote-public.`,
    );
  }
  return profile;
}

export function getProfileSecurityPolicy(profile: DeploymentProfile): ProfileSecurityPolicy {
  switch (profile) {
    case 'local-single-user':
      return {
        profile,
        requireAuth: false,
        requireCodeExecAllowlist: false,
        allowWildcardCors: true,
        trustProxy: false,
        requireRedisStore: false,
      };
    case 'shared-local':
      return {
        profile,
        requireAuth: true,
        requireCodeExecAllowlist: true,
        allowWildcardCors: false,
        trustProxy: process.env.TRUST_PROXY === '1',
        requireRedisStore: false,
      };
    case 'remote-private':
      return {
        profile,
        requireAuth: true,
        requireCodeExecAllowlist: true,
        allowWildcardCors: false,
        trustProxy: process.env.TRUST_PROXY === '1',
        requireRedisStore: false,
      };
    case 'remote-public':
      return {
        profile,
        requireAuth: true,
        requireCodeExecAllowlist: true,
        allowWildcardCors: false,
        trustProxy: process.env.TRUST_PROXY === '1',
        requireRedisStore: true,
      };
  }
}

/**
 * Detect a wildcard CORS origin regardless of whether origins are configured as a
 * bare `"*"` string or a `"*"` entry buried inside an explicit origin list. A
 * wildcard hidden in a list must still trip the protected-profile fail-closed gate.
 */
export function corsConfigHasWildcard(origins: string | string[]): boolean {
  if (Array.isArray(origins)) {
    return origins.some(origin => origin.trim() === '*');
  }
  return origins.trim() === '*';
}

function hasCodeExecAllowlist(): boolean {
  const requireAllowlist = process.env.CODE_EXECUTION_REQUIRE_ALLOWLIST === '1';
  const allowedTools = (process.env.CODE_EXECUTION_ALLOWED_TOOLS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const allowedPrefixes = (process.env.CODE_EXECUTION_ALLOWED_TOOL_PREFIXES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return requireAllowlist || allowedTools.length > 0 || allowedPrefixes.length > 0;
}

/**
 * Validate that runtime env satisfies the active deployment profile.
 * Throws on hard violations so shared/remote profiles fail closed at startup.
 */
export function validateProfileCompliance(config: GatewayConfig): void {
  const policy = getProfileSecurityPolicy(config.deploymentProfile);

  if (policy.requireAuth && config.auth.mode === 'none') {
    throw new Error(
      `DEPLOYMENT_PROFILE=${policy.profile} requires AUTH_MODE=api-key or oauth. ` +
        'Set AUTH_MODE and API_KEYS (or OAuth settings) before starting.',
    );
  }

  if (policy.requireCodeExecAllowlist && !hasCodeExecAllowlist()) {
    throw new Error(
      `DEPLOYMENT_PROFILE=${policy.profile} requires a code-execution allowlist. ` +
        'Set CODE_EXECUTION_REQUIRE_ALLOWLIST=1 and/or CODE_EXECUTION_ALLOWED_TOOLS or CODE_EXECUTION_ALLOWED_TOOL_PREFIXES.',
    );
  }

  const corsIsWildcard = corsConfigHasWildcard(config.cors.origins);
  if (!policy.allowWildcardCors && corsIsWildcard) {
    throw new Error(
      `DEPLOYMENT_PROFILE=${policy.profile} does not allow CORS_ORIGINS=*. ` +
        'Set CORS_ORIGINS to an explicit comma-separated origin list.',
    );
  }

  if (policy.requireRedisStore && config.store.backend !== 'redis') {
    throw new Error(
      `DEPLOYMENT_PROFILE=${policy.profile} requires STORE_BACKEND=redis for shared rate-limit and session state.`,
    );
  }

  if (policy.profile !== 'local-single-user' && corsIsWildcard) {
    logger.warn(
      'Wildcard CORS with credentials is unsafe; use explicit origins for non-local profiles',
      { profile: policy.profile },
    );
  }

  logger.info('Deployment profile validated', {
    profile: policy.profile,
    authMode: config.auth.mode,
    corsOrigins: config.cors.origins,
    trustProxy: config.trustedProxy,
    storeBackend: config.store.backend,
    codeExecAllowlist: hasCodeExecAllowlist(),
  });
}

export function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}
