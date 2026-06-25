import { createHash } from 'crypto';

export function toCanonicalValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(item => toCanonicalValue(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const nested = toCanonicalValue((value as Record<string, unknown>)[key]);
      if (nested !== undefined) {
        result[key] = nested;
      }
    }
    return result;
  }
  return value;
}

export function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function stableCanonicalHash(value: unknown, length = 16): string {
  return createHash('sha256').update(stableCanonicalJson(value)).digest('hex').slice(0, length);
}

export function byteLengthOfCanonicalJson(value: unknown): number {
  return Buffer.byteLength(stableCanonicalJson(value), 'utf8');
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}
