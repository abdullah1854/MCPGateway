/**
 * Authentication Middleware
 * Supports API Key and OAuth authentication
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { GatewayConfig } from '../types.js';
import { logger } from '../logger.js';

export interface AuthenticatedRequest extends Request {
  auth?: {
    type: 'api-key' | 'oauth';
    subject?: string;
    claims?: Record<string, unknown>;
  };
}

/**
 * Create authentication middleware based on config
 */
export function createAuthMiddleware(config: GatewayConfig) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authMode = config.auth.mode;

    if (authMode === 'none') {
      return next();
    }

    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Authentication required',
        },
      });
    }

    try {
      if (authMode === 'api-key') {
        await validateApiKey(req, config);
      } else if (authMode === 'oauth') {
        await validateOAuth(req, config);
      }
      next();
    } catch (error) {
      logger.warn('Authentication failed', {
        error: error instanceof Error ? error.message : String(error),
        ip: req.ip,
      });
      
      return res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Authentication failed',
        },
      });
    }
  };
}

/**
 * Validate API key authentication
 */
async function validateApiKey(req: AuthenticatedRequest, config: GatewayConfig): Promise<void> {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    throw new Error('No authorization header');
  }

  let apiKey: string;

  // Support both "Bearer <key>" and "ApiKey <key>" formats
  if (authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  } else if (authHeader.startsWith('ApiKey ')) {
    apiKey = authHeader.slice(7);
  } else {
    // Also support just the key directly
    apiKey = authHeader;
  }

  const validKeys = config.auth.apiKeys ?? [];
  
  if (validKeys.length === 0) {
    throw new Error('No API keys configured');
  }

  if (!validKeys.includes(apiKey)) {
    throw new Error('Invalid API key');
  }

  req.auth = {
    type: 'api-key',
  };
}

/**
 * Validate OAuth token
 */
async function validateOAuth(req: AuthenticatedRequest, config: GatewayConfig): Promise<void> {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Invalid authorization header format');
  }

  const token = authHeader.slice(7);
  const oauthConfig = config.auth.oauth;

  if (!oauthConfig?.jwksUri) {
    throw new Error('OAuth not configured properly');
  }

  try {
    // Fetch JWKS (in production, you'd cache this)
    const jwksResponse = await fetch(oauthConfig.jwksUri);
    if (!jwksResponse.ok) {
      throw new Error('Failed to fetch JWKS');
    }

    const jwks = await jwksResponse.json() as { keys: Array<{ kid: string; x5c?: string[]; n?: string; e?: string }> };

    // Decode token header to get kid
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const header = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString()) as { kid?: string };
    const kid = header.kid;

    // Find matching key
    const key = jwks.keys.find((k: { kid: string }) => k.kid === kid);
    if (!key) {
      throw new Error('No matching key found');
    }

    // Convert JWK to PEM (simplified - in production use a proper library)
    const publicKey = jwkToPem(key);

    // Verify token
    const decoded = jwt.verify(token, publicKey, {
      issuer: oauthConfig.issuer,
      audience: oauthConfig.audience,
    }) as jwt.JwtPayload;

    req.auth = {
      type: 'oauth',
      subject: decoded.sub,
      claims: decoded as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error(`Token validation failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Simple JWK to PEM conversion
 * Note: In production, use a proper library like jwk-to-pem
 */
function jwkToPem(jwk: { x5c?: string[]; n?: string; e?: string }): string {
  // If x5c is available, use it
  if (jwk.x5c && jwk.x5c.length > 0) {
    return `-----BEGIN CERTIFICATE-----\n${jwk.x5c[0]}\n-----END CERTIFICATE-----`;
  }

  // Otherwise, construct from n and e (RSA)
  if (jwk.n && jwk.e) {
    // This is a simplified version - in production use a proper library
    // The actual PEM construction from n and e requires ASN.1 encoding
    throw new Error('JWK to PEM conversion from n/e not implemented - use x5c or a proper library');
  }

  throw new Error('Unsupported JWK format');
}

/**
 * Optional auth middleware - sets auth info if provided but doesn't require it
 */
export function createOptionalAuthMiddleware(config: GatewayConfig) {
  const authMiddleware = createAuthMiddleware(config);
  
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    // If no auth header, just continue
    if (!req.headers.authorization) {
      return next();
    }

    // Try to authenticate, but don't fail if it doesn't work
    try {
      await new Promise<void>((resolve, reject) => {
        authMiddleware(req, res, (err?: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch {
      // Ignore auth errors for optional auth
    }
    
    next();
  };
}

