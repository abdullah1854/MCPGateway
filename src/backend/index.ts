/**
 * Backend MCP Server Connection Manager
 *
 * Manages connections to multiple backend MCP servers and aggregates their capabilities.
 */

export { BackendManager } from './manager.js';
export { StdioBackend } from './stdio.js';
export { HttpBackend } from './http.js';
export { SSEBackend } from './sse.js';
export type { Backend } from './base.js';

