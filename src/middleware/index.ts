/**
 * Middleware exports
 */

export { createAuthMiddleware, createOptionalAuthMiddleware } from './auth.js';
export type { AuthenticatedRequest } from './auth.js';
export {
  createAnonymousAuthorizationContext,
  createApiKeyAuthorizationContext,
  createOAuthAuthorizationContext,
  enforceAuthorization,
  evaluateAuthorization,
  parseScopes,
  scopesFromClaims,
} from './authorization.js';
export type {
  AuthorizationAction,
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationSource,
} from './authorization.js';
export { createRateLimitMiddleware } from './rateLimit.js';
export { createCorsMiddleware, resolveCorsCredentials } from './cors.js';
export {
  createGatewayStores,
  createInMemoryGatewayStores,
  createRedisGatewayStores,
  InMemoryRateLimitStore,
  InMemorySessionStore,
  RedisRateLimitStore,
  RedisSessionStore,
  stableCanonicalJson,
  StoreKeyBuilder,
} from './stores.js';
export type { GatewayStores, RateLimitEntry, RateLimitStore, RedisKeyValueClient, SessionStore } from './stores.js';
