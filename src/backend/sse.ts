/**
 * SSE Backend - Connects to MCP servers using SSE transport
 *
 * Implements the MCP SSE client protocol:
 * 1. GET /sse (or /mcp/sse) to establish SSE connection
 * 2. Receive 'endpoint' event with POST URL containing sessionId
 * 3. POST messages to that endpoint
 */

import { BaseBackend } from './base.js';
import { ServerConfig, MCPRequest, MCPResponse, SseTransport } from '../types.js';
import { logger } from '../logger.js';

export class SSEBackend extends BaseBackend {
  private postUrl: string | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private eventSource: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private activeRequests = 0;
  private maxConcurrentRequests = 10;
  private requestQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(config: ServerConfig) {
    super(config);
    if (config.transport.type !== 'sse') {
      throw new Error('SSEBackend requires sse transport configuration');
    }
  }

  private get transport(): SseTransport {
    return this.config.transport as SseTransport;
  }

  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');
    logger.info(`Connecting to backend ${this.id} via SSE`, {
      url: this.transport.url,
    });

    try {
      this.abortController = new AbortController();

      // Step 1: Establish SSE connection to get the POST endpoint
      await this.establishSSEConnection();

      // Step 2: Initialize the MCP connection
      await this.initialize();

      // Step 3: Load capabilities
      await Promise.all([
        this.loadTools(),
        this.loadResources(),
        this.loadPrompts(),
      ]);

      this.setStatus('connected');
      logger.info(`Backend ${this.id} connected successfully via SSE`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setError(err);
      this.cleanup();
      throw err;
    }
  }

  private async establishSSEConnection(): Promise<void> {
    const sseUrl = this.transport.url;

    logger.debug(`Establishing SSE connection to ${sseUrl}`);

    const response = await fetch(sseUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...this.transport.headers,
      },
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body for SSE connection');
    }

    this.eventSource = reader;
    const decoder = new TextDecoder();
    let buffer = '';
    let foundEndpoint = false;

    // Read SSE events until we get the endpoint
    const timeout = setTimeout(() => {
      if (!foundEndpoint) {
        reader.cancel();
      }
    }, 10000); // 10 second timeout for handshake

    try {
      while (!foundEndpoint) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (eventType === 'endpoint') {
              // Parse the endpoint URL
              // Format: /mcp?sessionId=xxx
              this.postUrl = this.resolvePostUrl(data);
              const sessionMatch = data.match(/sessionId=([^&]+)/);
              if (sessionMatch) {
                this.sessionId = sessionMatch[1];
              }
              foundEndpoint = true;
              logger.info(`SSE endpoint received`, {
                postUrl: this.postUrl,
                sessionId: this.sessionId
              });
              break;
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!this.postUrl) {
      throw new Error('No endpoint received from SSE connection');
    }

    // Keep the SSE connection alive for notifications (in background)
    this.startSSEListener(reader);
  }

  private resolvePostUrl(path: string): string {
    const baseUrl = new URL(this.transport.url);
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    return `${baseUrl.protocol}//${baseUrl.host}${path}`;
  }

  private startSSEListener(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    // Listen for server notifications in background
    const decoder = new TextDecoder();
    let buffer = '';

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (eventType === 'message' && data) {
                try {
                  const message = JSON.parse(data);
                  // Handle server notifications
                  if (!('id' in message)) {
                    this.handleNotification(message);
                  }
                } catch {
                  // Skip invalid JSON
                }
              }
            }
          }
        }
      } catch (error) {
        if (this._status === 'connected') {
          logger.warn(`SSE connection closed for ${this.id}`, {
            error: error instanceof Error ? error.message : String(error)
          });
          this.setStatus('disconnected');
        }
      }
    };

    readLoop();
  }

  private handleNotification(message: unknown): void {
    // Handle server notifications (tools/list_changed, etc.)
    const msg = message as { method?: string };
    if (msg.method === 'notifications/tools/list_changed') {
      this.loadTools().catch(err =>
        logger.warn(`Failed to reload tools: ${err}`)
      );
    } else if (msg.method === 'notifications/resources/list_changed') {
      this.loadResources().catch(err =>
        logger.warn(`Failed to reload resources: ${err}`)
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this._status === 'disconnected') {
      return;
    }

    logger.info(`Disconnecting SSE backend ${this.id}`);
    this.cleanup();
    this.setStatus('disconnected');
  }

  private cleanup(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.eventSource) {
      this.eventSource.cancel().catch(() => {});
      this.eventSource = null;
    }
    this.postUrl = null;
    this.sessionId = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._capabilities = undefined;

    const queuedRequests = this.requestQueue.splice(0);
    for (const req of queuedRequests) {
      req.reject(new Error('Backend disconnected'));
    }
    this.activeRequests = 0;
  }

  async sendRequest(request: MCPRequest, timeout?: number): Promise<MCPResponse> {
    if (!this.postUrl) {
      throw new Error('SSE connection not established');
    }

    await this.acquireSlot();

    try {
      return await this.executeRequest(request, timeout);
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrentRequests) {
      this.activeRequests++;
      return;
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject });
    });
  }

  private releaseSlot(): void {
    const next = this.requestQueue.shift();
    if (next) {
      next.resolve();
    } else {
      this.activeRequests--;
    }
  }

  private async executeRequest(request: MCPRequest, timeoutOverride?: number): Promise<MCPResponse> {
    const timeoutMs = timeoutOverride ?? this.config.timeout;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...this.transport.headers,
    };

    let lastError: Error | null = null;
    const maxRetries = this.config.retries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.postUrl!, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const json = await response.json();
        clearTimeout(timeout);
        return json as MCPResponse;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn(`SSE request to ${this.id} failed, retrying in ${delay}ms`, {
            attempt: attempt + 1,
            maxRetries,
            error: lastError.message,
          });
          await this.sleep(delay);
        }
      }
    }

    clearTimeout(timeout);
    throw lastError ?? new Error('Request failed');
  }

  protected async sendNotification(method: string, params: unknown): Promise<void> {
    if (!this.postUrl) {
      logger.warn(`Cannot send notification - SSE not connected`);
      return;
    }

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.transport.headers,
    };

    try {
      await fetch(this.postUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(notification),
        signal: this.abortController?.signal,
      });
    } catch (error) {
      logger.warn(`Failed to send notification to ${this.id}`, {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
