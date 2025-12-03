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
