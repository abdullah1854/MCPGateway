/**
 * Response Optimizer - Default Value Omission
 *
 * Reduces token usage by stripping default/empty values from responses.
 * This can save 20-40% tokens on typical API responses.
 *
 * Strips: null, undefined, empty strings, empty arrays, empty objects,
 * false booleans (optional), zero numbers (optional)
 */

export interface OptimizeOptions {
  /** Remove null values (default: true) */
  stripNull?: boolean;
  /** Remove undefined values (default: true) */
  stripUndefined?: boolean;
  /** Remove empty strings "" (default: true) */
  stripEmptyString?: boolean;
  /** Remove empty arrays [] (default: true) */
  stripEmptyArray?: boolean;
  /** Remove empty objects {} (default: true) */
  stripEmptyObject?: boolean;
  /** Remove false boolean values (default: false) */
  stripFalse?: boolean;
  /** Remove zero numbers (default: false) */
  stripZero?: boolean;
  /** Maximum depth to recurse (default: 20) */
  maxDepth?: number;
  /** Fields to always preserve even if empty */
  preserveFields?: Set<string>;
}

const DEFAULT_OPTIONS: Required<OptimizeOptions> = {
  stripNull: true,
  stripUndefined: true,
  stripEmptyString: true,
  stripEmptyArray: true,
  stripEmptyObject: true,
  stripFalse: false,
  stripZero: false,
  maxDepth: 20,
  preserveFields: new Set(),
};

/**
 * Check if a value should be stripped based on options
 */
function shouldStrip(value: unknown, options: Required<OptimizeOptions>): boolean {
  if (value === null && options.stripNull) return true;
  if (value === undefined && options.stripUndefined) return true;
  if (value === '' && options.stripEmptyString) return true;
  if (value === false && options.stripFalse) return true;
  if (value === 0 && options.stripZero) return true;
  if (Array.isArray(value) && value.length === 0 && options.stripEmptyArray) return true;
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0 &&
    options.stripEmptyObject
  ) {
    return true;
  }
  return false;
}

/**
 * Recursively optimize an object by removing default/empty values
 */
export function optimizeResponse<T>(data: T, options: OptimizeOptions = {}): T {
  const opts: Required<OptimizeOptions> = { ...DEFAULT_OPTIONS, ...options };
  return optimizeRecursive(data, opts, 0) as T;
}

function optimizeRecursive(
  data: unknown,
  options: Required<OptimizeOptions>,
  depth: number
): unknown {
  // Prevent infinite recursion
  if (depth > options.maxDepth) {
    return data;
  }

  // Handle primitives
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    const optimized = data
      .map(item => optimizeRecursive(item, options, depth + 1))
      .filter(item => !shouldStrip(item, options));
    return optimized;
  }

  // Handle objects
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    // Always preserve specified fields
    if (options.preserveFields.has(key)) {
      result[key] = optimizeRecursive(value, options, depth + 1);
      continue;
    }

    const optimizedValue = optimizeRecursive(value, options, depth + 1);
    if (!shouldStrip(optimizedValue, options)) {
      result[key] = optimizedValue;
    }
  }

  return result;
}

/**
 * Calculate token savings from optimization
 */
export function calculateSavings(original: unknown, optimized: unknown): {
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  savingsPercent: number;
} {
  const originalStr = JSON.stringify(original);
  const optimizedStr = JSON.stringify(optimized);
  const originalTokens = Math.ceil(originalStr.length / 4);
  const optimizedTokens = Math.ceil(optimizedStr.length / 4);
  const savedTokens = originalTokens - optimizedTokens;
  const savingsPercent = originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;

  return {
    originalTokens,
    optimizedTokens,
    savedTokens,
    savingsPercent: Math.round(savingsPercent * 10) / 10,
  };
}

/**
 * Optimize and return with metadata about savings
 */
export function optimizeWithStats<T>(
  data: T,
  options: OptimizeOptions = {}
): { data: T; stats: ReturnType<typeof calculateSavings> } {
  const optimized = optimizeResponse(data, options);
  const stats = calculateSavings(data, optimized);
  return { data: optimized, stats };
}

/**
 * Pre-configured optimizer for API responses (aggressive)
 */
export function optimizeApiResponse<T>(data: T): T {
  return optimizeResponse(data, {
    stripNull: true,
    stripUndefined: true,
    stripEmptyString: true,
    stripEmptyArray: true,
    stripEmptyObject: true,
    stripFalse: false,
    stripZero: false,
  });
}

/**
 * Pre-configured optimizer for tool schemas (conservative)
 */
export function optimizeToolSchema<T>(data: T): T {
  return optimizeResponse(data, {
    stripNull: true,
    stripUndefined: true,
    stripEmptyString: true,
    stripEmptyArray: true,
    stripEmptyObject: true,
    stripFalse: false,
    stripZero: false,
    preserveFields: new Set(['required', 'type', 'properties']),
  });
}
