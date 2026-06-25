import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import { BackendManager } from '../backend/index.js';
import { Backend, BackendStatus } from '../backend/base.js';
import { MCPRequest, MCPResponse, MCPServerCapabilities } from '../types.js';
import { MCPProtocolHandler } from '../protocol/index.js';

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

class FakeCompletionBackend extends EventEmitter implements Backend {
  readonly id = 'fake-completion';
  readonly config = {
    id: 'fake-completion',
    name: 'Fake Completion',
    enabled: true,
    transport: { type: 'stdio' as const, command: 'fake' },
    timeout: 30000,
    retries: 0,
  };
  readonly status: BackendStatus = 'connected';
  readonly capabilities: MCPServerCapabilities = { prompts: { listChanged: true }, completions: {} };
  readonly tools = [];
  readonly resources = [{ uri: 'file:///known.txt', name: 'known.txt' }];
  readonly prompts = [{ name: 'code_review', description: 'Review code' }];
  readonly error = undefined;
  requests: MCPRequest[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  unprefixToolName(name: string): string {
    return name;
  }
  async sendRequest(request: MCPRequest): Promise<MCPResponse> {
    this.requests.push(request);
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        completion: {
          values: ['python', 'pytorch'],
          total: 2,
          hasMore: false,
        },
      },
    };
  }
}

class FakeResourceBackend extends EventEmitter implements Backend {
  readonly id = 'fake-resource';
  readonly config = {
    id: 'fake-resource',
    name: 'Fake Resource',
    enabled: true,
    transport: { type: 'stdio' as const, command: 'fake' },
    timeout: 30000,
    retries: 0,
  };
  readonly status: BackendStatus = 'connected';
  readonly capabilities: MCPServerCapabilities = { resources: { subscribe: false, listChanged: true } };
  readonly tools = [];
  readonly resources = [{ uri: 'file:///resource-only.txt', name: 'resource-only.txt' }];
  readonly prompts = [];
  readonly error = undefined;
  requests: MCPRequest[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  unprefixToolName(name: string): string {
    return name;
  }
  async sendRequest(request: MCPRequest): Promise<MCPResponse> {
    this.requests.push(request);
    return { jsonrpc: '2.0', id: request.id, result: {} };
  }
}

function createManagerWithBackend(backend: Backend, ...otherBackends: Backend[]): BackendManager {
  const manager = new BackendManager();
  for (const candidate of [backend, ...otherBackends]) {
    manager.getBackends().set(candidate.id, candidate);
  }
  (manager as unknown as { updateMappings(): void }).updateMappings();
  return manager;
}

async function main(): Promise<void> {
  console.log('Running protocol completion tests...\n');

  await runTest('COMPLETE-001: initialize advertises backend completion capability', async () => {
    const backend = new FakeCompletionBackend();
    const handler = new MCPProtocolHandler(createManagerWithBackend(backend));
    const session = await handler.getOrCreateSession('session-complete-1');

    const response = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }, session);

    assert.deepEqual((response?.result as { capabilities: MCPServerCapabilities }).capabilities.completions, {});
  });

  await runTest('COMPLETE-002: completion/complete routes prompt refs to owning backend', async () => {
    const backend = new FakeCompletionBackend();
    const handler = new MCPProtocolHandler(createManagerWithBackend(backend));
    const session = await handler.getOrCreateSession('session-complete-2');
    session.initialized = true;

    const response = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 'complete-1',
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/prompt', name: 'code_review' },
        argument: { name: 'language', value: 'py' },
      },
    }, session);

    assert.equal(response?.id, 'complete-1');
    assert.deepEqual(response?.result, {
      completion: {
        values: ['python', 'pytorch'],
        total: 2,
        hasMore: false,
      },
    });
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0].method, 'completion/complete');
    assert.deepEqual(backend.requests[0].params, {
      ref: { type: 'ref/prompt', name: 'code_review' },
      argument: { name: 'language', value: 'py' },
    });
  });

  await runTest('COMPLETE-003: invalid completion refs fail with InvalidParams', async () => {
    const backend = new FakeCompletionBackend();
    const handler = new MCPProtocolHandler(createManagerWithBackend(backend));
    const session = await handler.getOrCreateSession('session-complete-3');
    session.initialized = true;

    const response = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/prompt', name: 'code_review' },
        argument: { name: 'language' },
      },
    }, session);

    assert.equal(response?.error?.code, -32602);
    assert.equal(backend.requests.length, 0);
  });

  await runTest('COMPLETE-004: resource completions do not fall back to unrelated backends', async () => {
    const resourceBackend = new FakeResourceBackend();
    const completionBackend = new FakeCompletionBackend();
    const handler = new MCPProtocolHandler(createManagerWithBackend(resourceBackend, completionBackend));
    const session = await handler.getOrCreateSession('session-complete-4');
    session.initialized = true;

    const response = await handler.handleMessage({
      jsonrpc: '2.0',
      id: 'complete-resource',
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/resource', uri: 'file:///resource-only.txt' },
        argument: { name: 'path', value: 'kn' },
      },
    }, session);

    assert.equal(response?.error?.code, -32602);
    assert.equal(resourceBackend.requests.length, 0);
    assert.equal(completionBackend.requests.length, 0);
  });

  console.log(`\nProtocol completion tests completed${failures ? ` with ${failures} failure(s)` : ''}.`);
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
