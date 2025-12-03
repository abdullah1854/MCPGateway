/**
 * SSE Transport Handler
 * Implements Server-Sent Events transport for MCP
 */

import { Request, Response, Router } from 'express';
import { MCPProtocolHandler } from '../protocol/index.js';
import { MCPRequest, MCPMessage } from '../types.js';
import { logger } from '../logger.js';

interface SSEConnection {
  sessionId: string;
  response: Response;
  lastActivity: number;
}

const connections = new Map<string, SSEConnection>();

// Clean up stale connections periodically
setInterval(() => {
  const now = Date.now();
  const staleTimeout = 5 * 60 * 1000; // 5 minutes

  for (const [id, conn] of connections) {
    if (now - conn.lastActivity > staleTimeout) {
      logger.debug(`Cleaning up stale SSE connection: ${id}`);
      conn.response.end();
      connections.delete(id);
    }
  }
}, 60000);

export function createSseTransport(protocolHandler: MCPProtocolHandler): Router {
  const router = Router();

  /**
   * GET /sse - Establish SSE connection
   */
  router.get('/', (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    const session = protocolHandler.getOrCreateSession(sessionId);

    logger.info(`SSE connection established`, { sessionId: session.id });

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial connection event
    res.write(`event: open\n`);
    res.write(`data: ${JSON.stringify({ sessionId: session.id })}\n\n`);

    // Store connection
    const connection: SSEConnection = {
      sessionId: session.id,
      response: res,
      lastActivity: Date.now(),
    };
    connections.set(session.id, connection);

    // Set up heartbeat
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: heartbeat\n\n`);
        connection.lastActivity = Date.now();
      }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      logger.info(`SSE connection closed`, { sessionId: session.id });
      clearInterval(heartbeat);
      connections.delete(session.id);
    });
  });

  /**
   * POST /sse - Send message via SSE
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Missing session ID',
        },
      });
      return;
    }

    const connection = connections.get(sessionId);
    if (!connection) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'No active SSE connection for session',
        },
      });
      return;
    }

    const session = protocolHandler.getSession(sessionId);
    if (!session) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Session not found',
        },
      });
      return;
    }

    const body = req.body as MCPMessage;

    try {
      const response = await protocolHandler.handleMessage(body, session);

      if (response !== null) {
        // Send response through SSE connection
        sendSSEMessage(connection, 'message', response);
      }

      connection.lastActivity = Date.now();
      res.status(202).json({ status: 'accepted' });
    } catch (error) {
      logger.error('Error handling SSE request', { error });
      
      const errorResponse = {
        jsonrpc: '2.0',
        id: (body as MCPRequest).id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };

      sendSSEMessage(connection, 'message', errorResponse);
      res.status(500).json(errorResponse);
    }
  });

  /**
   * DELETE /sse - Close SSE connection
   */
  router.delete('/', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    
    if (sessionId) {
      const connection = connections.get(sessionId);
      if (connection) {
        connection.response.end();
        connections.delete(sessionId);
        logger.info(`SSE connection closed by client`, { sessionId });
      }
    }

    res.status(204).send();
  });

  return router;
}

/**
 * Send a message through an SSE connection
 */
function sendSSEMessage(connection: SSEConnection, event: string, data: unknown): void {
  if (connection.response.writableEnded) {
    return;
  }

  connection.response.write(`event: ${event}\n`);
  connection.response.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Broadcast a message to all connected clients
 */
export function broadcastSSEMessage(event: string, data: unknown): void {
  for (const connection of connections.values()) {
    sendSSEMessage(connection, event, data);
  }
}

/**
 * Send a message to a specific session
 */
export function sendToSession(sessionId: string, event: string, data: unknown): boolean {
  const connection = connections.get(sessionId);
  if (connection) {
    sendSSEMessage(connection, event, data);
    return true;
  }
  return false;
}

