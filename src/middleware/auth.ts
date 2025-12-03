/**
 * Authentication Middleware
 * Supports API Key and OAuth authentication
 *
 * Security features:
 * - Constant-time comparison for API keys to prevent timing attacks
 * - JWKS caching with TTL to prevent DoS on OAuth endpoint
 * - Proper scheme validation (Bearer/ApiKey)
 */

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { GatewayConfig } from '../types.js';
import { logger } from '../logger.js';

// JWKS cache with TTL
interface JWKSCache {
  keys: Array<{ kid: string; x5c?: string[]; n?: string; e?: string; kty?: string }>;
  fetchedAt: number;
}

const jwksCache = new Map<string, JWKSCache>();
const JWKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeCompare(a: string, b: string): boolean {
  // Convert strings to buffers for comparison
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  // If lengths differ, we still need to do a comparison to avoid timing leaks
  // but we know they're not equal
  if (bufA.length !== bufB.length) {
    // Compare against self to maintain constant time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

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
 * Uses constant-time comparison to prevent timing attacks
 */
async function validateApiKey(req: AuthenticatedRequest, config: GatewayConfig): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new Error('No authorization header');
  }

  let apiKey: string;

  // Require proper scheme - no bare keys for security
  if (authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  } else if (authHeader.startsWith('ApiKey ')) {
    apiKey = authHeader.slice(7);
  } else {
    throw new Error('Invalid authorization format. Use "Bearer <key>" or "ApiKey <key>"');
  }

  const validKeys = config.auth.apiKeys ?? [];

  if (validKeys.length === 0) {
    throw new Error('No API keys configured');
  }

  // Use constant-time comparison for ALL keys to prevent timing attacks
  // that could reveal which key exists
  let isValid = false;
  for (const validKey of validKeys) {
    if (constantTimeCompare(apiKey, validKey)) {
      isValid = true;
      // Don't break early - continue checking all keys for constant time
    }
  }

  if (!isValid) {
    throw new Error('Invalid API key');
  }

  req.auth = {
    type: 'api-key',
  };
}

/**
 * Fetch JWKS with caching to prevent DoS
 */
async function fetchJWKS(jwksUri: string): Promise<JWKSCache['keys']> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUri);

  // Return cached if still valid
  if (cached && (now - cached.fetchedAt) < JWKS_CACHE_TTL) {
    return cached.keys;
  }

  // Fetch fresh JWKS
  const response = await fetch(jwksUri, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000), // 10 second timeout
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }

  const jwks = await response.json() as { keys: JWKSCache['keys'] };

  // Cache the result
  jwksCache.set(jwksUri, {
    keys: jwks.keys,
    fetchedAt: now,
  });

  return jwks.keys;
}

/**
 * Validate OAuth token
 * Uses cached JWKS to prevent DoS attacks
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
    // Fetch JWKS with caching
    const keys = await fetchJWKS(oauthConfig.jwksUri);

    // Decode token header to get kid
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const header = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString()) as { kid?: string; alg?: string };
    const kid = header.kid;

    // Find matching key
    const key = keys.find((k) => k.kid === kid);
    if (!key) {
      // If key not found, try refreshing the cache once
      jwksCache.delete(oauthConfig.jwksUri);
      const refreshedKeys = await fetchJWKS(oauthConfig.jwksUri);
      const refreshedKey = refreshedKeys.find((k) => k.kid === kid);
      if (!refreshedKey) {
        throw new Error('No matching key found');
      }
      // Continue with refreshed key
      const publicKey = jwkToPem(refreshedKey);
      const decoded = jwt.verify(token, publicKey, {
        issuer: oauthConfig.issuer,
        audience: oauthConfig.audience,
      }) as jwt.JwtPayload;

      req.auth = {
        type: 'oauth',
        subject: decoded.sub,
        claims: decoded as Record<string, unknown>,
      };
      return;
    }

    // Convert JWK to PEM
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
 * Convert base64url to base64
 */
function base64urlToBase64(base64url: string): string {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if necessary
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return base64;
}

/**
 * Encode an integer as ASN.1 DER
 */
function encodeInteger(data: Buffer): Buffer {
  // Add leading zero if high bit is set (to avoid negative interpretation)
  if (data[0] & 0x80) {
    data = Buffer.concat([Buffer.from([0x00]), data]);
  }

  // Remove leading zeros (except one if needed for sign bit)
  let start = 0;
  while (start < data.length - 1 && data[start] === 0 && !(data[start + 1] & 0x80)) {
    start++;
  }
  data = data.slice(start);

  return Buffer.concat([
    Buffer.from([0x02]), // INTEGER tag
    encodeLength(data.length),
    data,
  ]);
}

/**
 * Encode length in ASN.1 DER format
 */
function encodeLength(len: number): Buffer {
  if (len < 128) {
    return Buffer.from([len]);
  }
  const bytes: number[] = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Convert RSA JWK (n, e) to PEM format
 */
function rsaJwkToPem(n: string, e: string): string {
  // Decode base64url values
  const nBuffer = Buffer.from(base64urlToBase64(n), 'base64');
  const eBuffer = Buffer.from(base64urlToBase64(e), 'base64');

  // Encode as ASN.1 integers
  const nEncoded = encodeInteger(nBuffer);
  const eEncoded = encodeInteger(eBuffer);

  // Create RSA public key sequence
  const rsaPublicKey = Buffer.concat([
    Buffer.from([0x30]), // SEQUENCE tag
    encodeLength(nEncoded.length + eEncoded.length),
    nEncoded,
    eEncoded,
  ]);

  // RSA OID: 1.2.840.113549.1.1.1
  const rsaOid = Buffer.from([
    0x30, 0x0d, // SEQUENCE, length 13
    0x06, 0x09, // OID, length 9
    0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // RSA OID
    0x05, 0x00, // NULL
  ]);

  // Create BIT STRING wrapper for the public key
  const bitString = Buffer.concat([
    Buffer.from([0x03]), // BIT STRING tag
    encodeLength(rsaPublicKey.length + 1),
    Buffer.from([0x00]), // Number of unused bits
    rsaPublicKey,
  ]);

  // Create the full SubjectPublicKeyInfo structure
  const spki = Buffer.concat([
    Buffer.from([0x30]), // SEQUENCE tag
    encodeLength(rsaOid.length + bitString.length),
    rsaOid,
    bitString,
  ]);

  // Convert to PEM
  const base64 = spki.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }

  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

/**
 * Convert JWK to PEM format
 * Supports both x5c (certificate) and n/e (RSA public key) formats
 */
function jwkToPem(jwk: { x5c?: string[]; n?: string; e?: string; kty?: string }): string {
  // If x5c is available, use it (certificate format)
  if (jwk.x5c && jwk.x5c.length > 0) {
    // Format the certificate with proper line breaks
    const cert = jwk.x5c[0];
    const lines: string[] = [];
    for (let i = 0; i < cert.length; i += 64) {
      lines.push(cert.slice(i, i + 64));
    }
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
  }

  // Otherwise, construct from n and e (RSA public key)
  if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
    return rsaJwkToPem(jwk.n, jwk.e);
  }

  // If kty not specified but n and e are present, assume RSA
  if (jwk.n && jwk.e) {
    return rsaJwkToPem(jwk.n, jwk.e);
  }

  throw new Error('Unsupported JWK format - requires x5c or RSA (n, e)');
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

