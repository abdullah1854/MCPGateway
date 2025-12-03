/**
 * HTTP Streamable Transport Handler
 * Implements the MCP HTTP Streamable transport specification
 */

import { Request, Response, Router } from 'express';
import { MCPProtocolHandler } from '../protocol/index.js';
import { MCPRequest, MCPMessage } from '../types.js';
import { logger } from '../logger.js';

export function createHttpTransport(protocolHandler: MCPProtocolHandler): Router {
  const router = Router();

  /**
   * Handle POST requests - main MCP endpoint
   * Supports both single requests and batch requests
   */
  router.post('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = protocolHandler.getOrCreateSession(sessionId);

    // Set session ID header
    res.setHeader('Mcp-Session-Id', session.id);

    const body = req.body;

    // Check if it's a batch request
    if (Array.isArray(body)) {
      await handleBatchRequest(body, session, protocolHandler, res);
    } else {
      await handleSingleRequest(body, session, protocolHandler, req, res);
    }
  });

  /**
   * Handle GET requests - server info
   */
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'MCP Gateway',
      version: '1.0.0',
      protocol: '2024-11-05',
      transports: ['http', 'sse'],
    });
  });

  /**
   * Handle DELETE requests - close session
   */
  router.delete('/', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    
    if (sessionId) {
      const session = protocolHandler.getSession(sessionId);
      if (session) {
        logger.info(`Session ${sessionId} closed by client`);
      }
    }

    res.status(204).send();
  });

  return router;
}

/**
 * Handle a single MCP request
 */
async function handleSingleRequest(
  body: MCPMessage,
  session: ReturnType<MCPProtocolHandler['getOrCreateSession']>,
  protocolHandler: MCPProtocolHandler,
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const response = await protocolHandler.handleMessage(body, session);

    if (response === null) {
      // It was a notification, no response needed
      res.status(202).json({ status: 'accepted' });
      return;
    }

    // Always return JSON for HTTP Streamable transport
    // Cursor and other clients expect plain JSON, not SSE format
    res.json(response);
  } catch (error) {
    logger.error('Error handling request', { error });
    
    const errorResponse = {
      jsonrpc: '2.0',
      id: (body as MCPRequest).id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };

    res.status(500).json(errorResponse);
  }
}

/**
 * Handle a batch of MCP requests
 */
async function handleBatchRequest(
  messages: MCPMessage[],
  session: ReturnType<MCPProtocolHandler['getOrCreateSession']>,
  protocolHandler: MCPProtocolHandler,
  res: Response
): Promise<void> {
  const responses: unknown[] = [];

  for (const message of messages) {
    try {
      const response = await protocolHandler.handleMessage(message, session);
      if (response !== null) {
        responses.push(response);
      }
    } catch (error) {
      responses.push({
        jsonrpc: '2.0',
        id: (message as MCPRequest).id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      });
    }
  }

  res.json(responses);
}

