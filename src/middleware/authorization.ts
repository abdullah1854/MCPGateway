import { createHash } from 'crypto';
import { AuthorizationContext } from '../types.js';
import { AuditLogger } from '../monitoring/audit.js';

export type AuthorizationAction = 'tool_call' | 'gateway_tool_call' | 'code_execute';
export type AuthorizationSource = 'mcp' | 'code-api' | 'sandbox' | 'gateway-wrapper';

export interface AuthorizationRequest {
  action: AuthorizationAction;
  authorization?: AuthorizationContext;
  toolName?: string;
  gatewayToolName?: string;
  sessionId?: string;
  source: AuthorizationSource;
}

export type AuthorizationDecision =
  | { allowed: true; requiredScopes: string[] }
  | { allowed: false; reason: string; requiredScopes: string[] };

export function createAnonymousAuthorizationContext(): AuthorizationContext {
  return {
    type: 'anonymous',
    subject: 'anonymous',
    scopes: ['*'],
  };
}

export function createApiKeyAuthorizationContext(apiKey: string): AuthorizationContext {
  const scopeMap = parseMapping(process.env.API_KEY_SCOPES);
  const identityMap = parseMapping(process.env.API_KEY_IDENTITIES);
  const defaultScopes = process.env.API_KEY_DEFAULT_SCOPES ?? '*';
  const subject = identityMap.get(apiKey) ?? `api-key:${hashKey(apiKey)}`;

  return {
    type: 'api-key',
    subject,
    scopes: parseScopes(scopeMap.get(apiKey) ?? defaultScopes),
  };
}

export function createOAuthAuthorizationContext(claims: Record<string, unknown>): AuthorizationContext {
  const subject = typeof claims.sub === 'string' && claims.sub.length > 0
    ? claims.sub
    : 'oauth:unknown';

  return {
    type: 'oauth',
    subject,
    scopes: scopesFromClaims(claims),
    claims,
  };
}

export function evaluateAuthorization(request: AuthorizationRequest): AuthorizationDecision {
  const requiredScopes = getRequiredScopes(request);
  const auth = request.authorization;

  if (!auth) {
    return {
      allowed: false,
      reason: 'missing authorization context',
      requiredScopes,
    };
  }

  if (requiredScopes.length === 0 || hasAnyScope(auth.scopes, requiredScopes)) {
    return { allowed: true, requiredScopes };
  }

  return {
    allowed: false,
    reason: `missing required scope for ${request.action}`,
    requiredScopes,
  };
}

export function enforceAuthorization(
  request: AuthorizationRequest,
  auditLogger?: AuditLogger,
): AuthorizationDecision {
  const decision = evaluateAuthorization(request);
  if (!decision.allowed) {
    auditLogger?.logPolicyDeny({
      actor: request.authorization?.subject,
      target: request.toolName ?? request.gatewayToolName ?? request.action,
      reason: decision.reason,
      details: {
        action: request.action,
        source: request.source,
        sessionId: request.sessionId,
        toolName: request.toolName,
        gatewayToolName: request.gatewayToolName,
        requiredScopes: decision.requiredScopes,
      },
    });
  }
  return decision;
}

export function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return uniqueScopes(raw.flatMap(parseScopes));
  }

  if (typeof raw !== 'string') {
    return [];
  }

  return uniqueScopes(raw
    .split(/[,\s]+/)
    .map(scope => scope.trim())
    .filter(Boolean));
}

export function scopesFromClaims(claims: Record<string, unknown>): string[] {
  const scopes = [
    ...parseScopes(claims.scope),
    ...parseScopes(claims.scp),
  ];
  return uniqueScopes(scopes);
}

function getRequiredScopes(request: AuthorizationRequest): string[] {
  switch (request.action) {
    case 'code_execute':
      return ['code:execute'];
    case 'gateway_tool_call':
      return gatewayScopes(request.gatewayToolName);
    case 'tool_call':
      return toolScopes(request.toolName);
  }
}

function gatewayScopes(gatewayToolName?: string): string[] {
  if (!gatewayToolName) return ['gateway:call'];
  if (gatewayToolName.endsWith('_execute_code')) {
    return ['code:execute'];
  }
  return [`gateway:${gatewayToolName}`, 'gateway:call'];
}

function toolScopes(toolName?: string): string[] {
  if (!toolName) return ['tool:call'];
  return [`tool:${toolName}`, 'tool:call'];
}

function hasAnyScope(grantedScopes: string[], requiredScopes: string[]): boolean {
  const granted = new Set(grantedScopes);
  for (const required of requiredScopes) {
    if (scopeMatches(granted, required)) {
      return true;
    }
  }
  return false;
}

function scopeMatches(granted: Set<string>, required: string): boolean {
  if (granted.has('*') || granted.has(required)) {
    return true;
  }

  const namespace = required.split(':')[0];
  return granted.has(`${namespace}:*`) || granted.has('mcp:*');
}

function parseMapping(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  for (const entry of raw.split(';')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (key && value) {
      map.set(key, value);
    }
  }

  return map;
}

function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

function uniqueScopes(scopes: string[]): string[] {
  return [...new Set(scopes)];
}
