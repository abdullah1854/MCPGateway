/**
 * Code Execution Module for MCP Gateway
 *
 * Inspired by Anthropic's Code Execution with MCP blog post.
 * Provides:
 * 1. Progressive Tool Disclosure - search and filter tools
 * 2. Code Execution Mode - run TypeScript/JavaScript code with MCP tool access
 * 3. Context-Efficient Results - filter and transform tool results
 * 4. Streaming & Aggregation - handle large results efficiently
 * 5. PII Tokenization - privacy-preserving data operations
 * 6. State Persistence & Skills - save and reuse code patterns
 * 7. Result Caching - reduce redundant tool calls
 * 8. Response Optimization - strip default/empty values
 * 9. Session Context - avoid resending data in context
 * 10. Schema Deduplication - reference identical schemas by hash
 */

export { ToolDiscovery, type ToolSearchOptions, type ToolSearchResult } from './tool-discovery.js';
export { CodeExecutor, type ExecutionResult, type ExecutionOptions } from './executor.js';
export { createCodeExecutionRoutes } from './routes.js';

// Streaming & Aggregation
export { streamResults, streamGenerator, Aggregations, type StreamOptions } from './streaming.js';

// PII Tokenization
export { PIITokenizer, DataFlowManager, type PIIType } from './pii-tokenizer.js';

// Workspace & State Persistence
export { WorkspaceManager, type SessionState } from './workspace.js';

// Skills System
export { SkillsManager, type Skill, type SkillInput, type SkillExecutionResult } from './skills.js';

// Result Caching
export { ResultCache, withCache, type CacheEntry, type CacheStats } from './cache.js';

// Response Optimization (Layer 8)
export {
  optimizeResponse,
  optimizeApiResponse,
  optimizeToolSchema,
  calculateSavings,
  optimizeWithStats,
  type OptimizeOptions,
} from './response-optimizer.js';

// Session Context Cache (Layer 9)
export {
  SessionContext,
  getSessionContext,
  sessionContextManager,
  type SessionContextStats,
} from './session-context.js';

// Schema Deduplication (Layer 10)
export {
  SchemaDeduplicator,
  globalSchemaDeduplicator,
  createCompactToolList,
  type SchemaRegistry,
  type DedupStats,
} from './schema-dedup.js';
