import { strict as assert } from 'assert';
import express, { NextFunction, Request, Response } from 'express';
import { AddressInfo } from 'net';
import {
  createApiKeyAuthorizationContext,
  createOAuthAuthorizationContext,
  enforceAuthorization,
  evaluateAuthorization,
} from '../middleware/authorization.js';
import { AuditLogger } from '../monitoring/audit.js';
import { CodeExecutor } from '../code-execution/executor.js';
import { BackendManager } from '../backend/index.js';
import { createCodeExecutionRoutes } from '../code-execution/routes.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

let failures = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`• ${name}... `);
  try {
    await fn();
    console.log('ok');
  } catch (error) {
    failures++;
    console.log('FAILED');
    console.error(error);
  }
}

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('Running authorization policy tests...\n');

  await runTest('AUTHZ-001: OAuth scope claims authorize matching tool scopes', () => {
    const auth = createOAuthAuthorizationContext({
      sub: 'user-1',
      scope: 'gateway:call tool:allowed_tool',
    });

    assert.equal(auth.subject, 'user-1');
    assert.deepEqual(auth.scopes, ['gateway:call', 'tool:allowed_tool']);
    assert.equal(evaluateAuthorization({
      action: 'tool_call',
      authorization: auth,
      toolName: 'allowed_tool',
      source: 'mcp',
    }).allowed, true);
    assert.equal(evaluateAuthorization({
      action: 'tool_call',
      authorization: auth,
      toolName: 'denied_tool',
      source: 'mcp',
    }).allowed, false);
  });

  await runTest('AUTHZ-001: API key identity and scopes come from env mapping', () => {
    withEnv({
      API_KEY_IDENTITIES: 'key-a=service-a',
      API_KEY_SCOPES: 'key-a=code:execute tool:*',
      API_KEY_DEFAULT_SCOPES: 'gateway:call',
    }, () => {
      const mapped = createApiKeyAuthorizationContext('key-a');
      assert.equal(mapped.subject, 'service-a');
      assert.deepEqual(mapped.scopes, ['code:execute', 'tool:*']);

      const fallback = createApiKeyAuthorizationContext('key-b');
      assert.match(fallback.subject, /^api-key:[a-f0-9]{12}$/);
      assert.deepEqual(fallback.scopes, ['gateway:call']);
    });
  });

  await runTest('AUTHZ-002: policy denials emit policy_deny audit events', async () => {
    const audit = new AuditLogger({ persistToFile: false });
    const decision = enforceAuthorization({
      action: 'tool_call',
      authorization: { type: 'oauth', subject: 'user-2', scopes: ['gateway:call'] },
      toolName: 'restricted_tool',
      sessionId: 'session-1',
      source: 'mcp',
    }, audit);

    assert.equal(decision.allowed, false);
    const events = audit.getRecentEvents(10, 'policy_deny');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'user-2');
    assert.equal(events[0].target, 'restricted_tool');
    assert.deepEqual(events[0].details?.requiredScopes, ['tool:restricted_tool', 'tool:call']);
  });

  await runTest('AUTHZ-003: code execution is denied before sandbox execution without code scope', async () => {
    const audit = new AuditLogger({ persistToFile: false });
    const executor = new CodeExecutor(new BackendManager());
    const result = await executor.execute('console.log("should-not-run")', {
      authorization: { type: 'oauth', subject: 'user-3', scopes: ['gateway:call'] },
      auditLogger: audit,
      source: 'code-api',
    });

    assert.equal(result.success, false);
    assert.equal(result.errorKind, 'security');
    assert.equal(result.output.length, 0);
    assert.ok(result.hints?.includes('Required scope: code:execute'));
    assert.equal(audit.getRecentEvents(10, 'policy_deny').length, 1);
  });

  await runTest('AUTHZ-003: REST skill execution forwards request authorization', async () => {
    const audit = new AuditLogger({ persistToFile: false });
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        type: 'oauth',
        subject: 'skill-user',
        scopes: ['gateway:call'],
      };
      next();
    });
    app.use('/api/code', createCodeExecutionRoutes(new BackendManager(), audit));

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}/api/code`;
      const createResponse = await fetch(`${baseUrl}/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'rest_authz_skill',
          description: 'Route authorization regression skill',
          code: 'console.log("should-not-run");',
          tags: [],
          inputs: [],
        }),
      });
      assert.equal(createResponse.status, 201);

      const executeResponse = await fetch(`${baseUrl}/skills/rest_authz_skill/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: {} }),
      });
      const body = await executeResponse.json() as {
        success?: boolean;
        errorKind?: string;
        output?: unknown[];
        hints?: string[];
      };

      assert.equal(executeResponse.status, 200);
      assert.equal(body.success, false);
      assert.equal(body.errorKind, 'security');
      assert.deepEqual(body.output, []);
      assert.ok(body.hints?.includes('Required scope: code:execute'));
      assert.equal(audit.getRecentEvents(10, 'policy_deny').length, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });

  console.log(`\nAuthorization policy tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
