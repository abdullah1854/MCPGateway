/**
 * STDIO Backend - Connects to MCP servers via standard input/output
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import { BaseBackend } from './base.js';
import { ServerConfig, MCPRequest, MCPResponse, StdioTransport } from '../types.js';
import { logger } from '../logger.js';

export class StdioBackend extends BaseBackend {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private pendingRequests = new Map<string | number, {
    resolve: (response: MCPResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(config: ServerConfig) {
    super(config);
    if (config.transport.type !== 'stdio') {
      throw new Error('StdioBackend requires stdio transport configuration');
    }
  }

  private get transport(): StdioTransport {
    return this.config.transport as StdioTransport;
  }

  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');
    logger.info(`Connecting to backend ${this.id} via stdio`, {
      command: this.transport.command,
      args: this.transport.args,
    });

    try {
      // Spawn the process
      this.process = spawn(this.transport.command, this.transport.args ?? [], {
        cwd: this.transport.cwd,
        env: { ...process.env, ...this.transport.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (!this.process.stdout || !this.process.stdin) {
        throw new Error('Failed to create process pipes');
      }

      // Set up readline for stdout
      this.readline = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      // Handle incoming messages
      this.readline.on('line', (line) => {
        this.handleMessage(line);
      });

      // Handle stderr
      this.process.stderr?.on('data', (data) => {
        logger.warn(`Backend ${this.id} stderr: ${data.toString().trim()}`);
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        logger.info(`Backend ${this.id} process exited`, { code, signal });
        this.cleanup();
        this.setStatus('disconnected');
      });

      // Handle process errors
      this.process.on('error', (error) => {
        logger.error(`Backend ${this.id} process error`, { error: error.message });
        this.setError(error);
        this.cleanup();
      });

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
    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Backend disconnected'));
    }
    this.pendingRequests.clear();

    // Close readline
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    // Kill process
    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._capabilities = undefined;
  }

  async sendRequest(request: MCPRequest): Promise<MCPResponse> {
    if (!this.process?.stdin) {
      throw new Error('Backend not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Request timeout for ${request.method}`));
      }, this.config.timeout);

      this.pendingRequests.set(request.id, { resolve, reject, timeout });

      const message = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(message, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pendingRequests.delete(request.id);
          reject(error);
        }
      });
    });
  }

  protected async sendNotification(method: string, params: unknown): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error('Backend not connected');
    }

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const message = JSON.stringify(notification) + '\n';
    this.process.stdin.write(message);
  }

  private handleMessage(line: string): void {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);
      
      // Check if it's a response (has id)
      if ('id' in message && message.id !== null) {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);
          pending.resolve(message as MCPResponse);
        } else {
          logger.warn(`Received response for unknown request`, { id: message.id });
        }
      } else if ('method' in message) {
        // It's a notification from the server
        this.handleNotification(message.method, message.params);
      }
    } catch (error) {
      logger.error(`Failed to parse message from backend ${this.id}`, {
        line,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    logger.debug(`Notification from ${this.id}: ${method}`, { params });
    
    switch (method) {
      case 'notifications/tools/list_changed':
        this.loadTools().catch(err => {
          logger.error(`Failed to reload tools for ${this.id}`, { error: err });
        });
        break;
      case 'notifications/resources/list_changed':
        this.loadResources().catch(err => {
          logger.error(`Failed to reload resources for ${this.id}`, { error: err });
        });
        break;
      case 'notifications/prompts/list_changed':
        this.loadPrompts().catch(err => {
          logger.error(`Failed to reload prompts for ${this.id}`, { error: err });
        });
        break;
      default:
        logger.debug(`Unhandled notification: ${method}`);
    }
  }
}

