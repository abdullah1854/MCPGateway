/**
 * MCP Gateway Type Definitions
 */

import { z } from 'zod';

// Transport configuration schemas
export const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

export const HttpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const SseTransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const TransportSchema = z.discriminatedUnion('type', [
  StdioTransportSchema,
  HttpTransportSchema,
  SseTransportSchema,
]);

// Server configuration schema
export const ServerConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  transport: TransportSchema,
  toolPrefix: z.string().regex(/^[a-z0-9_]+$/).optional(),
  timeout: z.number().min(1000).max(300000).default(30000),
  retries: z.number().min(0).max(5).default(3),
});

export const ServersConfigSchema = z.object({
  servers: z.array(ServerConfigSchema),
});

// Gateway configuration
export const GatewayConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('0.0.0.0'),
  name: z.string().default('mcp-gateway'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  auth: z.object({
    mode: z.enum(['none', 'api-key', 'oauth']).default('none'),
    apiKeys: z.array(z.string()).optional(),
    oauth: z.object({
      issuer: z.string().optional(),
      audience: z.string().optional(),
      jwksUri: z.string().optional(),
    }).optional(),
  }).default({ mode: 'none' }),
  cors: z.object({
    origins: z.union([z.string(), z.array(z.string())]).default('*'),
  }).default({ origins: '*' }),
  rateLimit: z.object({
    windowMs: z.number().default(60000),
    maxRequests: z.number().default(100),
  }).default({ windowMs: 60000, maxRequests: 100 }),
});

// Export types
export type StdioTransport = z.infer<typeof StdioTransportSchema>;
export type HttpTransport = z.infer<typeof HttpTransportSchema>;
export type SseTransport = z.infer<typeof SseTransportSchema>;
export type Transport = z.infer<typeof TransportSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServersConfig = z.infer<typeof ServersConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

// MCP Protocol Types
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface MCPServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

// Gateway-specific types
export interface BackendServer {
  config: ServerConfig;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
  capabilities?: MCPServerCapabilities;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
}

export interface GatewaySession {
  id: string;
  createdAt: Date;
  lastActivityAt: Date;
  initialized: boolean;
  clientInfo?: {
    name?: string;
    version?: string;
  };
}

// Request/Response types for MCP protocol
export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type MCPMessage = MCPRequest | MCPResponse | MCPNotification;

// Error codes
export const MCPErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  UnknownError: -32001,
} as const;

