/**
 * MCP Gateway Server
 * Main server implementation with HTTP and SSE transports
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { GatewayConfig, ServersConfig } from './types.js';
import { BackendManager } from './backend/index.js';
import { MCPProtocolHandler } from './protocol/index.js';
import { createHttpTransport, createSseTransport, broadcastSSEMessage } from './transports/index.js';
import { createDashboardRoutes } from './dashboard/index.js';
import { createCodeExecutionRoutes } from './code-execution/index.js';
import { createAuthMiddleware, createRateLimitMiddleware } from './middleware/index.js';
import { MetricsCollector, createMetricsRoutes, AuditLogger } from './monitoring/index.js';
import { logger } from './logger.js';

export class MCPGatewayServer {
  private app: Express;
  private backendManager: BackendManager;
  private protocolHandler: MCPProtocolHandler;
  private config: GatewayConfig;
  private server: ReturnType<Express['listen']> | null = null;
  private sessionCleanupInterval: NodeJS.Timeout | null = null;
  private metricsCollector: MetricsCollector;
  private auditLogger: AuditLogger;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.app = express();
    this.backendManager = new BackendManager();
    this.protocolHandler = new MCPProtocolHandler(
      this.backendManager,
      config.name,
      '1.0.0'
    );
    this.metricsCollector = new MetricsCollector();
    this.auditLogger = new AuditLogger();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupEventHandlers();
  }

  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    // Security headers (relaxed for MCP compatibility)
    this.app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }));

    // CORS
    const corsOrigins = this.config.cors.origins;
    this.app.use(cors({
      origin: corsOrigins === '*' ? '*' : corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Accept'],
      exposedHeaders: ['Mcp-Session-Id'],
    }));

    // Compression
    this.app.use(compression());

    // JSON body parser
    this.app.use(express.json({ limit: '10mb' }));

    // Rate limiting
    this.app.use(createRateLimitMiddleware(this.config));

    // Authentication
    this.app.use(createAuthMiddleware(this.config));

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug(`${req.method} ${req.path}`, {
        ip: req.ip,
        sessionId: req.headers['mcp-session-id'],
      });
      next();
    });
  }

  /**
   * Set up routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      const status = this.backendManager.getStatus();
      const connectedCount = Object.values(status).filter(s => s.status === 'connected').length;
      const totalCount = Object.keys(status).length;
      const allTools = this.backendManager.getAllTools();
      const enabledTools = this.backendManager.getEnabledTools();
      const metricsSummary = this.metricsCollector.getSummary();

      res.json({
        status: 'ok',
        gateway: this.config.name,
        backends: {
          connected: connectedCount,
          total: totalCount,
          details: status,
        },
        tools: {
          enabled: enabledTools.length,
          total: allTools.length,
        },
        resources: this.backendManager.getAllResources().length,
        prompts: this.backendManager.getAllPrompts().length,
        metrics: {
          uptime: metricsSummary.uptime,
          requestCount: metricsSummary.requestCount,
          errorRate: metricsSummary.errorRate,
          latency: metricsSummary.latency,
        },
        endpoints: {
          dashboard: `http://localhost:${this.config.port}/dashboard`,
          codeExecution: `http://localhost:${this.config.port}/api/code`,
          toolSearch: `http://localhost:${this.config.port}/api/code/tools/search`,
          sdk: `http://localhost:${this.config.port}/api/code/sdk`,
          metrics: `http://localhost:${this.config.port}/metrics`,
          metricsJson: `http://localhost:${this.config.port}/metrics/json`,
        },
      });
    });

    // Dashboard UI
    this.app.use('/dashboard', createDashboardRoutes(this.backendManager));

    // Code Execution API (Progressive Tool Disclosure + Code Mode)
    this.app.use('/api/code', createCodeExecutionRoutes(this.backendManager));

    // Metrics & Monitoring (Prometheus format)
    this.app.use('/', createMetricsRoutes(this.backendManager, this.metricsCollector));

    // MCP endpoints
    this.app.use('/mcp', createHttpTransport(this.protocolHandler));
    this.app.use('/sse', createSseTransport(this.protocolHandler));

    // Legacy endpoint aliases
    this.app.use('/v1/mcp', createHttpTransport(this.protocolHandler));

    // 404 handler
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: 'Use /mcp for HTTP Streamable or /sse for SSE transport',
      });
    });

    // Error handler
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled error', { error: err.message, stack: err.stack });
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
      });
    });
  }

  /**
   * Set up backend event handlers
   */
  private setupEventHandlers(): void {
    this.backendManager.on('backendConnected', (id: string) => {
      logger.info(`Backend connected: ${id}`);
    });

    this.backendManager.on('backendDisconnected', (id: string) => {
      logger.warn(`Backend disconnected: ${id}`);
    });

    this.backendManager.on('backendError', (id: string, error: Error) => {
      logger.error(`Backend error: ${id}`, { error: error.message });
    });

    this.backendManager.on('toolsUpdated', () => {
      logger.info('Tools updated, notifying clients');
      broadcastSSEMessage('notification', {
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      });
    });

    this.backendManager.on('resourcesUpdated', () => {
      logger.info('Resources updated, notifying clients');
      broadcastSSEMessage('notification', {
        jsonrpc: '2.0',
        method: 'notifications/resources/list_changed',
      });
    });

    this.backendManager.on('promptsUpdated', () => {
      logger.info('Prompts updated, notifying clients');
      broadcastSSEMessage('notification', {
        jsonrpc: '2.0',
        method: 'notifications/prompts/list_changed',
      });
    });
  }

  /**
   * Load and connect to backend servers
   */
  async loadBackends(serversConfig: ServersConfig): Promise<void> {
    const enabledServers = serversConfig.servers.filter(s => s.enabled);
    
    logger.info(`Loading ${enabledServers.length} backend servers`);

    for (const serverConfig of enabledServers) {
      try {
        await this.backendManager.addBackend(serverConfig);
      } catch (error) {
        logger.error(`Failed to add backend ${serverConfig.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        logger.info(`MCP Gateway started`, {
          host: this.config.host,
          port: this.config.port,
          endpoints: {
            http: `http://${this.config.host}:${this.config.port}/mcp`,
            sse: `http://${this.config.host}:${this.config.port}/sse`,
            health: `http://${this.config.host}:${this.config.port}/health`,
          },
        });

        // Start session cleanup
        this.sessionCleanupInterval = setInterval(() => {
          this.protocolHandler.cleanupSessions();
        }, 60000);

        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    logger.info('Shutting down MCP Gateway...');

    // Stop session cleanup
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
    }

    // Disconnect all backends
    await this.backendManager.disconnectAll();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    logger.info('MCP Gateway stopped');
  }

  /**
   * Get the Express app (for testing)
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * Get the backend manager
   */
  getBackendManager(): BackendManager {
    return this.backendManager;
  }

  /**
   * Get the metrics collector
   */
  getMetricsCollector(): MetricsCollector {
    return this.metricsCollector;
  }

  /**
   * Get the audit logger
   */
  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }
}

