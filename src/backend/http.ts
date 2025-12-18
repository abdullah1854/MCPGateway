/**
 * HTTP Backend - Connects to remote MCP servers via Streamable HTTP or SSE
 *
 * Features:
 * - Connection pooling via keep-alive
 * - Automatic retry with exponential backoff
 * - Session management
 * - Streaming response support (SSE)
 */

import { BaseBackend } from './base.js';
import { ServerConfig, MCPRequest, MCPResponse, HttpTransport } from '../types.js';
import { logger } from '../logger.js';

export class HttpBackend extends BaseBackend {
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private activeRequests = 0;
  private maxConcurrentRequests = 10;
  private requestQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(config: ServerConfig) {
    super(config);
    // Accept both 'http' and 'sse' transport types - both use HTTP with SSE streaming
    if (config.transport.type !== 'http' && config.transport.type !== 'sse') {
      throw new Error('HttpBackend requires http or sse transport configuration');
    }
  }

  private get transport(): HttpTransport {
    return this.config.transport as HttpTransport;
  }

  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');
    logger.info(`Connecting to backend ${this.id} via HTTP`, {
      url: this.transport.url,
    });

    try {
      this.abortController = new AbortController();

      // Initialize the connection
      await this.initialize();

      // Load capabilities
      await Promise.all([
        this.loadTools(),
        this.loadResources(),
        this.loadPrompts(),
      ]);

      this.setStatus('connected');
      logger.info(`Backend ${this.id} connected successfully`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setError(err);
      this.cleanup();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._status === 'disconnected') {
      return;
    }

    logger.info(`Disconnecting backend ${this.id}`);
    this.cleanup();
    this.setStatus('disconnected');
  }

  private cleanup(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.sessionId = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._capabilities = undefined;

    // Reject all queued requests
    const queuedRequests = this.requestQueue.splice(0);
    for (const req of queuedRequests) {
      req.reject(new Error('Backend disconnected'));
    }
    this.activeRequests = 0;
  }

  async sendRequest(request: MCPRequest, timeout?: number): Promise<MCPResponse> {
    // Wait for a slot using promise-based queue (no busy-wait)
    await this.acquireSlot();

    try {
      return await this.executeRequest(request, timeout);
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Acquire a slot for making a request (promise-based, no busy-wait)
   */
  private async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrentRequests) {
      this.activeRequests++;
      return;
    }

    // Wait in queue for a slot to become available
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject });
    });
  }

  /**
   * Release a slot and wake up next waiting request if any
   */
  private releaseSlot(): void {
    const next = this.requestQueue.shift();
    if (next) {
      // Don't decrement - the slot is being transferred to the next request
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
      'Accept': 'application/json, text/event-stream',
      'Connection': 'keep-alive', // Enable connection reuse
      ...this.transport.headers,
    };

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    let lastError: Error | null = null;
    const maxRetries = this.config.retries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.transport.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
          keepalive: true,
        });

        // Store session ID if provided
        const newSessionId = response.headers.get('Mcp-Session-Id');
        if (newSessionId) {
          this.sessionId = newSessionId;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('Content-Type') ?? '';

        // Handle SSE response (streaming)
        if (contentType.includes('text/event-stream')) {
          return await this.handleStreamingResponse(response, request.id);
        }

        // Handle JSON response
        const json = await response.json();
        return json as MCPResponse;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          logger.warn(`Request to ${this.id} failed, retrying in ${delay}ms`, {
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

  /**
   * Get current active request count (for monitoring)
   */
  getActiveRequestCount(): number {
    return this.activeRequests;
  }

  private async handleStreamingResponse(
    response: Response,
    requestId: string | number
  ): Promise<MCPResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              continue;
            }

            try {
              const message = JSON.parse(data);
              if (message.id === requestId) {
                return message as MCPResponse;
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    throw new Error('No response received from stream');
  }

  protected async sendNotification(method: string, params: unknown): Promise<void> {
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.transport.headers,
    };

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    try {
      await fetch(this.transport.url, {
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

