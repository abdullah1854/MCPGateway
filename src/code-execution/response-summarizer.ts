/**
 * Response Summarization - Layer 14
 *
 * Automatically summarizes large results to reduce token usage.
 * Uses heuristics to extract key insights from data.
 */

export interface SummarizeOptions {
  /** Maximum tokens for the summary (default: 500) */
  maxTokens?: number;
  /** Include sample data (default: true) */
  includeSample?: boolean;
  /** Sample size (default: 5) */
  sampleSize?: number;
  /** Include statistics (default: true) */
  includeStats?: boolean;
  /** Include field analysis (default: true) */
  includeFieldAnalysis?: boolean;
  /** Fields to focus on for analysis */
  focusFields?: string[];
}

export interface SummaryResult {
  /** Whether summarization was applied */
  wasSummarized: boolean;
  /** The summarized or original data */
  data: unknown;
  /** Summary metadata */
  summary?: {
    originalCount: number;
    originalTokens: number;
    summaryTokens: number;
    savedTokens: number;
    savedPercent: number;
    type: 'array' | 'object' | 'primitive';
    insights: string[];
  };
}

/**
 * Estimate tokens for content
 */
function estimateTokens(content: unknown): number {
  if (content === null || content === undefined) return 0;
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  return Math.ceil(str.length / 4);
}

/**
 * Get value distribution for a field
 */
function getValueDistribution(
  data: Record<string, unknown>[],
  field: string,
  maxValues = 10
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of data) {
    const value = item[field];
    if (value !== undefined && value !== null) {
      const key = String(value);
      counts[key] = (counts[key] || 0) + 1;
    }
  }

  // Sort by count and take top values
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxValues);

  return Object.fromEntries(sorted);
}

/**
 * Get numeric statistics for a field
 */
function getNumericStats(data: Record<string, unknown>[], field: string): {
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
} | null {
  const values = data
    .map(item => item[field])
    .filter((v): v is number => typeof v === 'number' && !isNaN(v));

  if (values.length === 0) return null;

  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round((sum / values.length) * 100) / 100,
    sum: Math.round(sum * 100) / 100,
    count: values.length,
  };
}

/**
 * Detect likely categorical fields (low cardinality)
 */
function detectCategoricalFields(
  data: Record<string, unknown>[],
  threshold = 0.1
): string[] {
  const categorical: string[] = [];
  const sampleSize = Math.min(data.length, 100);
  const sample = data.slice(0, sampleSize);

  const firstItem = sample[0];
  if (!firstItem) return [];

  for (const key of Object.keys(firstItem)) {
    const uniqueValues = new Set(sample.map(item => String(item[key])));
    const uniqueRatio = uniqueValues.size / sampleSize;

    if (uniqueRatio <= threshold && uniqueValues.size <= 20) {
      categorical.push(key);
    }
  }

  return categorical;
}

/**
 * Detect likely numeric fields
 */
function detectNumericFields(data: Record<string, unknown>[]): string[] {
  const numeric: string[] = [];
  const sample = data[0];
  if (!sample) return [];

  for (const [key, value] of Object.entries(sample)) {
    if (typeof value === 'number') {
      numeric.push(key);
    }
  }

  return numeric;
}

/**
 * Generate insights from data
 */
function generateInsights(
  data: Record<string, unknown>[],
  options: SummarizeOptions
): string[] {
  const insights: string[] = [];
  const focusFields = options.focusFields || [];

  // Count insight
  insights.push(`Total records: ${data.length}`);

  // Detect and analyze categorical fields
  const categoricalFields = detectCategoricalFields(data);
  for (const field of categoricalFields.slice(0, 3)) {
    if (focusFields.length > 0 && !focusFields.includes(field)) continue;

    const dist = getValueDistribution(data, field, 5);
    const entries = Object.entries(dist);
    if (entries.length > 0) {
      const summary = entries.map(([k, v]) => `${k}: ${v}`).join(', ');
      insights.push(`${field} distribution: ${summary}`);
    }
  }

  // Detect and analyze numeric fields
  const numericFields = detectNumericFields(data);
  for (const field of numericFields.slice(0, 3)) {
    if (focusFields.length > 0 && !focusFields.includes(field)) continue;

    const stats = getNumericStats(data, field);
    if (stats) {
      insights.push(`${field}: min=${stats.min}, max=${stats.max}, avg=${stats.avg}`);
    }
  }

  // Field coverage
  const firstItem = data[0];
  if (firstItem) {
    const fields = Object.keys(firstItem);
    const nullCounts: Record<string, number> = {};

    for (const item of data.slice(0, 100)) {
      for (const field of fields) {
        if (item[field] === null || item[field] === undefined) {
          nullCounts[field] = (nullCounts[field] || 0) + 1;
        }
      }
    }

    const sparseFields = Object.entries(nullCounts)
      .filter(([, count]) => count > 50)
      .map(([field]) => field);

    if (sparseFields.length > 0) {
      insights.push(`Sparse fields (>50% null): ${sparseFields.join(', ')}`);
    }
  }

  return insights;
}

/**
 * Summarize an array of objects
 */
function summarizeArray(
  data: Record<string, unknown>[],
  options: SummarizeOptions
): {
  count: number;
  fields: string[];
  sample?: unknown[];
  stats?: Record<string, unknown>;
  distribution?: Record<string, Record<string, number>>;
  insights: string[];
} {
  const {
    includeSample = true,
    sampleSize = 5,
    includeStats = true,
    includeFieldAnalysis = true,
  } = options;

  const firstItem = data[0];
  const fields = firstItem ? Object.keys(firstItem) : [];

  const result: ReturnType<typeof summarizeArray> = {
    count: data.length,
    fields,
    insights: generateInsights(data, options),
  };

  // Include sample
  if (includeSample && data.length > 0) {
    result.sample = data.slice(0, sampleSize);
  }

  // Include statistics for numeric fields
  if (includeStats) {
    const numericFields = detectNumericFields(data);
    if (numericFields.length > 0) {
      result.stats = {};
      for (const field of numericFields.slice(0, 5)) {
        const stats = getNumericStats(data, field);
        if (stats) {
          result.stats[field] = stats;
        }
      }
    }
  }

  // Include distribution for categorical fields
  if (includeFieldAnalysis) {
    const categoricalFields = detectCategoricalFields(data);
    if (categoricalFields.length > 0) {
      result.distribution = {};
      for (const field of categoricalFields.slice(0, 5)) {
        result.distribution[field] = getValueDistribution(data, field);
      }
    }
  }

  return result;
}

/**
 * Summarize an object
 */
function summarizeObject(
  data: Record<string, unknown>,
  options: SummarizeOptions
): {
  fieldCount: number;
  fields: string[];
  types: Record<string, string>;
  sample?: Record<string, unknown>;
  insights: string[];
} {
  const fields = Object.keys(data);
  const types: Record<string, string> = {};

  for (const [key, value] of Object.entries(data)) {
    types[key] = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  }

  const insights: string[] = [
    `Object with ${fields.length} fields`,
  ];

  // Analyze nested arrays
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      insights.push(`${key}: array with ${value.length} items`);
    }
  }

  const result: ReturnType<typeof summarizeObject> = {
    fieldCount: fields.length,
    fields,
    types,
    insights,
  };

  // Include sample of scalar values
  if (options.includeSample !== false) {
    const sample: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!Array.isArray(value) && typeof value !== 'object') {
        sample[key] = value;
      } else if (Array.isArray(value)) {
        sample[key] = `[Array: ${value.length} items]`;
      } else if (value && typeof value === 'object') {
        sample[key] = `[Object: ${Object.keys(value).length} fields]`;
      }
    }
    result.sample = sample;
  }

  return result;
}

/**
 * Main summarization function
 */
export function summarizeResponse(
  data: unknown,
  options: SummarizeOptions = {}
): SummaryResult {
  const { maxTokens = 500 } = options;

  // Check if summarization is needed
  const originalTokens = estimateTokens(data);

  if (originalTokens <= maxTokens) {
    return {
      wasSummarized: false,
      data,
    };
  }

  let summarized: unknown;
  let type: 'array' | 'object' | 'primitive';
  let insights: string[] = [];

  if (Array.isArray(data)) {
    type = 'array';
    if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
      const summary = summarizeArray(data as Record<string, unknown>[], options);
      summarized = summary;
      insights = summary.insights;
    } else {
      // Array of primitives
      summarized = {
        count: data.length,
        sample: data.slice(0, options.sampleSize || 5),
        insights: [`Array of ${data.length} items`],
      };
      insights = [`Array of ${data.length} items`];
    }
  } else if (data && typeof data === 'object') {
    type = 'object';
    const summary = summarizeObject(data as Record<string, unknown>, options);
    summarized = summary;
    insights = summary.insights;
  } else {
    // Primitive - can't summarize much
    type = 'primitive';
    summarized = data;
    insights = ['Primitive value'];
  }

  const summaryTokens = estimateTokens(summarized);
  const savedTokens = originalTokens - summaryTokens;
  const savedPercent = Math.round((savedTokens / originalTokens) * 100);

  return {
    wasSummarized: true,
    data: summarized,
    summary: {
      originalCount: Array.isArray(data) ? data.length : 1,
      originalTokens,
      summaryTokens,
      savedTokens,
      savedPercent,
      type,
      insights,
    },
  };
}

/**
 * Auto-summarize if response exceeds threshold
 */
export function autoSummarize(
  data: unknown,
  tokenThreshold = 1000,
  options: SummarizeOptions = {}
): SummaryResult {
  const tokens = estimateTokens(data);

  if (tokens <= tokenThreshold) {
    return {
      wasSummarized: false,
      data,
    };
  }

  return summarizeResponse(data, {
    ...options,
    maxTokens: Math.min(options.maxTokens || 500, tokenThreshold),
  });
}

/**
 * Create a text summary of the data (for human-readable output)
 */
export function createTextSummary(data: unknown, maxLength = 500): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return 'Empty array';

    const firstItem = data[0];
    if (typeof firstItem === 'object' && firstItem !== null) {
      const fields = Object.keys(firstItem);
      const categoricalFields = detectCategoricalFields(data as Record<string, unknown>[]);
      const numericFields = detectNumericFields(data as Record<string, unknown>[]);

      let summary = `${data.length} records with fields: ${fields.slice(0, 5).join(', ')}${fields.length > 5 ? '...' : ''}. `;

      if (categoricalFields.length > 0) {
        const dist = getValueDistribution(data as Record<string, unknown>[], categoricalFields[0], 3);
        const distStr = Object.entries(dist).map(([k, v]) => `${k}(${v})`).join(', ');
        summary += `${categoricalFields[0]} distribution: ${distStr}. `;
      }

      if (numericFields.length > 0) {
        const stats = getNumericStats(data as Record<string, unknown>[], numericFields[0]);
        if (stats) {
          summary += `${numericFields[0]} range: ${stats.min}-${stats.max}, avg: ${stats.avg}. `;
        }
      }

      return summary.slice(0, maxLength);
    }

    return `Array of ${data.length} items: ${JSON.stringify(data.slice(0, 3)).slice(0, maxLength - 30)}...`;
  }

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const fields = Object.keys(obj);
    return `Object with ${fields.length} fields: ${fields.slice(0, 5).join(', ')}${fields.length > 5 ? '...' : ''}`;
  }

  return String(data).slice(0, maxLength);
}
