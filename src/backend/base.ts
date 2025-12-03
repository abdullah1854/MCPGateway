/**
 * Base Backend Interface and Abstract Class
 */

import { EventEmitter } from 'events';
import {
  ServerConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPServerCapabilities,
  MCPRequest,
  MCPResponse,
} from '../types.js';
import { logger } from '../logger.js';

export type BackendStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BackendEvents {
  connected: [];
  disconnected: [];
  error: [error: Error];
  toolsChanged: [tools: MCPTool[]];
  resourcesChanged: [resources: MCPResource[]];
  promptsChanged: [prompts: MCPPrompt[]];
}

export interface Backend extends EventEmitter {
  readonly id: string;
  readonly config: ServerConfig;
  readonly status: BackendStatus;
  readonly capabilities: MCPServerCapabilities | undefined;
  readonly tools: MCPTool[];
  readonly resources: MCPResource[];
  readonly prompts: MCPPrompt[];
  readonly error: string | undefined;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendRequest(request: MCPRequest): Promise<MCPResponse>;

  /**
   * Remove tool prefix to get original name for backend call
   */
  unprefixToolName(name: string): string;
  
  on<K extends keyof BackendEvents>(
    event: K,
    listener: (...args: BackendEvents[K]) => void
  ): this;
  
  emit<K extends keyof BackendEvents>(
    event: K,
    ...args: BackendEvents[K]
  ): boolean;
}

export abstract class BaseBackend extends EventEmitter implements Backend {
  readonly id: string;
  readonly config: ServerConfig;
  
  protected _status: BackendStatus = 'disconnected';
  protected _capabilities: MCPServerCapabilities | undefined;
  protected _tools: MCPTool[] = [];
  protected _resources: MCPResource[] = [];
  protected _prompts: MCPPrompt[] = [];
  protected _error: string | undefined;
  protected _lastErrorAt: Date | undefined;
  protected _requestId = 0;

  constructor(config: ServerConfig) {
    super();
    this.id = config.id;
    this.config = config;
  }

  get status(): BackendStatus {
    return this._status;
  }

  get capabilities(): MCPServerCapabilities | undefined {
    return this._capabilities;
  }

  get tools(): MCPTool[] {
    return this._tools;
  }

  get resources(): MCPResource[] {
    return this._resources;
  }

  get prompts(): MCPPrompt[] {
    return this._prompts;
  }

  get error(): string | undefined {
    return this._error;
  }

  /**
   * Timestamp of the last backend error, if any.
   * Used for health reporting and reconnect strategies.
   */
  get lastErrorAt(): Date | undefined {
    return this._lastErrorAt;
  }

  protected setStatus(status: BackendStatus): void {
    const oldStatus = this._status;
    this._status = status;
    
    if (oldStatus !== status) {
      logger.debug(`Backend ${this.id} status changed: ${oldStatus} -> ${status}`);
      
      if (status === 'connected') {
        this.emit('connected');
      } else if (status === 'disconnected') {
        this.emit('disconnected');
      }
    }
  }

  protected setError(error: Error | string): void {
    this._error = typeof error === 'string' ? error : error.message;
    this._status = 'error';
    this._lastErrorAt = new Date();
    this.emit('error', typeof error === 'string' ? new Error(error) : error);
  }

  protected getNextRequestId(): number {
    return ++this._requestId;
  }

  /**
   * Add tool prefix if configured
   */
  protected prefixToolName(name: string): string {
    if (this.config.toolPrefix) {
      return `${this.config.toolPrefix}_${name}`;
    }
    return name;
  }

  /**
   * Remove tool prefix to get original name for backend call
   */
  unprefixToolName(name: string): string {
    if (this.config.toolPrefix && name.startsWith(`${this.config.toolPrefix}_`)) {
      return name.slice(this.config.toolPrefix.length + 1);
    }
    return name;
  }

  /**
   * Initialize the MCP connection
   */
  protected async initialize(): Promise<void> {
    logger.debug(`Initializing backend ${this.id}`);
    
    const initRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: {
          name: 'mcp-gateway',
          version: '1.0.0',
        },
      },
    };

    const response = await this.sendRequest(initRequest);
    
    if (response.error) {
      throw new Error(`Initialize failed: ${response.error.message}`);
    }

    const result = response.result as {
      protocolVersion: string;
      capabilities: MCPServerCapabilities;
      serverInfo: { name: string; version: string };
    };

    this._capabilities = result.capabilities;
    logger.info(`Backend ${this.id} initialized`, {
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
    });

    // Send initialized notification
    await this.sendNotification('notifications/initialized', {});
  }

  /**
   * Load tools from the backend
   */
  protected async loadTools(): Promise<void> {
    if (!this._capabilities?.tools) {
      logger.debug(`Backend ${this.id} does not support tools`);
      return;
    }

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/list',
      params: {},
    };

    const response = await this.sendRequest(request);

    if (response.error) {
      logger.error(`Failed to load tools from ${this.id}`, { error: response.error });
      return;
    }

    const result = response.result as { tools: MCPTool[] };
    this._tools = result.tools.map(tool => ({
      ...tool,
      name: this.prefixToolName(tool.name),
    }));

    logger.info(`Loaded ${this._tools.length} tools from ${this.id}`);
    this.emit('toolsChanged', this._tools);
  }

  /**
   * Load resources from the backend
   */
  protected async loadResources(): Promise<void> {
    if (!this._capabilities?.resources) {
      logger.debug(`Backend ${this.id} does not support resources`);
      return;
    }

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'resources/list',
      params: {},
    };

    const response = await this.sendRequest(request);

    if (response.error) {
      logger.error(`Failed to load resources from ${this.id}`, { error: response.error });
      return;
    }

    const result = response.result as { resources: MCPResource[] };
    this._resources = result.resources;

    logger.info(`Loaded ${this._resources.length} resources from ${this.id}`);
    this.emit('resourcesChanged', this._resources);
  }

  /**
   * Load prompts from the backend
   */
  protected async loadPrompts(): Promise<void> {
    if (!this._capabilities?.prompts) {
      logger.debug(`Backend ${this.id} does not support prompts`);
      return;
    }

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'prompts/list',
      params: {},
    };

    const response = await this.sendRequest(request);

    if (response.error) {
      logger.error(`Failed to load prompts from ${this.id}`, { error: response.error });
      return;
    }

    const result = response.result as { prompts: MCPPrompt[] };
    this._prompts = result.prompts;

    logger.info(`Loaded ${this._prompts.length} prompts from ${this.id}`);
    this.emit('promptsChanged', this._prompts);
  }

  /**
   * Send a notification (no response expected)
   */
  protected abstract sendNotification(method: string, params: unknown): Promise<void>;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract sendRequest(request: MCPRequest): Promise<MCPResponse>;
}

