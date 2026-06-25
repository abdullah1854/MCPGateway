import { strict as assert } from 'assert';
import express, { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import { ResultCache } from '../code-execution/cache.js';
import { DeltaResponseManager } from '../code-execution/delta-response.js';
import { SchemaDeduplicator } from '../code-execution/schema-dedup.js';
import { SessionContext } from '../code-execution/session-context.js';
import { byteLengthOfCanonicalJson, estimateTokensFromBytes } from '../utils/canonical-json.js';
import { createCodeExecutionRoutes } from '../code-execution/routes.js';
import { BackendManager } from '../backend/index.js';
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

async function main(): Promise<void> {
  console.log('Running cache and canonicalization tests...\n');

  await runTest('CACHE-001: result cache keys use recursive canonical JSON', () => {
    const a = ResultCache.generateKey('tool', { b: 1, a: { y: 2, x: 1 } });
    const b = ResultCache.generateKey('tool', { a: { x: 1, y: 2 }, b: 1 });
    assert.equal(a, b);
  });

  await runTest('CACHE-001: delta and schema keys are stable for nested object order', () => {
    const argsA = { z: [{ b: 2, a: 1 }], a: 'x' };
    const argsB = { a: 'x', z: [{ a: 1, b: 2 }] };
    assert.equal(
      DeltaResponseManager.generateKey('delta_tool', argsA),
      DeltaResponseManager.generateKey('delta_tool', argsB),
    );

    const schemaA = { properties: { b: { type: 'string' }, a: { type: 'number' } } };
    const schemaB = { properties: { a: { type: 'number' }, b: { type: 'string' } } };
    assert.equal(SchemaDeduplicator.hashSchema(schemaA), SchemaDeduplicator.hashSchema(schemaB));
  });

  await runTest('CACHE-002: session context savings subtract replacement bytes', () => {
    const ctx = new SessionContext();
    const content = { rows: Array.from({ length: 10 }, (_, i) => ({ id: i, name: `row-${i}` })) };

    const first = ctx.getOptimizedContent('result', 'demo', content);
    const second = ctx.getOptimizedContent('result', 'demo', content);

    const reference = '[See result "demo" sent earlier in conversation]';
    const expectedBytesSaved = Math.max(
      0,
      byteLengthOfCanonicalJson(content) - Buffer.byteLength(reference, 'utf8'),
    );

    assert.equal(first.wasCached, false);
    assert.equal(second.wasCached, true);
    assert.equal(second.tokensSaved, estimateTokensFromBytes(expectedBytesSaved));
    assert.equal(ctx.getStats().bytesSaved, expectedBytesSaved);
  });

  await runTest('CACHE-003: REST tool call cache is explicit opt-in', async () => {
    let backendCalls = 0;
    const backendManager = {
      async callTool(_toolName: string, _args: unknown) {
        backendCalls++;
        return {
          jsonrpc: '2.0',
          id: backendCalls,
          result: { rows: [{ id: backendCalls }] },
        };
      },
    } as unknown as BackendManager;

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        type: 'oauth',
        subject: 'cache-user',
        scopes: ['tool:demo_tool'],
      };
      next();
    });
    app.use('/api/code', createCodeExecutionRoutes(backendManager));

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/api/code/tools/demo_tool/call`;
      const uncachedInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: { b: 1, a: { y: 2, x: 1 } }, smart: false }),
      };
      const cachedInit = {
        ...uncachedInit,
        body: JSON.stringify({ args: { b: 1, a: { y: 2, x: 1 } }, smart: false, cache: true }),
      };

      const first = await fetch(url, uncachedInit);
      const second = await fetch(url, uncachedInit);
      const third = await fetch(url, cachedInit);
      const fourth = await fetch(url, cachedInit);
      const firstBody = await first.json() as { cache?: { hit: boolean }; result?: unknown };
      const secondBody = await second.json() as { cache?: { hit: boolean }; result?: unknown };
      const thirdBody = await third.json() as { cache?: { enabled: boolean; hit: boolean }; result?: unknown };
      const fourthBody = await fourth.json() as { cache?: { enabled: boolean; hit: boolean }; result?: unknown };

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(third.status, 200);
      assert.equal(fourth.status, 200);
      assert.equal(firstBody.cache?.hit, false);
      assert.equal(secondBody.cache?.hit, false);
      assert.notDeepEqual(firstBody.result, secondBody.result);
      assert.equal(thirdBody.cache?.enabled, true);
      assert.equal(thirdBody.cache?.hit, false);
      assert.equal(fourthBody.cache?.enabled, true);
      assert.equal(fourthBody.cache?.hit, true);
      assert.deepEqual(thirdBody.result, fourthBody.result);
      assert.equal(backendCalls, 3);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });

  console.log(`\nCache tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
