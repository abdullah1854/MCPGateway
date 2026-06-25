/**
 * Deployment profile policy matrix tests.
 *
 * Proves the assigned feature behavior:
 * - VAL-PROFILE-001: shared-local, remote-private, and remote-public enforce the
 *   same sandbox safety floor (no vm) plus the same auth / code-exec allowlist /
 *   CORS security policy, while local-single-user stays permissive.
 * - VAL-PROFILE-002: protected profiles fail closed at config/startup when auth is
 *   disabled, the code-execution allowlist is missing, or wildcard CORS is set
 *   (including a wildcard hidden inside an origin list). local-single-user keeps
 *   intended permissive defaults.
 *
 * Run with: npx tsx src/tests/deployment-profile-policy.test.ts
 */

import assert from 'node:assert/strict';
import { loadGatewayConfig } from '../config.js';
import {
  DeploymentProfile,
  corsConfigHasWildcard,
  getProfileSecurityPolicy,
} from '../deployment-profile.js';
import { decideIsolation, IsolationCapability } from '../code-execution/sandbox/isolation.js';

let failures = 0;

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    process.stdout.write(`• ${name}... `);
    await fn();
    console.log('ok');
  } catch (error) {
    console.log('FAILED');
    console.error(error);
    failures += 1;
    process.exitCode = 1;
  }
}

const PROFILE_ENV_KEYS = [
  'DEPLOYMENT_PROFILE',
  'AUTH_MODE',
  'API_KEYS',
  'CODE_EXECUTION_REQUIRE_ALLOWLIST',
  'CODE_EXECUTION_ALLOWED_TOOLS',
  'CODE_EXECUTION_ALLOWED_TOOL_PREFIXES',
  'CORS_ORIGINS',
  'TRUST_PROXY',
  'PORT',
] as const;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  // Clear every profile-relevant key first so leakage from the ambient
  // environment cannot mask a fail-closed expectation.
  for (const key of PROFILE_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (!previous.has(key)) {
      previous.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Minimal valid env for a protected profile (auth + allowlist + explicit CORS). */
function validProtectedEnv(profile: DeploymentProfile): Record<string, string> {
  return {
    DEPLOYMENT_PROFILE: profile,
    AUTH_MODE: 'api-key',
    API_KEYS: 'matrix-key',
    CODE_EXECUTION_REQUIRE_ALLOWLIST: '1',
    CORS_ORIGINS: 'https://app.example.com',
    PORT: '3010',
  };
}

const PROTECTED_PROFILES: DeploymentProfile[] = [
  'shared-local',
  'remote-private',
  'remote-public',
];

const unavailable: IsolationCapability = {
  available: false,
  nodeMajor: 25,
  reason: 'isolated-vm does not support Node 25',
};
const available: IsolationCapability = { available: true, nodeMajor: 22, isolateModule: {} };

async function main(): Promise<void> {
  console.log('Running deployment profile policy matrix tests...\n');

  // ---- VAL-PROFILE-001: shared sandbox safety floor + shared security policy ----

  await runTest('VAL-PROFILE-001: protected profiles share the sandbox safety floor (never vm)', () => {
    for (const profile of PROTECTED_PROFILES) {
      for (const isolateRequested of [false, true]) {
        const denied = decideIsolation({ profile, isolateRequested, capability: unavailable });
        assert.equal(denied.allowed, false, `${profile} must fail closed without isolation`);
        assert.notEqual(denied.mode, 'vm', `${profile} must never select vm`);
        assert.equal(denied.mode, null, `${profile} fail-closed mode must be null`);

        const allowed = decideIsolation({ profile, isolateRequested, capability: available });
        assert.equal(allowed.allowed, true, `${profile} must allow isolated execution`);
        assert.equal(allowed.mode, 'isolated', `${profile} must select isolated when available`);
      }
    }
  });

  await runTest('VAL-PROFILE-001: protected profiles share auth/allowlist/CORS security policy', () => {
    for (const profile of PROTECTED_PROFILES) {
      const policy = getProfileSecurityPolicy(profile);
      assert.equal(policy.requireAuth, true, `${profile} must require auth`);
      assert.equal(policy.requireCodeExecAllowlist, true, `${profile} must require allowlist`);
      assert.equal(policy.allowWildcardCors, false, `${profile} must reject wildcard CORS`);
    }
  });

  await runTest('VAL-PROFILE-001: local-single-user keeps permissive sandbox + policy contrast', () => {
    const localDecision = decideIsolation({
      profile: 'local-single-user',
      isolateRequested: false,
      capability: unavailable,
    });
    assert.equal(localDecision.allowed, true, 'local-single-user must run without isolation');
    assert.equal(localDecision.mode, 'vm', 'local-single-user uses the vm executor');

    const localPolicy = getProfileSecurityPolicy('local-single-user');
    assert.equal(localPolicy.requireAuth, false);
    assert.equal(localPolicy.requireCodeExecAllowlist, false);
    assert.equal(localPolicy.allowWildcardCors, true);
  });

  // ---- VAL-PROFILE-002: startup/config gates fail closed for protected profiles ----

  await runTest('VAL-PROFILE-002: protected profiles fail closed when auth is disabled', () => {
    for (const profile of PROTECTED_PROFILES) {
      assert.throws(
        () =>
          withEnv(
            { ...validProtectedEnv(profile), AUTH_MODE: 'none', API_KEYS: undefined },
            () => loadGatewayConfig(),
          ),
        /requires AUTH_MODE/,
        `${profile} must reject AUTH_MODE=none`,
      );
    }
  });

  await runTest('VAL-PROFILE-002: protected profiles fail closed without a code-exec allowlist', () => {
    for (const profile of PROTECTED_PROFILES) {
      assert.throws(
        () =>
          withEnv(
            { ...validProtectedEnv(profile), CODE_EXECUTION_REQUIRE_ALLOWLIST: undefined },
            () => loadGatewayConfig(),
          ),
        /requires a code-execution allowlist/,
        `${profile} must reject a missing allowlist`,
      );
    }
  });

  await runTest('VAL-PROFILE-002: protected profiles fail closed on wildcard CORS', () => {
    for (const profile of PROTECTED_PROFILES) {
      assert.throws(
        () =>
          withEnv(
            { ...validProtectedEnv(profile), CORS_ORIGINS: '*' },
            () => loadGatewayConfig(),
          ),
        /does not allow CORS_ORIGINS=\*/,
        `${profile} must reject wildcard CORS`,
      );
    }
  });

  await runTest('VAL-PROFILE-002: protected profiles fail closed on wildcard hidden inside an origin list', () => {
    for (const profile of PROTECTED_PROFILES) {
      assert.throws(
        () =>
          withEnv(
            { ...validProtectedEnv(profile), CORS_ORIGINS: 'https://app.example.com,*' },
            () => loadGatewayConfig(),
          ),
        /does not allow CORS_ORIGINS=\*/,
        `${profile} must reject a wildcard buried in a CORS list`,
      );
    }
  });

  await runTest('VAL-PROFILE-002: protected profiles accept a fully compliant config', () => {
    for (const profile of PROTECTED_PROFILES) {
      const config = withEnv(validProtectedEnv(profile), () => loadGatewayConfig());
      assert.equal(config.deploymentProfile, profile);
      assert.equal(config.auth.mode, 'api-key');
      assert.notEqual(config.cors.origins, '*');
    }
  });

  await runTest('VAL-PROFILE-002: local-single-user keeps permissive defaults', () => {
    const config = withEnv(
      {
        DEPLOYMENT_PROFILE: 'local-single-user',
        AUTH_MODE: 'none',
        CORS_ORIGINS: '*',
        PORT: '3010',
      },
      () => loadGatewayConfig(),
    );
    assert.equal(config.deploymentProfile, 'local-single-user');
    assert.equal(config.auth.mode, 'none');
    assert.equal(config.cors.origins, '*');
  });

  // ---- CORS wildcard detection helper -------------------------------------------

  await runTest('VAL-PROFILE-002: corsConfigHasWildcard detects string and list wildcards', () => {
    assert.equal(corsConfigHasWildcard('*'), true);
    assert.equal(corsConfigHasWildcard(['*']), true);
    assert.equal(corsConfigHasWildcard(['https://app.example.com', '*']), true);
    assert.equal(corsConfigHasWildcard('https://app.example.com'), false);
    assert.equal(corsConfigHasWildcard(['https://a.example.com', 'https://b.example.com']), false);
  });

  console.log(
    `\nDeployment profile policy tests completed${failures ? ` with ${failures} failure(s)` : ''}.`,
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
