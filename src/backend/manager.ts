/**
 * Backend Manager - Manages multiple MCP backend connections
 */

import { EventEmitter } from 'events';
import {
  ServerConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPRequest,
  MCPResponse,
  MCPErrorCodes,
} from '../types.js';
import { Backend } from './base.js';
import { StdioBackend } from './stdio.js';
import { HttpBackend } from './http.js';
import { logger } from '../logger.js';

// Event types for BackendManager (used via EventEmitter)
// backendConnected: [id: string]
// backendDisconnected: [id: string]
// backendError: [id: string, error: Error]
// toolsUpdated: []
// resourcesUpdated: []
// promptsUpdated: []

export class BackendManager extends EventEmitter {
  private backends = new Map<string, Backend>();
  private toolToBackend = new Map<string, string>();
  private resourceToBackend = new Map<string, string>();
  private promptToBackend = new Map<string, string>();
  private disabledTools = new Set<string>();
  private disabledBackends = new Set<string>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private reconnectAttempts = new Map<string, number>();

  constructor() {
    super();
  }

  /**
   * Create a backend based on transport type
   */
  private createBackend(config: ServerConfig): Backend {
    switch (config.transport.type) {
      case 'stdio':
        return new StdioBackend(config);
      case 'http':
        return new HttpBackend(config);
      case 'sse':
        // SSE uses HTTP backend with different handling
        return new HttpBackend(config);
      default:
        throw new Error(`Unsupported transport type: ${(config.transport as { type: string }).type}`);
    }
  }

  /**
   * Add and connect to a backend server
   */
  async addBackend(config: ServerConfig): Promise<void> {
    if (this.backends.has(config.id)) {
      logger.warn(`Backend ${config.id} already exists, skipping`);
      return;
    }

    const backend = this.createBackend(config);

    // Set up event handlers
    backend.on('connected', () => {
      this.updateMappings();
      this.emit('backendConnected', config.id);
      // Reset reconnect attempts on successful connection
      const timer = this.reconnectTimers.get(config.id);
      if (timer) {
        clearTimeout(timer);
        this.reconnectTimers.delete(config.id);
      }
      this.reconnectAttempts.delete(config.id);
    });

    backend.on('disconnected', () => {
      this.updateMappings();
      this.emit('backendDisconnected', config.id);
       // Schedule reconnect for enabled backends
      this.scheduleReconnect(config.id, config);
    });

    backend.on('error', (error) => {
      this.emit('backendError', config.id, error);
      this.scheduleReconnect(config.id, config);
    });

    backend.on('toolsChanged', () => {
      this.updateMappings();
      this.emit('toolsUpdated');
    });

    backend.on('resourcesChanged', () => {
      this.updateMappings();
      this.emit('resourcesUpdated');
    });

    backend.on('promptsChanged', () => {
      this.updateMappings();
      this.emit('promptsUpdated');
    });

    this.backends.set(config.id, backend);

    try {
      await backend.connect();
    } catch (error) {
      logger.error(`Failed to connect backend ${config.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't remove the backend, it might recover later
    }
  }

  /**
   * Schedule a reconnect with exponential backoff for a given backend.
   * Backoff is capped to 30 seconds to avoid excessively long delays.
   */
  private scheduleReconnect(id: string, config: ServerConfig): void {
    // Skip if backend is disabled or not enabled in config
    if (this.disabledBackends.has(id) || !config.enabled) {
      return;
    }

    const backend = this.backends.get(id);
    if (!backend || backend.status === 'connected' || backend.status === 'connecting') {
      return;
    }

    // Avoid multiple timers for the same backend
    if (this.reconnectTimers.has(id)) {
      return;
    }

    const attempt = (this.reconnectAttempts.get(id) ?? 0) + 1;
    this.reconnectAttempts.set(id, attempt);

    const baseDelayMs = 1000;
    const maxDelayMs = 30000;
    const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

    logger.warn(`Scheduling reconnect for backend ${id} in ${delay}ms (attempt ${attempt})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(id);

      const current = this.backends.get(id);
      if (!current || current.status === 'connected' || current.status === 'connecting') {
        return;
      }

      try {
        await current.connect();
        this.reconnectAttempts.delete(id);
      } catch (error) {
        logger.error(`Reconnect attempt for backend ${id} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
        // Schedule another reconnect attempt
        this.scheduleReconnect(id, config);
      }
    }, delay);

    this.reconnectTimers.set(id, timer);
  }

  /**
   * Remove a backend
   */
  async removeBackend(id: string): Promise<void> {
    const backend = this.backends.get(id);
    if (!backend) {
      return;
    }

    // Cancel any scheduled reconnects
    const timer = this.reconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(id);
    }
    this.reconnectAttempts.delete(id);

    await backend.disconnect();
    this.backends.delete(id);
    this.disabledBackends.delete(id);
    this.updateMappings();
  }

  /**
   * Update a backend with new configuration (disconnect old, connect with new config)
   */
  async updateBackend(oldId: string, config: ServerConfig): Promise<void> {
    // Remove the old backend first
    await this.removeBackend(oldId);

    // Only add the new backend if it's enabled
    if (config.enabled) {
      await this.addBackend(config);
    }
  }

  /**
   * Test connection to a backend without persisting it
   * Returns the backend instance if successful, throws error otherwise
   */
  async testBackendConnection(config: ServerConfig): Promise<{
    success: boolean;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    error?: string;
  }> {
    const backend = this.createBackend(config);

    try {
      await backend.connect();

      const result = {
        success: true,
        toolCount: backend.tools.length,
        resourceCount: backend.resources.length,
        promptCount: backend.prompts.length,
      };

      // Clean up test connection
      await backend.disconnect();

      return result;
    } catch (error) {
      // Make sure to clean up on error
      try {
        await backend.disconnect();
      } catch {
        // Ignore cleanup errors
      }

      return {
        success: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get all backends
   */
  getBackends(): Map<string, Backend> {
    return this.backends;
  }

  /**
   * Get a specific backend
   */
  getBackend(id: string): Backend | undefined {
    return this.backends.get(id);
  }

  /**
   * Update tool/resource/prompt mappings
   */
  private updateMappings(): void {
    this.toolToBackend.clear();
    this.resourceToBackend.clear();
    this.promptToBackend.clear();

    for (const [id, backend] of this.backends) {
      if (backend.status !== 'connected') continue;

      for (const tool of backend.tools) {
        this.toolToBackend.set(tool.name, id);
      }

      for (const resource of backend.resources) {
        this.resourceToBackend.set(resource.uri, id);
      }

      for (const prompt of backend.prompts) {
        this.promptToBackend.set(prompt.name, id);
      }
    }
  }

  /**
   * Get all aggregated tools from all connected backends (respects disabled backends for MCP)
   */
  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const [id, backend] of this.backends) {
      if (backend.status === 'connected' && !this.disabledBackends.has(id)) {
        tools.push(...backend.tools);
      }
    }
    return tools;
  }

  /**
   * Get ALL tools including from disabled backends (for dashboard display)
   */
  getAllToolsIncludingDisabled(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const backend of this.backends.values()) {
      if (backend.status === 'connected') {
        tools.push(...backend.tools);
      }
    }
    return tools;
  }

  /**
   * Get only enabled tools (filtered for MCP clients)
   */
  getEnabledTools(): MCPTool[] {
    return this.getAllTools().filter(tool => !this.disabledTools.has(tool.name));
  }

  /**
   * Get disabled tools set
   */
  getDisabledTools(): Set<string> {
    return this.disabledTools;
  }

  /**
   * Get disabled backends set
   */
  getDisabledBackends(): Set<string> {
    return this.disabledBackends;
  }

  /**
   * Disable a tool by name
   */
  disableTool(name: string): void {
    this.disabledTools.add(name);
    logger.info(`Tool disabled: ${name}`);
  }

  /**
   * Enable a tool by name
   */
  enableTool(name: string): void {
    this.disabledTools.delete(name);
    logger.info(`Tool enabled: ${name}`);
  }

  /**
   * Disable a backend by ID
   */
  disableBackend(id: string): void {
    this.disabledBackends.add(id);
    logger.info(`Backend disabled: ${id}`);
  }

  /**
   * Enable a backend by ID
   */
  enableBackend(id: string): void {
    this.disabledBackends.delete(id);
    logger.info(`Backend enabled: ${id}`);
  }

  /**
   * Load initial disabled state (called on startup)
   */
  loadDisabledState(disabledTools: string[], disabledBackends: string[]): void {
    this.disabledTools = new Set(disabledTools);
    this.disabledBackends = new Set(disabledBackends);
    logger.info(`Loaded UI state: ${disabledTools.length} disabled tools, ${disabledBackends.length} disabled backends`);
  }

  /**
   * Get all aggregated resources from all connected backends
   */
  getAllResources(): MCPResource[] {
    const resources: MCPResource[] = [];
    for (const backend of this.backends.values()) {
      if (backend.status === 'connected') {
        resources.push(...backend.resources);
      }
    }
    return resources;
  }

  /**
   * Get all aggregated prompts from all connected backends
   */
  getAllPrompts(): MCPPrompt[] {
    const prompts: MCPPrompt[] = [];
    for (const backend of this.backends.values()) {
      if (backend.status === 'connected') {
        prompts.push(...backend.prompts);
      }
    }
    return prompts;
  }

  /**
   * Route a tool call to the appropriate backend
   */
  async callTool(toolName: string, args: unknown): Promise<MCPResponse> {
    const backendId = this.toolToBackend.get(toolName);
    if (!backendId) {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: MCPErrorCodes.MethodNotFound,
          message: `Tool not found: ${toolName}`,
        },
      };
    }

    const backend = this.backends.get(backendId);
    if (!backend || backend.status !== 'connected') {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: MCPErrorCodes.InternalError,
          message: `Backend not connected: ${backendId}`,
        },
      };
    }

    // Use centralized prefix handling from backend
    const originalToolName = backend.unprefixToolName(toolName);

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: originalToolName,
        arguments: args,
      },
    };

    return backend.sendRequest(request);
  }

  /**
   * Read a resource from the appropriate backend
   */
  async readResource(uri: string): Promise<MCPResponse> {
    const backendId = this.resourceToBackend.get(uri);
    if (!backendId) {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: MCPErrorCodes.MethodNotFound,
          message: `Resource not found: ${uri}`,
        },
      };
    }

    const backend = this.backends.get(backendId);
    if (!backend || backend.status !== 'connected') {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: MCPErrorCodes.InternalError,
          message: `Backend not connected: ${backendId}`,
        },
      };
    }

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'resources/read',
      params: { uri },
    };

    return backend.sendRequest(request);
  }

  /**
   * Get a prompt from the appropriate backend
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<MCPResponse> {
    const backendId = this.promptToBackend.get(name);
    if (!backendId) {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: MCPErrorCodes.MethodNotFound,
          message: `Prompt not found: ${name}`,
        },
      };
    }

    const backend = this.backends.get(backendId);
    if (!backend || backend.status !== 'connected') {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: MCPErrorCodes.InternalError,
          message: `Backend not connected: ${backendId}`,
        },
      };
    }

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'prompts/get',
      params: { name, arguments: args },
    };

    return backend.sendRequest(request);
  }

  /**
   * Get backend status summary
   */
  getStatus(): Record<string, {
    status: string;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    error?: string;
    lastErrorAt?: string;
  }> {
    const status: Record<string, {
      status: string;
      toolCount: number;
      resourceCount: number;
      promptCount: number;
      error?: string;
      lastErrorAt?: string;
    }> = {};

    for (const [id, backend] of this.backends) {
      // lastErrorAt is only available on BaseBackend; use runtime check to avoid type issues
      const maybeLastErrorAt = (backend as unknown as { lastErrorAt?: Date }).lastErrorAt;
      status[id] = {
        status: backend.status,
        toolCount: backend.tools.length,
        resourceCount: backend.resources.length,
        promptCount: backend.prompts.length,
        error: backend.error,
        lastErrorAt: maybeLastErrorAt ? maybeLastErrorAt.toISOString() : undefined,
      };
    }

    return status;
  }

  /**
   * Disconnect all backends
   */
  async disconnectAll(): Promise<void> {
    // Cancel reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

    const promises = Array.from(this.backends.values()).map(backend =>
      backend.disconnect().catch(error => {
        logger.error(`Error disconnecting backend ${backend.id}`, { error });
      })
    );
    await Promise.all(promises);
    this.backends.clear();
    this.updateMappings();
  }

  /**
   * Execute multiple tool calls in parallel
   * Returns results in the same order as the input calls
   */
  async callToolsParallel(
    calls: Array<{ toolName: string; args: unknown }>
  ): Promise<MCPResponse[]> {
    const promises = calls.map(call => this.callTool(call.toolName, call.args));
    return Promise.all(promises);
  }

  /**
   * Execute multiple tool calls with concurrency limit
   * Useful for rate-limited backends or resource-constrained environments
   *
   * Uses a proper semaphore pattern to ensure exact concurrency limit
   */
  async callToolsConcurrent(
    calls: Array<{ toolName: string; args: unknown }>,
    concurrency: number = 5
  ): Promise<MCPResponse[]> {
    const results: MCPResponse[] = new Array(calls.length);

    // Semaphore implementation for proper concurrency control
    let activeCount = 0;
    const waitQueue: Array<() => void> = [];

    const acquire = (): Promise<void> => {
      return new Promise((resolve) => {
        if (activeCount < concurrency) {
          activeCount++;
          resolve();
        } else {
          waitQueue.push(resolve);
        }
      });
    };

    const release = (): void => {
      const next = waitQueue.shift();
      if (next) {
        // Transfer slot to next waiter (don't decrement activeCount)
        next();
      } else {
        activeCount--;
      }
    };

    // Process a single call with semaphore control
    const processCall = async (index: number): Promise<void> => {
      await acquire();
      try {
        results[index] = await this.callTool(calls[index].toolName, calls[index].args);
      } finally {
        release();
      }
    };

    // Start all calls - semaphore will control actual concurrency
    await Promise.all(calls.map((_, index) => processCall(index)));
    return results;
  }

  /**
   * Get the backend ID for a given tool name
   */
  getBackendForTool(toolName: string): string | undefined {
    return this.toolToBackend.get(toolName);
  }
}

