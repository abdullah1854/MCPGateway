import { GatewayConfig, GatewaySession, StoreBackend } from '../types.js';
import { logger } from '../logger.js';
import { stableCanonicalJson } from '../utils/canonical-json.js';

export { stableCanonicalJson };

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitEntry>;
  cleanupExpired?(): Promise<number>;
  close?(): Promise<void>;
}

export interface SessionStore {
  get(id: string): Promise<GatewaySession | undefined>;
  set(session: GatewaySession, ttlMs: number): Promise<void>;
  delete(id: string): Promise<void>;
  cleanupExpired?(maxAgeMs: number): Promise<string[]>;
  close?(): Promise<void>;
}

export interface GatewayStores {
  backend: StoreBackend;
  rateLimit: RateLimitStore;
  sessions: SessionStore;
  close(): Promise<void>;
}

export interface RedisKeyValueClient {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface RedisGatewayStoreOptions {
  namespace?: string;
  redisUrl?: string;
  clientFactory?: (redisUrl?: string) => Promise<RedisKeyValueClient> | RedisKeyValueClient;
}

const DEFAULT_NAMESPACE = 'mcp-gateway';
const DEFAULT_MAX_RATE_LIMIT_ENTRIES = 10_000;

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export class StoreKeyBuilder {
  constructor(private readonly namespace = DEFAULT_NAMESPACE) {}

  rateLimit(clientId: string): string {
    return `${this.namespace}:rate:${encodeKeyPart(clientId)}`;
  }

  session(sessionId: string): string {
    return `${this.namespace}:session:${encodeKeyPart(sessionId)}`;
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_RATE_LIMIT_ENTRIES,
    private readonly now = Date.now,
  ) {}

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const now = this.now();
    const existing = this.entries.get(key);

    if (!existing || now >= existing.resetAt) {
      const entry = { count: 1, resetAt: now + windowMs };
      this.set(key, entry);
      return entry;
    }

    const entry = { ...existing, count: existing.count + 1 };
    this.set(key, entry);
    return entry;
  }

  async cleanupExpired(): Promise<number> {
    const now = this.now();
    let cleaned = 0;

    for (const [key, entry] of this.entries.entries()) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  async close(): Promise<void> {}

  private set(key: string, entry: RateLimitEntry): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, entry);
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, GatewaySession>();

  constructor(private readonly now = Date.now) {}

  async get(id: string): Promise<GatewaySession | undefined> {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : undefined;
  }

  async set(session: GatewaySession, _ttlMs: number): Promise<void> {
    this.sessions.set(session.id, cloneSession(session));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async cleanupExpired(maxAgeMs: number): Promise<string[]> {
    const now = this.now();
    const cleaned: string[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() > maxAgeMs) {
        this.sessions.delete(id);
        cleaned.push(id);
      }
    }

    return cleaned;
  }

  async close(): Promise<void> {}
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly client: RedisKeyValueClient,
    private readonly keys: StoreKeyBuilder,
    private readonly now = Date.now,
  ) {}

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const redisKey = this.keys.rateLimit(key);
    const now = this.now();
    const raw = await this.client.get(redisKey);
    const existing = raw ? parseRateLimitEntry(raw) : undefined;

    const entry =
      !existing || now >= existing.resetAt
        ? { count: 1, resetAt: now + windowMs }
        : { count: existing.count + 1, resetAt: existing.resetAt };

    const ttlMs = Math.max(1, entry.resetAt - now);
    await this.client.set(redisKey, stableCanonicalJson(entry), { PX: ttlMs });
    return entry;
  }
}

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly client: RedisKeyValueClient,
    private readonly keys: StoreKeyBuilder,
  ) {}

  async get(id: string): Promise<GatewaySession | undefined> {
    const raw = await this.client.get(this.keys.session(id));
    if (!raw) {
      return undefined;
    }

    return parseSession(raw);
  }

  async set(session: GatewaySession, ttlMs: number): Promise<void> {
    await this.client.set(this.keys.session(session.id), stableCanonicalJson(serializeSession(session)), {
      PX: Math.max(1, ttlMs),
    });
  }

  async delete(id: string): Promise<void> {
    await this.client.del(this.keys.session(id));
  }

  async cleanupExpired(_maxAgeMs: number): Promise<string[]> {
    return [];
  }
}

function parseRateLimitEntry(raw: string): RateLimitEntry | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<RateLimitEntry>;
    if (typeof parsed.count === 'number' && typeof parsed.resetAt === 'number') {
      return { count: parsed.count, resetAt: parsed.resetAt };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function serializeSession(session: GatewaySession): Record<string, unknown> {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    initialized: session.initialized,
    clientInfo: session.clientInfo,
  };
}

function parseSession(raw: string): GatewaySession | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<{
      id: unknown;
      createdAt: unknown;
      lastActivityAt: unknown;
      initialized: unknown;
      clientInfo: GatewaySession['clientInfo'];
    }>;

    if (
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.lastActivityAt === 'string' &&
      typeof parsed.initialized === 'boolean'
    ) {
      return {
        id: parsed.id,
        createdAt: new Date(parsed.createdAt),
        lastActivityAt: new Date(parsed.lastActivityAt),
        initialized: parsed.initialized,
        clientInfo: parsed.clientInfo,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function cloneSession(session: GatewaySession): GatewaySession {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    lastActivityAt: new Date(session.lastActivityAt),
    clientInfo: session.clientInfo ? { ...session.clientInfo } : undefined,
  };
}

export function createInMemoryGatewayStores(namespace = DEFAULT_NAMESPACE): GatewayStores {
  void namespace;
  const rateLimit = new InMemoryRateLimitStore();
  const sessions = new InMemorySessionStore();

  return {
    backend: 'memory',
    rateLimit,
    sessions,
    async close() {
      await rateLimit.close?.();
      await sessions.close?.();
    },
  };
}

async function createRedisClient(redisUrl?: string): Promise<RedisKeyValueClient> {
  const { createClient } = await import('@redis/client');
  return createClient(redisUrl ? { url: redisUrl } : {}) as unknown as RedisKeyValueClient;
}

export async function createRedisGatewayStores(options: RedisGatewayStoreOptions = {}): Promise<GatewayStores> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const clientFactory = options.clientFactory ?? createRedisClient;
  const client = await clientFactory(options.redisUrl);

  client.on?.('error', (error: Error) => {
    logger.error('Redis store error', { error: error.message });
  });

  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    await closeRedisClient(client);
    throw new Error(`Redis store unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const keys = new StoreKeyBuilder(namespace);

  return {
    backend: 'redis',
    rateLimit: new RedisRateLimitStore(client, keys),
    sessions: new RedisSessionStore(client, keys),
    async close() {
      await closeRedisClient(client);
    },
  };
}

async function closeRedisClient(client: RedisKeyValueClient): Promise<void> {
  if (client.quit) {
    await client.quit();
    return;
  }
  await client.disconnect?.();
}

export async function createGatewayStores(config: GatewayConfig): Promise<GatewayStores> {
  const namespace = config.store.namespace;

  if (config.store.backend === 'memory') {
    return createInMemoryGatewayStores(namespace);
  }

  return createRedisGatewayStores({
    namespace,
    redisUrl: config.store.redisUrl,
  });
}
