import assert from 'node:assert/strict';
import {
  createRedisGatewayStores,
  InMemoryRateLimitStore,
  InMemorySessionStore,
  RedisKeyValueClient,
  RedisSessionStore,
  stableCanonicalJson,
  StoreKeyBuilder,
} from '../middleware/stores.js';
import { GatewaySession } from '../types.js';

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

class FakeRedisClient implements RedisKeyValueClient {
  readonly values = new Map<string, string>();
  readonly ttlMs = new Map<string, number>();
  connectCalls = 0;
  evalCalls = 0;
  getCalls = 0;
  pingCalls = 0;
  quitCalls = 0;
  private readonly failConnect: boolean;

  constructor(options: { failConnect?: boolean } = {}) {
    this.failConnect = options.failConnect ?? false;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.failConnect) {
      throw new Error('connection refused');
    }
  }

  async ping(): Promise<string> {
    this.pingCalls++;
    return 'PONG';
  }

  async get(key: string): Promise<string | null> {
    this.getCalls++;
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { PX?: number }): Promise<string> {
    this.values.set(key, value);
    if (options?.PX !== undefined) {
      this.ttlMs.set(key, options.PX);
    }
    return 'OK';
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<string> {
    this.evalCalls++;
    const [key] = options.keys;
    const [nowRaw, windowMsRaw] = options.arguments;
    const now = Number(nowRaw);
    const windowMs = Number(windowMsRaw);
    const raw = key ? this.values.get(key) : undefined;
    const existing = raw ? JSON.parse(raw) as { count?: unknown; resetAt?: unknown } : undefined;
    const active = Boolean(
      existing &&
      typeof existing.count === 'number' &&
      typeof existing.resetAt === 'number' &&
      now < existing.resetAt,
    );
    const entry = { count: 1, resetAt: now + windowMs };
    if (active && typeof existing?.count === 'number' && typeof existing.resetAt === 'number') {
      entry.count = existing.count + 1;
      entry.resetAt = existing.resetAt;
    }
    const ttlMs = Math.max(1, entry.resetAt - now);
    const serialized = stableCanonicalJson(entry);
    if (key) {
      this.values.set(key, serialized);
      this.ttlMs.set(key, ttlMs);
    }
    return serialized;
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async quit(): Promise<void> {
    this.quitCalls++;
  }
}

function session(id: string): GatewaySession {
  return {
    id,
    createdAt: new Date('2026-06-25T00:00:00.000Z'),
    lastActivityAt: new Date('2026-06-25T00:00:01.000Z'),
    initialized: true,
    clientInfo: { name: 'test-client', version: '1.0.0' },
  };
}

async function main(): Promise<void> {
  console.log('Running store adapter tests...\n');

  await runTest('STORE-001: stableCanonicalJson sorts nested object keys', () => {
    const left = stableCanonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }] });
    const right = stableCanonicalJson({ list: [{ c: 5, d: 4 }], a: { b: 3, y: 2 }, z: 1 });
    assert.equal(left, right);
  });

  await runTest('STORE-001: in-memory rate-limit store increments and expires by TTL', async () => {
    let now = 1_000;
    const store = new InMemoryRateLimitStore(10, () => now);

    assert.deepEqual(await store.increment('client-a', 100), { count: 1, resetAt: 1_100 });
    assert.deepEqual(await store.increment('client-a', 100), { count: 2, resetAt: 1_100 });

    now = 1_101;
    assert.equal(await store.cleanupExpired(), 1);
    assert.deepEqual(await store.increment('client-a', 100), { count: 1, resetAt: 1_201 });
  });

  await runTest('STORE-001: in-memory session store clones dates and cleans stale sessions', async () => {
    let now = 10_000;
    const store = new InMemorySessionStore(() => now);
    await store.set(session('s1'), 1_000);

    const loaded = await store.get('s1');
    assert.equal(loaded?.id, 's1');
    assert.ok(loaded?.createdAt instanceof Date);
    assert.ok(loaded?.lastActivityAt instanceof Date);

    now = Date.parse('2026-06-25T00:10:00.000Z');
    assert.deepEqual(await store.cleanupExpired(60_000), ['s1']);
    assert.equal(await store.get('s1'), undefined);
  });

  await runTest('STORE-001: Redis adapter writes namespaced TTL-backed rate-limit entries', async () => {
    const fake = new FakeRedisClient();
    const stores = await createRedisGatewayStores({
      namespace: 'test-suite',
      clientFactory: () => fake,
    });

    const entry = await stores.rateLimit.increment('10.0.0.1', 5_000);
    const key = new StoreKeyBuilder('test-suite').rateLimit('10.0.0.1');

    assert.equal(fake.connectCalls, 1);
    assert.equal(fake.pingCalls, 1);
    assert.equal(entry.count, 1);
    assert.equal(fake.ttlMs.get(key), 5_000);
    assert.match(fake.values.get(key) ?? '', /"count":1/);
    assert.equal(fake.evalCalls, 1);
    assert.equal(fake.getCalls, 0);

    await stores.close();
    assert.equal(fake.quitCalls, 1);
  });

  await runTest('STORE-001: Redis rate-limit increments are atomic eval operations', async () => {
    const fake = new FakeRedisClient();
    const stores = await createRedisGatewayStores({
      namespace: 'test-suite',
      clientFactory: () => fake,
    });

    const entries = await Promise.all([
      stores.rateLimit.increment('10.0.0.2', 5_000),
      stores.rateLimit.increment('10.0.0.2', 5_000),
      stores.rateLimit.increment('10.0.0.2', 5_000),
    ]);

    assert.deepEqual(entries.map(entry => entry.count), [1, 2, 3]);
    assert.equal(fake.evalCalls, 3);
    assert.equal(fake.getCalls, 0);
  });

  await runTest('STORE-001: Redis adapter round-trips session dates with TTL', async () => {
    const fake = new FakeRedisClient();
    const stores = await createRedisGatewayStores({
      namespace: 'test-suite',
      clientFactory: () => fake,
    });
    const key = new StoreKeyBuilder('test-suite').session('s2');

    await stores.sessions.set(session('s2'), 30_000);
    assert.equal(fake.ttlMs.get(key), 30_000);

    const loaded = await stores.sessions.get('s2');
    assert.equal(loaded?.id, 's2');
    assert.ok(loaded?.createdAt instanceof Date);
    assert.ok(loaded?.lastActivityAt instanceof Date);
    assert.equal(loaded?.clientInfo?.name, 'test-client');
  });

  await runTest('STORE-001: Redis session cleanup returns locally expired session ids', async () => {
    let now = 10_000;
    const fake = new FakeRedisClient();
    const store = new RedisSessionStore(fake, new StoreKeyBuilder('test-suite'), () => now);

    await store.set(session('s-expiring'), 50);
    assert.deepEqual(await store.cleanupExpired(60_000), []);

    now = 10_050;
    assert.deepEqual(await store.cleanupExpired(60_000), ['s-expiring']);
    assert.deepEqual(await store.cleanupExpired(60_000), []);
  });

  await runTest('STORE-001: Redis store factory fails closed when Redis is unreachable', async () => {
    await assert.rejects(
      () =>
        createRedisGatewayStores({
          clientFactory: () => new FakeRedisClient({ failConnect: true }),
        }),
      /Redis store unavailable: connection refused/,
    );
  });

  console.log(`\nStore adapter tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
