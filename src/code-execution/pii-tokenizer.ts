/**
 * PII Tokenization Layer
 *
 * Detects and tokenizes Personally Identifiable Information (PII) to prevent
 * sensitive data from entering model context while still allowing data to
 * flow between tools.
 */

import { logger } from '../logger.js';

export interface PIIToken {
  token: string;
  type: PIIType;
  originalValue: string;
}

export type PIIType = 'EMAIL' | 'PHONE' | 'SSN' | 'CREDIT_CARD' | 'IP_ADDRESS' | 'NAME' | 'ADDRESS';

export interface TokenizationResult {
  text: string;
  tokens: PIIToken[];
  piiDetected: boolean;
}

// PII detection patterns
const PII_PATTERNS: Record<PIIType, RegExp> = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  PHONE: /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
  SSN: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  CREDIT_CARD: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  IP_ADDRESS: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  NAME: /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, // Simple name pattern
  ADDRESS: /\b\d+\s+[A-Za-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)\b/gi,
};

/**
 * PII Tokenizer - Replaces sensitive data with tokens
 */
export class PIITokenizer {
  private tokenMap = new Map<string, PIIToken>();
  private reverseMap = new Map<string, string>();
  private counters: Record<PIIType, number> = {
    EMAIL: 0,
    PHONE: 0,
    SSN: 0,
    CREDIT_CARD: 0,
    IP_ADDRESS: 0,
    NAME: 0,
    ADDRESS: 0,
  };

  /**
   * Enable/disable specific PII types
   */
  private enabledTypes: Set<PIIType> = new Set([
    'EMAIL',
    'PHONE',
    'SSN',
    'CREDIT_CARD',
    'IP_ADDRESS',
  ]);

  constructor(options?: { enabledTypes?: PIIType[] }) {
    if (options?.enabledTypes) {
      this.enabledTypes = new Set(options.enabledTypes);
    }
  }

  /**
   * Tokenize PII in text
   */
  tokenize(text: string): TokenizationResult {
    const tokens: PIIToken[] = [];
    let tokenizedText = text;

    for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
      if (!this.enabledTypes.has(type as PIIType)) continue;

      // Reset pattern lastIndex
      pattern.lastIndex = 0;

      const matches = tokenizedText.matchAll(new RegExp(pattern.source, pattern.flags));

      for (const match of matches) {
        const originalValue = match[0];

        // Check if already tokenized
        if (this.reverseMap.has(originalValue)) {
          const existingToken = this.reverseMap.get(originalValue)!;
          tokenizedText = tokenizedText.replace(originalValue, existingToken);
          continue;
        }

        // Create new token
        this.counters[type as PIIType]++;
        const token = `[${type}_${this.counters[type as PIIType]}]`;

        const piiToken: PIIToken = {
          token,
          type: type as PIIType,
          originalValue,
        };

        this.tokenMap.set(token, piiToken);
        this.reverseMap.set(originalValue, token);
        tokens.push(piiToken);

        tokenizedText = tokenizedText.replace(originalValue, token);
      }
    }

    return {
      text: tokenizedText,
      tokens,
      piiDetected: tokens.length > 0,
    };
  }

  /**
   * Tokenize PII in an object recursively
   */
  tokenizeObject<T>(obj: T): { result: T; tokens: PIIToken[] } {
    const allTokens: PIIToken[] = [];

    const processValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const { text, tokens } = this.tokenize(value);
        allTokens.push(...tokens);
        return text;
      }

      if (Array.isArray(value)) {
        return value.map(processValue);
      }

      if (value !== null && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          result[key] = processValue(val);
        }
        return result;
      }

      return value;
    };

    return {
      result: processValue(obj) as T,
      tokens: allTokens,
    };
  }

  /**
   * Detokenize - Replace tokens back with original values
   */
  detokenize(text: string): string {
    let result = text;

    for (const [token, piiToken] of this.tokenMap) {
      result = result.replace(new RegExp(this.escapeRegex(token), 'g'), piiToken.originalValue);
    }

    return result;
  }

  /**
   * Detokenize an object recursively
   */
  detokenizeObject<T>(obj: T): T {
    const processValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return this.detokenize(value);
      }

      if (Array.isArray(value)) {
        return value.map(processValue);
      }

      if (value !== null && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          result[key] = processValue(val);
        }
        return result;
      }

      return value;
    };

    return processValue(obj) as T;
  }

  /**
   * Check if text contains any PII
   */
  detectPII(text: string): { hasPII: boolean; types: PIIType[] } {
    const detectedTypes: PIIType[] = [];

    for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
      if (!this.enabledTypes.has(type as PIIType)) continue;

      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        detectedTypes.push(type as PIIType);
      }
    }

    return {
      hasPII: detectedTypes.length > 0,
      types: detectedTypes,
    };
  }

  /**
   * Get all stored tokens
   */
  getTokens(): PIIToken[] {
    return Array.from(this.tokenMap.values());
  }

  /**
   * Clear all tokens (for new session)
   */
  clear(): void {
    this.tokenMap.clear();
    this.reverseMap.clear();
    this.counters = {
      EMAIL: 0,
      PHONE: 0,
      SSN: 0,
      CREDIT_CARD: 0,
      IP_ADDRESS: 0,
      NAME: 0,
      ADDRESS: 0,
    };
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * Data flow rules - Define which tools can receive which data types
 */
export interface DataFlowRule {
  sourceTools: string[];
  targetTools: string[];
  allowedDataTypes: PIIType[];
  blockPII: boolean;
}

export class DataFlowManager {
  private rules: DataFlowRule[] = [];
  private tokenizer: PIITokenizer;

  constructor(tokenizer: PIITokenizer) {
    this.tokenizer = tokenizer;
  }

  /**
   * Add a data flow rule
   */
  addRule(rule: DataFlowRule): void {
    this.rules.push(rule);
    logger.info('Data flow rule added', { rule });
  }

  /**
   * Check if data can flow from source to target tool
   */
  canFlow(sourceTool: string, targetTool: string, data: unknown): boolean {
    const rule = this.rules.find(
      r =>
        (r.sourceTools.includes(sourceTool) || r.sourceTools.includes('*')) &&
        (r.targetTools.includes(targetTool) || r.targetTools.includes('*'))
    );

    if (!rule) {
      return true; // No rule = allow by default
    }

    if (rule.blockPII) {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      const { hasPII } = this.tokenizer.detectPII(text);
      if (hasPII) {
        logger.warn('Data flow blocked due to PII', { sourceTool, targetTool });
        return false;
      }
    }

    return true;
  }

  /**
   * Process data for tool-to-tool transfer
   */
  processDataFlow(sourceTool: string, targetTool: string, data: unknown): unknown {
    const rule = this.rules.find(
      r =>
        (r.sourceTools.includes(sourceTool) || r.sourceTools.includes('*')) &&
        (r.targetTools.includes(targetTool) || r.targetTools.includes('*'))
    );

    if (rule?.blockPII) {
      // Tokenize PII before passing to target
      const { result } = this.tokenizer.tokenizeObject(data);
      return result;
    }

    return data;
  }
}

const _piiSessionTokenizers = new Map<string, PIITokenizer>();
const _piiEnabled = (process.env.PII_TOKENIZATION_ENABLED ?? '1') !== '0';
const _piiEnabledTypes = (() => {
  const raw = (process.env.PII_TOKENIZATION_TYPES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return raw.length > 0 ? (raw as PIIType[]) : undefined;
})();

export function getPIITokenizerForSession(sessionId: string | undefined): PIITokenizer | null {
  if (!_piiEnabled) return null;
  if (!sessionId) return null;

  const existing = _piiSessionTokenizers.get(sessionId);
  if (existing) return existing;

  const tokenizer = new PIITokenizer({ enabledTypes: _piiEnabledTypes });
  _piiSessionTokenizers.set(sessionId, tokenizer);
  return tokenizer;
}

export function clearPIITokenizerForSession(sessionId: string): void {
  _piiSessionTokenizers.delete(sessionId);
}
