import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { BackendManager } from '../backend/index.js';
import { createDashboardRoutes } from '../dashboard/index.js';
import { ServerConfigSchema } from '../types.js';

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

const validServerConfig = {
  id: 'valid-server-1',
  name: 'Valid Server',
  enabled: true,
  transport: {
    type: 'stdio',
    command: 'node',
  },
  toolPrefix: 'valid_server',
  timeout: 30000,
  retries: 3,
} as const;

const FRIENDLY_SERVER_ID_MESSAGE =
  'server id must contain only lowercase letters, numbers, and hyphens';

interface ValidationResponseBody {
  message?: string;
  fieldErrors?: Record<string, string[]>;
  details?: Array<{ field?: string; message?: string; code?: string }>;
}

function serverIdMessagesFor(id: string): string[] {
  const result = ServerConfigSchema.safeParse({
    ...validServerConfig,
    id,
  });

  assert.equal(result.success, false, `${id} should fail validation`);

  return result.error.errors
    .filter(error => error.path.join('.') === 'id')
    .map(error => error.message);
}

async function withDashboardServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/dashboard', createDashboardRoutes(new BackendManager()));

  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}/dashboard`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

async function postInvalidServerConfig(path: string): Promise<{
  status: number;
  body: ValidationResponseBody;
}> {
  return withDashboardServer(async baseUrl => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validServerConfig,
        id: 'Invalid Server',
      }),
    });

    return {
      status: response.status,
      body: await response.json() as ValidationResponseBody,
    };
  });
}

function assertServerIdValidationResponse(result: Awaited<ReturnType<typeof postInvalidServerConfig>>): void {
  assert.equal(result.status, 400);
  assert.equal(
    result.body.message,
    `Please fix id: ${FRIENDLY_SERVER_ID_MESSAGE}.`
  );
  assert.deepEqual(result.body.fieldErrors?.id, [FRIENDLY_SERVER_ID_MESSAGE]);
  assert.deepEqual(result.body.details, [
    {
      field: 'id',
      message: FRIENDLY_SERVER_ID_MESSAGE,
      code: 'invalid_string',
    },
  ]);
}

async function main(): Promise<void> {
  console.log('Running server ID validation tests...\n');

  await runTest('accepts lowercase letters, numbers, and hyphens', () => {
    const result = ServerConfigSchema.safeParse(validServerConfig);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.id, 'valid-server-1');
    }
  });

  const invalidCases = [
    ['uppercase letters', 'Invalid-Server'],
    ['spaces', 'invalid server'],
    ['underscores', 'invalid_server'],
    ['punctuation', 'invalid.server!'],
  ] as const;

  for (const [label, id] of invalidCases) {
    await runTest(`rejects server IDs with ${label} using a friendly message`, () => {
      assert.deepEqual(serverIdMessagesFor(id), [FRIENDLY_SERVER_ID_MESSAGE]);
    });
  }

  await runTest('POST /api/servers returns route-level server ID validation details', async () => {
    assertServerIdValidationResponse(await postInvalidServerConfig('/api/servers'));
  });

  await runTest('POST /api/servers/test returns route-level server ID validation details', async () => {
    assertServerIdValidationResponse(await postInvalidServerConfig('/api/servers/test'));
  });

  console.log(`\nServer ID validation tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
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
