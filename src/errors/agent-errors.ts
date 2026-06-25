/**
 * Agent-friendly error messages for MCP Gateway.
 *
 * Format: "What failed. Likely cause: ... Suggested action: ..."
 * All messages are sanitized to avoid leaking secrets.
 */

import {
  BackendAgentContext,
  buildBackendAgentContext,
} from '../backend/base.js';
import type { AgentErrorCategory, AgentStructuredErrorContent, ServerConfig } from '../types.js';
import { MCPErrorCodes } from '../types.js';

export type { BackendAgentContext };

export interface AgentErrorParts {
  what: string;
  cause?: string;
  action?: string;
}

export type { AgentErrorCategory, AgentStructuredErrorContent };

export interface AgentErrorResult {
  message: string;
  structuredContent?: AgentStructuredErrorContent;
}

export interface AgentToolErrorResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  structuredContent: AgentStructuredErrorContent;
}

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[_-]?key|apikey|token|secret|password|authorization|auth)[=:\s]+[^\s,;'"}\]]+/gi,
  /[A-Za-z0-9+/]{32,}={0,2}/g,
  /:\/\/[^@\s]+:[^@\s]+@/g,
  /sessionId=[^&\s]+/gi,
  /Mcp-Session-Id:\s*\S+/gi,
];

export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  if (sanitized.length > 500) {
    sanitized = `${sanitized.slice(0, 497)}...`;
  }
  return sanitized;
}

export function formatAgentError(parts: AgentErrorParts): string {
  const segments = [parts.what];
  if (parts.cause) {
    segments.push(`Likely cause: ${parts.cause}`);
  }
  if (parts.action) {
    segments.push(`Suggested action: ${parts.action}`);
  }
  return sanitizeErrorMessage(segments.join(' '));
}

export function agentError(parts: AgentErrorParts): string {
  return formatAgentError(parts);
}

export function buildAgentError(
  parts: AgentErrorParts,
  structured?: AgentStructuredErrorContent,
): AgentErrorResult {
  const result: AgentErrorResult = { message: formatAgentError(parts) };
  if (structured) {
    result.structuredContent = structured;
  }
  return result;
}

export function buildAgentToolErrorResult(
  parts: AgentErrorParts,
  structured: AgentStructuredErrorContent,
): AgentToolErrorResult {
  return {
    content: [{ type: 'text', text: formatAgentError(parts) }],
    isError: true,
    structuredContent: structured,
  };
}

export function jsonRpcErrorData(
  structured?: AgentStructuredErrorContent,
): { structuredContent?: AgentStructuredErrorContent } | undefined {
  if (!structured) {
    return undefined;
  }
  return { structuredContent: structured };
}

/** Compact backend identity hint for agents (no secrets). */
export function backendContextHint(context: BackendAgentContext): string {
  const prefix = context.toolPrefix ? `${context.toolPrefix}_` : '(no prefix)';
  const endpoint = context.endpoint ? ` endpoint=${context.endpoint}` : '';
  return (
    `Backend id="${context.serverId}" name="${context.serverName}", ` +
    `tool prefix="${prefix}", transport=${context.transport}${endpoint}. ` +
    `Check GET ${context.healthCheckPath}.`
  );
}

export function withBackendContext(message: string, context?: BackendAgentContext): string {
  if (!context) {
    return message;
  }
  return sanitizeErrorMessage(`${message} ${backendContextHint(context)}`);
}

export function agentContextFromConfig(config: ServerConfig): BackendAgentContext {
  return buildBackendAgentContext(config);
}

export function suggestedActionForStatus(
  status: string,
  context: BackendAgentContext,
): string | undefined {
  switch (status) {
    case 'connected':
      return context.toolPrefix
        ? `Use tools prefixed with ${context.toolPrefix}_`
        : 'Backend tools are available without a prefix';
    case 'connecting':
      return `Wait for connection; poll GET ${context.healthCheckPath}`;
    case 'disconnected':
    case 'error':
      return `Check GET ${context.healthCheckPath}; gateway auto-reconnects enabled backends`;
    default:
      return undefined;
  }
}

export function reconnectScheduledMessage(
  context: BackendAgentContext,
  attempt: number,
  delayMs: number,
): string {
  return withBackendContext(
    agentError({
      what: `Reconnect scheduled for backend "${context.serverId}" in ${delayMs}ms (attempt ${attempt}).`,
      cause: 'The backend disconnected or failed; the gateway will retry with exponential backoff.',
      action: `Poll GET ${context.healthCheckPath} until status=connected, then retry ${context.toolPrefix ? `${context.toolPrefix}_*` : 'backend'} tools.`,
    }),
    context,
  );
}

export function reconnectFailedMessage(
  context: BackendAgentContext,
  attempt: number,
  detail: string,
): string {
  return withBackendContext(
    agentError({
      what: `Reconnect attempt ${attempt} failed for backend "${context.serverId}".`,
      cause: detail,
      action: `Check GET ${context.healthCheckPath}; fix transport config if errors persist.`,
    }),
    context,
  );
}

export function stdioTransportErrorMessage(options: {
  backendId: string;
  isTimeout?: boolean;
  isDisconnected?: boolean;
  isConnectFailure?: boolean;
  detail?: string;
  agent?: BackendAgentContext;
}): string {
  const { backendId, isTimeout, isDisconnected, isConnectFailure, detail, agent } = options;

  if (isDisconnected) {
    return withBackendContext(
      agentError({
        what: `STDIO backend "${backendId}" is disconnected.`,
        cause: 'The subprocess exited or the connection was closed.',
        action: 'Verify command/args in config/servers.json, check GET /health/deps, wait for reconnect.',
      }),
      agent,
    );
  }

  if (isTimeout) {
    return withBackendContext(
      agentError({
        what: `STDIO request to backend "${backendId}" timed out.`,
        cause: detail ?? 'The subprocess did not respond within the configured timeout.',
        action: 'Retry with smaller payloads or increase timeout in config/servers.json.',
      }),
      agent,
    );
  }

  if (isConnectFailure) {
    return withBackendContext(
      agentError({
        what: `STDIO backend "${backendId}" failed to connect.`,
        cause: detail ?? 'The subprocess exited or could not be started.',
        action: 'Verify command is on PATH and transport settings in config/servers.json.',
      }),
      agent,
    );
  }

  return withBackendContext(
    agentError({
      what: `STDIO backend "${backendId}" request failed.`,
      cause: detail ?? 'The subprocess returned an error.',
      action: 'Check GET /health/deps and backend stderr logs, then retry.',
    }),
    agent,
  );
}

export function fromError(error: unknown, fallback: AgentErrorParts): string {
  const detail =
    error instanceof Error ? sanitizeErrorMessage(error.message) : sanitizeErrorMessage(String(error));
  return formatAgentError({
    ...fallback,
    what: `${fallback.what} Detail: ${detail}.`,
  });
}

export function toolNotFoundMessage(toolName: string): string {
  return agentError({
    what: `Tool "${toolName}" is not registered with any connected backend.`,
    cause: 'The tool name may be misspelled, disabled, or its backend is offline.',
    action: 'Call gateway_search_tools or gateway_list_tool_names to find the correct name, then retry.',
  });
}

export function backendDisconnectedMessage(
  backendId: string,
  status?: string,
  agent?: BackendAgentContext,
): string {
  const statusHint = status ? ` Current status: ${status}.` : '';
  return withBackendContext(
    agentError({
      what: `Backend "${backendId}" is not connected.${statusHint}`,
      cause: 'The backend may be starting, crashed, or disabled in config.',
      action: 'Check GET /health/deps for per-backend status, wait for reconnect, then retry.',
    }),
    agent,
  );
}

export function circuitBreakerOpenMessage(
  backendId: string,
  lastFailureTime?: number,
  agent?: BackendAgentContext,
): string {
  const lastFailure = lastFailureTime
    ? ` Last failure: ${new Date(lastFailureTime).toISOString()}.`
    : '';
  return withBackendContext(
    agentError({
      what: `Circuit breaker is OPEN for backend "${backendId}".${lastFailure}`,
      cause: 'Repeated failures triggered the circuit breaker to protect the gateway.',
      action: 'Check GET /health/deps, fix the underlying issue, wait for circuit reset, then retry.',
    }),
    agent,
  );
}

export function resourceNotFoundMessage(uri: string): string {
  return agentError({
    what: `Resource "${uri}" was not found on any connected backend.`,
    cause: 'The URI may be wrong or the backend exposing it is offline.',
    action: 'Call resources/list to browse available URIs, then retry resources/read.',
  });
}

export function promptNotFoundMessage(name: string): string {
  return agentError({
    what: `Prompt "${name}" was not found on any connected backend.`,
    cause: 'The prompt name may be misspelled or its backend is offline.',
    action: 'Call prompts/list to browse available prompts, then retry prompts/get.',
  });
}

export function looksLikeSessionExpired(status: number, body?: string): boolean {
  if (status === 410) {
    return true;
  }
  if (!body) {
    return false;
  }
  const lower = body.toLowerCase();
  return (
    lower.includes('session') &&
    (lower.includes('expired') ||
      lower.includes('invalid') ||
      lower.includes('not found') ||
      lower.includes('unknown'))
  );
}

export function isRetryableTransportStatus(status?: number, body?: string): boolean {
  if (status === undefined) {
    return true;
  }
  if (status === 401 || status === 403) {
    return false;
  }
  if (looksLikeSessionExpired(status, body)) {
    return false;
  }
  if (status === 429) {
    return true;
  }
  return status >= 500 || status === 408;
}

function reconnectBackendAction(backendId: string): string {
  return `Reconnect via POST /api/backends/${encodeURIComponent(backendId)}/reconnect or the dashboard Reconnect button, verify config/servers.json, then retry.`;
}

function verifyConfigAction(backendId: string): string {
  return `Verify backend "${backendId}" in config/servers.json (url, transport.headers, timeout), then ${reconnectBackendAction(backendId)}`;
}

export function httpTransportErrorMessage(options: {
  backendId: string;
  status?: number;
  statusText?: string;
  body?: string;
  retryAfter?: string;
  isTimeout?: boolean;
  isDisconnected?: boolean;
  retriesExhausted?: boolean;
  agent?: BackendAgentContext;
}): string {
  const {
    backendId,
    status,
    statusText,
    body,
    retryAfter,
    isTimeout,
    isDisconnected,
    retriesExhausted,
    agent,
  } = options;

  if (isDisconnected) {
    return withBackendContext(
      agentError({
        what: `HTTP backend "${backendId}" is disconnected.`,
        cause: 'The connection was closed while a request was queued.',
        action: 'Wait for reconnect, check GET /health/deps, then retry.',
      }),
      agent,
    );
  }

  if (isTimeout) {
    return withBackendContext(
      agentError({
        what: `HTTP request to backend "${backendId}" timed out${retriesExhausted ? ' after retries' : ''}.`,
        cause: 'The remote server took too long or the payload/query is too large.',
        action: 'Retry with a smaller result set (lower maxRows), a narrower filter, or a longer backend timeout.',
      }),
      agent,
    );
  }

  if (status === 401 || status === 403) {
    return withBackendContext(
      agentError({
        what: `HTTP backend "${backendId}" rejected the request (${status}${statusText ? ` ${statusText}` : ''}).`,
        cause: 'Authentication or authorization failed for the remote MCP server.',
        action: `Verify transport.headers auth in config/servers.json (do not paste secrets into chat). ${reconnectBackendAction(backendId)}`,
      }),
      agent,
    );
  }

  if (status !== undefined && looksLikeSessionExpired(status, body)) {
    return withBackendContext(
      agentError({
        what: `HTTP backend "${backendId}" session expired or is invalid (${status}).`,
        cause: 'The Mcp-Session-Id is no longer accepted by the remote MCP server.',
        action: reconnectBackendAction(backendId),
      }),
      agent,
    );
  }

  if (status === 404) {
    return withBackendContext(
      agentError({
        what: `HTTP backend "${backendId}" endpoint not found (${status}).`,
        cause: 'The configured URL path may be wrong or the server is not running MCP HTTP transport.',
        action: verifyConfigAction(backendId),
      }),
      agent,
    );
  }

  if (status === 429) {
    const waitHint = retryAfter ? ` Wait about ${retryAfter}s (Retry-After).` : '';
    return withBackendContext(
      agentError({
        what: `HTTP backend "${backendId}" rate-limited the request (${status}).${waitHint}`,
        cause: 'Too many requests were sent in a short period.',
        action: 'Wait briefly, batch fewer calls (use gateway_execute_code), then retry.',
      }),
      agent,
    );
  }

  if (status !== undefined && status >= 500) {
    return withBackendContext(
      agentError({
        what: `HTTP backend "${backendId}" returned a server error (${status}${statusText ? ` ${statusText}` : ''}).`,
        cause: 'The remote MCP server encountered an internal error.',
        action: 'Check backend logs and GET /health/deps; retry once the backend reports connected.',
      }),
      agent,
    );
  }

  if (status !== undefined) {
    return withBackendContext(
      agentError({
        what: `HTTP request to backend "${backendId}" failed (${status}${statusText ? ` ${statusText}` : ''}).`,
        cause: 'The remote server rejected or could not process the request.',
        action: 'Check GET /health/deps and request parameters, then retry.',
      }),
      agent,
    );
  }

  return withBackendContext(
    agentError({
      what: `HTTP request to backend "${backendId}" failed${retriesExhausted ? ' after retries' : ''}.`,
      cause: 'Network error or the remote server is unreachable.',
      action: 'Check GET /health/deps, verify the backend URL, then retry.',
    }),
    agent,
  );
}

export function sseTransportErrorMessage(options: {
  backendId: string;
  phase: 'handshake' | 'request' | 'not-connected' | 'disconnected';
  status?: number;
  statusText?: string;
  body?: string;
  retryAfter?: string;
  isTimeout?: boolean;
  retriesExhausted?: boolean;
  agent?: BackendAgentContext;
}): string {
  const { backendId, phase, status, statusText, body, retryAfter, isTimeout, retriesExhausted, agent } = options;

  if (phase === 'not-connected') {
    return withBackendContext(
      agentError({
        what: `SSE backend "${backendId}" has no active POST endpoint.`,
        cause: 'The SSE handshake did not complete or the connection dropped.',
        action: reconnectBackendAction(backendId),
      }),
      agent,
    );
  }

  if (phase === 'disconnected') {
    return withBackendContext(
      agentError({
        what: `SSE backend "${backendId}" is disconnected.`,
        cause: 'The SSE stream closed while a request was queued.',
        action: reconnectBackendAction(backendId),
      }),
      agent,
    );
  }

  if (phase === 'handshake') {
    if (isTimeout) {
      return withBackendContext(
        agentError({
          what: `SSE handshake to backend "${backendId}" timed out.`,
          cause: 'The server did not send an endpoint event within the handshake window.',
          action: 'Verify the SSE URL in config/servers.json and check GET /health/deps, then retry.',
        }),
        agent,
      );
    }
    if (status !== undefined) {
      if (status === 401 || status === 403) {
        return withBackendContext(
          agentError({
            what: `SSE connection to backend "${backendId}" was rejected (${status}${statusText ? ` ${statusText}` : ''}).`,
            cause: 'Authentication or authorization failed during the SSE handshake.',
            action: `Verify transport.headers auth in config/servers.json (do not paste secrets into chat). ${verifyConfigAction(backendId)}`,
          }),
          agent,
        );
      }
      if (status === 429) {
        const waitHint = retryAfter ? ` Wait about ${retryAfter}s (Retry-After).` : '';
        return withBackendContext(
          agentError({
            what: `SSE connection to backend "${backendId}" was rate-limited (${status}).${waitHint}`,
            cause: 'Too many connection attempts in a short period.',
            action: 'Wait briefly, then retry the connection.',
          }),
          agent,
        );
      }
      return withBackendContext(
        agentError({
          what: `SSE connection to backend "${backendId}" failed (${status}${statusText ? ` ${statusText}` : ''}).`,
          cause: 'The server rejected the SSE connection or the URL is wrong.',
          action: verifyConfigAction(backendId),
        }),
        agent,
      );
    }
    return withBackendContext(
      agentError({
        what: `SSE handshake to backend "${backendId}" failed — no endpoint event received.`,
        cause: 'The server may not speak MCP SSE transport or closed the stream early.',
        action: 'Verify transport type and URL in config/servers.json, then retry.',
      }),
      agent,
    );
  }

  if (isTimeout) {
    return withBackendContext(
      agentError({
        what: `SSE request to backend "${backendId}" timed out${retriesExhausted ? ' after retries' : ''}.`,
        cause: 'The remote server took too long or the payload is too large.',
        action: 'Retry with a smaller result set (lower maxRows) or a narrower filter.',
      }),
      agent,
    );
  }

  if (status === 401 || status === 403) {
    return withBackendContext(
      agentError({
        what: `SSE backend "${backendId}" rejected the request (${status}).`,
        cause: 'Authentication or authorization failed for the remote MCP server.',
        action: `Verify transport.headers auth in config/servers.json (do not paste secrets into chat). ${reconnectBackendAction(backendId)}`,
      }),
      agent,
    );
  }

  if (status === 429) {
    const waitHint = retryAfter ? ` Wait about ${retryAfter}s (Retry-After).` : '';
    return withBackendContext(
      agentError({
        what: `SSE backend "${backendId}" rate-limited the request (${status}).${waitHint}`,
        cause: 'Too many requests were sent in a short period.',
        action: 'Wait briefly, batch fewer calls (use gateway_execute_code), then retry.',
      }),
      agent,
    );
  }

  if (status !== undefined && looksLikeSessionExpired(status, body)) {
    return withBackendContext(
      agentError({
        what: `SSE backend "${backendId}" session expired or is invalid (${status}).`,
        cause: 'The SSE POST session is no longer valid on the remote server.',
        action: reconnectBackendAction(backendId),
      }),
      agent,
    );
  }

  if (status !== undefined) {
    return withBackendContext(
      agentError({
        what: `SSE request to backend "${backendId}" failed (${status}${statusText ? ` ${statusText}` : ''}).`,
        cause: 'The remote server rejected or could not process the request.',
        action: 'Check GET /health/deps, then retry.',
      }),
      agent,
    );
  }

  return withBackendContext(
    agentError({
      what: `SSE request to backend "${backendId}" failed${retriesExhausted ? ' after retries' : ''}.`,
      cause: 'Network error or the SSE stream is unavailable.',
      action: 'Check GET /health/deps, wait for reconnect, then retry.',
    }),
    agent,
  );
}

export function gatewayToolErrorMessage(toolName: string, error: unknown): string {
  return fromError(error, {
    what: `Gateway tool "${toolName}" failed.`,
    cause: 'Invalid arguments, missing prerequisites, or an internal gateway error.',
    action: 'Review the tool schema via gateway_get_tool_schema, fix arguments, then retry.',
  });
}

export function codeExecutionErrorMessage(error: unknown, timeoutMs?: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeErrorMessage(message);

  if (/timed out/i.test(sanitized)) {
    return agentError({
      what: `Code execution timed out after ${timeoutMs ?? 'the configured'}ms.`,
      cause: 'The script ran too long or awaited a slow tool call.',
      action: 'Reduce batch size, add filters/maxRows on tool calls, or increase the timeout option.',
    });
  }

  if (/output truncated/i.test(sanitized)) {
    return agentError({
      what: 'Code execution output exceeded the size limit.',
      cause: 'console.log or return value produced too much data.',
      action: 'Log summaries only, use gateway_call_tool_filtered with maxRows, then retry.',
    });
  }

  if (/access denied/i.test(sanitized)) {
    return agentError({
      what: 'Code execution blocked a sandbox escape attempt.',
      cause: 'The script tried to access forbidden globals (Function, process, etc.).',
      action: 'Use only allowed sandbox APIs and gateway tool functions.',
    });
  }

  return fromError(error, {
    what: 'Code execution failed.',
    cause: 'A runtime error occurred in the sandboxed script.',
    action: 'Fix the script logic, verify tool names via gateway_search_tools, then retry.',
  });
}

export function toolAllowlistDeniedMessage(toolName: string): string {
  return agentError({
    what: `Direct call to tool "${toolName}" is blocked by the gateway allowlist.`,
    cause: 'CODE_EXECUTION_ALLOWED_TOOLS or CODE_EXECUTION_ALLOWED_TOOL_PREFIXES restricts direct MCP tool access.',
    action: 'Use an allowed gateway_* meta-tool (e.g. gateway_call_tool_filtered) or request allowlist changes.',
  });
}

export function handlerMethodNotFoundMessage(method: string): string {
  return agentError({
    what: `MCP method "${method}" is not supported by the gateway.`,
    cause: 'The client sent an unknown JSON-RPC method.',
    action: 'Use supported methods (tools/list, tools/call, resources/list, prompts/list) or gateway meta-tools.',
  });
}

function inferBackendToolErrorStructured(
  toolName: string,
  error: { code: number; message: string },
): AgentStructuredErrorContent {
  const msg = error.message;

  if (error.code === MCPErrorCodes.MethodNotFound || /not registered|Tool not found/i.test(msg)) {
    return {
      code: 'TOOL_NOT_FOUND',
      retryable: false,
      category: 'not_found',
      suggestedTool: 'gateway_search_tools',
      suggestedArgs: { query: toolName, detailLevel: 'name_description', limit: 10 },
    };
  }

  if (/Circuit breaker/i.test(msg)) {
    return {
      code: 'CIRCUIT_BREAKER_OPEN',
      retryable: true,
      category: 'backend',
      suggestedTool: 'gateway_agent_guide',
    };
  }

  if (/not connected/i.test(msg)) {
    return {
      code: 'BACKEND_DISCONNECTED',
      retryable: true,
      category: 'backend',
      suggestedTool: 'gateway_agent_guide',
    };
  }

  return {
    code: 'BACKEND_TOOL_FAILED',
    retryable: true,
    category: 'transport',
    suggestedTool: 'gateway_call_tool_filtered',
    suggestedArgs: { toolName, filter: { maxRows: 10, format: 'summary' } },
  };
}

/** Map a backend routing error into an MCP tools/call result with isError. */
export function backendToolCallErrorResult(
  toolName: string,
  error: { code: number; message: string },
): AgentToolErrorResult {
  return {
    content: [{ type: 'text', text: error.message }],
    isError: true,
    structuredContent: inferBackendToolErrorStructured(toolName, error),
  };
}

export function toolAllowlistDeniedResult(toolName: string): AgentToolErrorResult {
  return buildAgentToolErrorResult(
    {
      what: `Direct call to tool "${toolName}" is blocked by the gateway allowlist.`,
      cause: 'CODE_EXECUTION_ALLOWED_TOOLS or CODE_EXECUTION_ALLOWED_TOOL_PREFIXES restricts direct MCP tool access.',
      action: 'Use gateway_call_tool_filtered or gateway_execute_code instead.',
    },
    {
      code: 'TOOL_ALLOWLIST_DENIED',
      retryable: false,
      category: 'policy',
      suggestedTool: 'gateway_call_tool_filtered',
      suggestedArgs: { toolName, filter: { maxRows: 20, format: 'summary' } },
    },
  );
}
