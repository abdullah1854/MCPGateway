/**
 * MCP Protocol Handler
 * Handles JSON-RPC messages and routes them to appropriate backends
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MCPRequest,
  MCPResponse,
  MCPMessage,
  GatewaySession,
  MCPErrorCodes,
} from '../types.js';
import { BackendManager } from '../backend/index.js';
import { logger } from '../logger.js';
import { createGatewayTools, GatewayTool } from '../code-execution/gateway-tools.js';

const PROTOCOL_VERSION = '2024-11-05';

export class MCPProtocolHandler {
  private sessions = new Map<string, GatewaySession>();
  private backendManager: BackendManager;
  private gatewayName: string;
  private gatewayVersion: string;
  private gatewayTools: GatewayTool[];
  private gatewayToolCall: (name: string, args: unknown) => Promise<unknown>;
  private gatewayToolNames: Set<string>;

  constructor(backendManager: BackendManager, gatewayName = 'mcp-gateway', gatewayVersion = '1.0.0') {
    this.backendManager = backendManager;
    this.gatewayName = gatewayName;
    this.gatewayVersion = gatewayVersion;

    // Initialize gateway tools for progressive disclosure
    const { tools, callTool } = createGatewayTools(backendManager, {
      prefix: 'gateway',
      enableCodeExecution: true,
      enableSkills: true,
    });
    this.gatewayTools = tools;
    this.gatewayToolCall = callTool;
    this.gatewayToolNames = new Set(tools.map(t => t.name));

    logger.info(`Gateway tools initialized: ${tools.length} tools available`);
  }

  /**
   * Create or get a session
   */
  getOrCreateSession(sessionId?: string): GatewaySession {
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      session.lastActivityAt = new Date();
      return session;
    }

    const newSession: GatewaySession = {
      id: sessionId ?? uuidv4(),
      createdAt: new Date(),
      lastActivityAt: new Date(),
      initialized: false,
    };

    this.sessions.set(newSession.id, newSession);
    return newSession;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): GatewaySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Handle incoming MCP message
   */
  async handleMessage(message: MCPMessage, session: GatewaySession): Promise<MCPResponse | null> {
    // Update session activity
    session.lastActivityAt = new Date();

    // Check if it's a request (has id) or notification (no id)
    if (!('id' in message) || message.id === null || message.id === undefined) {
      // It's a notification, handle it but don't respond
      await this.handleNotification(message as MCPRequest, session);
      return null;
    }

    const request = message as MCPRequest;

    try {
      return await this.handleRequest(request, session);
    } catch (error) {
      logger.error('Error handling request', {
        method: request.method,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCodes.InternalError,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }

  /**
   * Handle a request
   */
  private async handleRequest(request: MCPRequest, session: GatewaySession): Promise<MCPResponse> {
    logger.debug(`Handling request: ${request.method}`, { id: request.id });

    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request, session);
      
      case 'ping':
        return this.handlePing(request);
      
      case 'tools/list':
        return this.handleToolsList(request, session);
      
      case 'tools/call':
        return this.handleToolsCall(request, session);
      
      case 'resources/list':
        return this.handleResourcesList(request, session);
      
      case 'resources/read':
        return this.handleResourcesRead(request, session);
      
      case 'prompts/list':
        return this.handlePromptsList(request, session);
      
      case 'prompts/get':
        return this.handlePromptsGet(request, session);

      // Note: completion/complete is not supported by the gateway
      // Clients should check capabilities before calling

      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: MCPErrorCodes.MethodNotFound,
            message: `Method not found: ${request.method}`,
          },
        };
    }
  }

  /**
   * Handle notification (no response needed)
   */
  private async handleNotification(notification: MCPRequest, session: GatewaySession): Promise<void> {
    logger.debug(`Handling notification: ${notification.method}`);

    switch (notification.method) {
      case 'notifications/initialized':
        session.initialized = true;
        logger.info(`Session ${session.id} initialized`);
        break;
      
      case 'notifications/cancelled':
        // Handle request cancellation
        logger.debug('Request cancelled', { params: notification.params });
        break;

      default:
        logger.debug(`Unhandled notification: ${notification.method}`);
    }
  }

  /**
   * Handle initialize request
   */
  private handleInitialize(request: MCPRequest, session: GatewaySession): MCPResponse {
    const params = request.params as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      clientInfo?: { name: string; version: string };
    };

    session.clientInfo = params.clientInfo;

    logger.info(`Initialize request from client`, {
      sessionId: session.id,
      clientInfo: params.clientInfo,
      protocolVersion: params.protocolVersion,
    });

    // Build aggregated capabilities (use enabled tools count)
    const hasTools = this.backendManager.getEnabledTools().length > 0;
    const hasResources = this.backendManager.getAllResources().length > 0;
    const hasPrompts = this.backendManager.getAllPrompts().length > 0;

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          ...(hasTools && { tools: { listChanged: true } }),
          ...(hasResources && { resources: { subscribe: false, listChanged: true } }),
          ...(hasPrompts && { prompts: { listChanged: true } }),
        },
        serverInfo: {
          name: this.gatewayName,
          version: this.gatewayVersion,
        },
      },
    };
  }

  /**
   * Handle ping request
   */
  private handlePing(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {},
    };
  }

  /**
   * Handle tools/list request
   */
  private handleToolsList(request: MCPRequest, session: GatewaySession): MCPResponse {
    if (!session.initialized) {
      // Some clients may list tools before sending initialized notification
      // We'll allow this but log it
      logger.debug('tools/list called before initialized notification');
    }

    // PROGRESSIVE DISCLOSURE: Only expose gateway meta-tools
    // Backend tools are discovered via gateway_search_tools and called via gateway_call_tool_filtered
    // This reduces token usage from 200k+ to ~10k for large tool collections
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: this.gatewayTools },
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(request: MCPRequest, session: GatewaySession): Promise<MCPResponse> {
    if (!session.initialized) {
      logger.debug('tools/call called before initialized notification');
    }

    const params = request.params as { name: string; arguments?: unknown };

    if (!params.name) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCodes.InvalidParams,
          message: 'Missing tool name',
        },
      };
    }

    logger.info(`Calling tool: ${params.name}`, { sessionId: session.id });

    // Check if this is a gateway tool
    if (this.gatewayToolNames.has(params.name)) {
      try {
        const result = await this.gatewayToolCall(params.name, params.arguments ?? {});
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          },
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: MCPErrorCodes.InternalError,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    // Route to backend
    const response = await this.backendManager.callTool(params.name, params.arguments ?? {});

    // Return the response with the original request ID
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: response.result,
      error: response.error,
    };
  }

  /**
   * Handle resources/list request
   */
  private handleResourcesList(request: MCPRequest, session: GatewaySession): MCPResponse {
    if (!session.initialized) {
      logger.debug('resources/list called before initialized notification');
    }

    const resources = this.backendManager.getAllResources();

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { resources },
    };
  }

  /**
   * Handle resources/read request
   */
  private async handleResourcesRead(request: MCPRequest, session: GatewaySession): Promise<MCPResponse> {
    if (!session.initialized) {
      logger.debug('resources/read called before initialized notification');
    }

    const params = request.params as { uri: string };

    if (!params.uri) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCodes.InvalidParams,
          message: 'Missing resource URI',
        },
      };
    }

    const response = await this.backendManager.readResource(params.uri);

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: response.result,
      error: response.error,
    };
  }

  /**
   * Handle prompts/list request
   */
  private handlePromptsList(request: MCPRequest, session: GatewaySession): MCPResponse {
    if (!session.initialized) {
      logger.debug('prompts/list called before initialized notification');
    }

    const prompts = this.backendManager.getAllPrompts();

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { prompts },
    };
  }

  /**
   * Handle prompts/get request
   */
  private async handlePromptsGet(request: MCPRequest, session: GatewaySession): Promise<MCPResponse> {
    if (!session.initialized) {
      logger.debug('prompts/get called before initialized notification');
    }

    const params = request.params as { name: string; arguments?: Record<string, string> };

    if (!params.name) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCodes.InvalidParams,
          message: 'Missing prompt name',
        },
      };
    }

    const response = await this.backendManager.getPrompt(params.name, params.arguments);

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: response.result,
      error: response.error,
    };
  }

  /**
   * Clean up old sessions
   */
  cleanupSessions(maxAgeMs = 3600000): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > maxAgeMs) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} stale sessions`);
    }
  }
}
