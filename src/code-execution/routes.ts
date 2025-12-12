/**
 * Code Execution API Routes
 *
 * Provides REST endpoints for:
 * - Tool discovery and search
 * - Code execution
 * - SDK generation
 * - Streaming & aggregation
 * - Skills management
 * - Workspace state
 */

import { Router, Request, Response } from 'express';
import { BackendManager } from '../backend/index.js';
import { ToolDiscovery, DetailLevel } from './tool-discovery.js';
import { CodeExecutor } from './executor.js';
import { Aggregations } from './streaming.js';
import { WorkspaceManager } from './workspace.js';
import { SkillsManager } from './skills.js';
import { ResultCache } from './cache.js';
import { z } from 'zod';

// Request validation schemas
const SearchToolsSchema = z.object({
  query: z.string().optional(),
  backend: z.string().optional(),
  prefix: z.string().optional(),
  detailLevel: z.enum(['name_only', 'name_description', 'full_schema']).optional(),
  limit: z.number().min(1).max(200).optional(),
  offset: z.number().min(0).optional(),
});

const ExecuteCodeSchema = z.object({
  code: z.string().min(1).max(50000), // Max 50KB of code
  timeout: z.number().min(1000).max(120000).optional(), // 1s to 2min
  context: z.record(z.unknown()).optional(),
});

const ResultFilterSchema = z.object({
  maxRows: z.number().min(1).max(10000).optional(),
  fields: z.array(z.string()).optional(),
  format: z.enum(['full', 'summary', 'sample']).optional(),
});

const AggregationSchema = z.object({
  operation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'groupBy', 'distinct']),
  field: z.string().optional(),
  groupByField: z.string().optional(),
});

const SkillSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  version: z.string().default('1.0.0'),
  author: z.string().optional(),
  tags: z.array(z.string()).default([]),
  inputs: z.array(z.object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    description: z.string().optional(),
    required: z.boolean().default(true),
    default: z.unknown().optional(),
  })).default([]),
  code: z.string().min(1).max(100000),
});

export function createCodeExecutionRoutes(backendManager: BackendManager): Router {
  const router = Router();
  const toolDiscovery = new ToolDiscovery(backendManager);
  const codeExecutor = new CodeExecutor(backendManager);
  const workspaceManager = new WorkspaceManager();
  const skillsManager = new SkillsManager(workspaceManager, codeExecutor);
  const resultCache = new ResultCache({ maxSize: 500, defaultTTL: 300000 });

  /**
   * GET /tools/search
   * Search and filter tools with progressive disclosure
   */
  router.get('/tools/search', (req: Request, res: Response) => {
    try {
      const query = {
        query: req.query.query as string | undefined,
        backend: req.query.backend as string | undefined,
        prefix: req.query.prefix as string | undefined,
        detailLevel: req.query.detailLevel as DetailLevel | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
      };

      const parseResult = SearchToolsSchema.safeParse(query);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid search parameters',
          details: parseResult.error.errors,
        });
        return;
      }

      const result = toolDiscovery.searchTools(parseResult.data);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: 'Search failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /tools/search
   * Search tools with body parameters (for complex queries)
   */
  router.post('/tools/search', (req: Request, res: Response) => {
    try {
      const parseResult = SearchToolsSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid search parameters',
          details: parseResult.error.errors,
        });
        return;
      }

      const result = toolDiscovery.searchTools(parseResult.data);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: 'Search failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /tools/tree
   * Get tools organized as a filesystem-like tree
   */
  router.get('/tools/tree', (_req: Request, res: Response) => {
    try {
      const tree = toolDiscovery.getToolTree();
      res.json({ tree });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get tool tree',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /tools/names
   * Get all tool names (minimal response for token efficiency)
   */
  router.get('/tools/names', (_req: Request, res: Response) => {
    try {
      const names = toolDiscovery.getAllToolNames();
      res.json({ names, count: names.length });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get tool names',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /tools/stats
   * Get tool statistics by backend
   */
  router.get('/tools/stats', (_req: Request, res: Response) => {
    try {
      const stats = toolDiscovery.getToolStats();
      res.json({ stats });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get tool stats',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /tools/:name/schema
   * Get full schema for a specific tool (lazy loading)
   */
  router.get('/tools/:name/schema', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const schema = toolDiscovery.getToolSchema(name);

      if (!schema) {
        res.status(404).json({ error: `Tool '${name}' not found` });
        return;
      }

      res.json({ tool: schema });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get tool schema',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /tools/backend/:backendId
   * Get all tools for a specific backend
   */
  router.get('/tools/backend/:backendId', (req: Request, res: Response) => {
    try {
      const { backendId } = req.params;
      const tools = toolDiscovery.getToolsByBackend(backendId);
      res.json({ tools, count: tools.length });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get backend tools',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /sdk
   * Generate TypeScript SDK for all available tools
   */
  router.get('/sdk', (_req: Request, res: Response) => {
    try {
      const sdk = codeExecutor.generateSDK();
      res.type('text/plain').send(sdk);
    } catch (error) {
      res.status(500).json({
        error: 'Failed to generate SDK',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /execute
   * Execute code in sandboxed environment with MCP tool access
   */
  router.post('/execute', async (req: Request, res: Response) => {
    try {
      const parseResult = ExecuteCodeSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid execution request',
          details: parseResult.error.errors,
        });
        return;
      }

      const { code, timeout, context } = parseResult.data;

      const result = await codeExecutor.execute(code, {
        timeout,
        context,
        captureConsole: true,
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Execution failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /tools/:name/call
   * Call a tool with optional result filtering
   */
  router.post('/tools/:name/call', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { args = {}, filter, smart } = req.body as {
        args?: unknown;
        filter?: unknown;
        smart?: unknown;
      };

      if (smart !== undefined && typeof smart !== 'boolean') {
        res.status(400).json({ error: 'smart must be a boolean' });
        return;
      }

      // Validate filter if provided
      if (filter) {
        const filterResult = ResultFilterSchema.safeParse(filter);
        if (!filterResult.success) {
          res.status(400).json({
            error: 'Invalid filter options',
            details: filterResult.error.errors,
          });
          return;
        }
      }

      // Call the tool
      const response = await backendManager.callTool(name, args);

      if (response.error) {
        res.status(400).json({
          success: false,
          error: response.error.message,
        });
        return;
      }

      // Apply filtering if requested
      let result = response.result;
      const effectiveFilter =
        (filter as z.infer<typeof ResultFilterSchema> | undefined) ??
        ((smart as boolean | undefined) !== false ? { maxRows: 20, format: 'summary' } : undefined);
      if (effectiveFilter) {
        result = applyResultFilter(result, effectiveFilter);
      }

      res.json({
        success: true,
        result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Tool call failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /tools/:name/call/aggregate
   * Call a tool and apply aggregation to results
   */
  router.post('/tools/:name/call/aggregate', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { args = {}, aggregation } = req.body;

      // Validate aggregation
      const aggResult = AggregationSchema.safeParse(aggregation);
      if (!aggResult.success) {
        res.status(400).json({
          error: 'Invalid aggregation options',
          details: aggResult.error.errors,
        });
        return;
      }

      // Call the tool
      const response = await backendManager.callTool(name, args);

      if (response.error) {
        res.status(400).json({
          success: false,
          error: response.error.message,
        });
        return;
      }

      // Apply aggregation
      const data = response.result as Record<string, unknown>[];
      const { operation, field, groupByField } = aggResult.data;
      let aggregated: unknown;

      switch (operation) {
        case 'count':
          aggregated = Aggregations.count(data);
          break;
        case 'sum':
          aggregated = field ? Aggregations.sum(data, field) : 0;
          break;
        case 'avg':
          aggregated = field ? Aggregations.avg(data, field) : 0;
          break;
        case 'min':
          aggregated = field ? Aggregations.min(data, field) : null;
          break;
        case 'max':
          aggregated = field ? Aggregations.max(data, field) : null;
          break;
        case 'groupBy':
          aggregated = groupByField ? Aggregations.groupBy(data, groupByField) : {};
          break;
        case 'distinct':
          aggregated = field ? Aggregations.distinct(data, field) : [];
          break;
        default:
          aggregated = data;
      }

      res.json({
        success: true,
        result: aggregated,
        operation,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Aggregation failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /tools/parallel
   * Execute multiple tools in parallel
   */
  router.post('/tools/parallel', async (req: Request, res: Response) => {
    try {
      const { calls } = req.body as {
        calls: Array<{ toolName: string; args: unknown }>;
      };

      if (!calls || !Array.isArray(calls)) {
        res.status(400).json({ error: 'calls array required' });
        return;
      }

      const results = await backendManager.callToolsParallel(calls);

      res.json({
        success: true,
        results: results.map((r, i) => ({
          toolName: calls[i].toolName,
          result: r.result,
          error: r.error?.message,
        })),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Parallel execution failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==================== Skills API ====================

  /**
   * GET /skills
   * List all available skills
   */
  router.get('/skills', (_req: Request, res: Response) => {
    try {
      const skills = skillsManager.listSkills();
      res.json({ skills, count: skills.length });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to list skills',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /skills/search
   * Search skills by name, description, or tags
   */
  router.get('/skills/search', (req: Request, res: Response) => {
    try {
      const query = req.query.q as string || '';
      const skills = skillsManager.searchSkills(query);
      res.json({ skills, count: skills.length });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to search skills',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /skills/:name
   * Get a specific skill
   */
  router.get('/skills/:name', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const skill = skillsManager.getSkill(name);

      if (!skill) {
        res.status(404).json({ error: `Skill '${name}' not found` });
        return;
      }

      res.json({ skill });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get skill',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills
   * Create a new skill
   */
  router.post('/skills', (req: Request, res: Response) => {
    try {
      const parseResult = SkillSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid skill data',
          details: parseResult.error.errors,
        });
        return;
      }

      const skill = skillsManager.createSkill(parseResult.data);
      res.status(201).json({ success: true, skill });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to create skill',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills/:name/execute
   * Execute a skill with inputs
   */
  router.post('/skills/:name/execute', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { inputs = {} } = req.body;

      const result = await skillsManager.executeSkill(name, inputs);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Skill execution failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * DELETE /skills/:name
   * Delete a skill
   */
  router.delete('/skills/:name', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const deleted = skillsManager.deleteSkill(name);

      if (!deleted) {
        res.status(404).json({ error: `Skill '${name}' not found` });
        return;
      }

      res.json({ success: true, deleted: name });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to delete skill',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==================== Workspace/Session API ====================

  /**
   * GET /workspace/session
   * Get current session state
   */
  router.get('/workspace/session', (req: Request, res: Response) => {
    try {
      const sessionId = (req.headers['x-session-id'] as string) || 'default';
      const session = workspaceManager.loadSessionState(sessionId);
      res.json({ session });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get session',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /workspace/session
   * Update session state
   */
  router.post('/workspace/session', (req: Request, res: Response) => {
    try {
      const sessionId = (req.headers['x-session-id'] as string) || 'default';
      const updates = req.body;

      const session = workspaceManager.updateSessionState(sessionId, updates);

      res.json({ success: true, session });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to update session',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==================== Cache API ====================

  /**
   * GET /cache/stats
   * Get cache statistics
   */
  router.get('/cache/stats', (_req: Request, res: Response) => {
    res.json(resultCache.getStats());
  });

  /**
   * POST /cache/clear
   * Clear the result cache
   */
  router.post('/cache/clear', (_req: Request, res: Response) => {
    resultCache.clear();
    res.json({ success: true, message: 'Cache cleared' });
  });

  return router;
}

/**
 * Apply filtering to tool results for context efficiency
 */
function applyResultFilter(
  result: unknown,
  filter: { maxRows?: number; fields?: string[]; format?: string }
): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const { maxRows, fields, format } = filter;

  // Handle array results (e.g., database rows)
  if (Array.isArray(result)) {
    let filtered = result;

    // Limit rows
    if (maxRows && filtered.length > maxRows) {
      filtered = filtered.slice(0, maxRows);
    }

    // Select specific fields
    if (fields && fields.length > 0) {
      filtered = filtered.map(row => {
        if (typeof row !== 'object' || row === null) return row;
        const selected: Record<string, unknown> = {};
        for (const field of fields) {
          if (field in (row as Record<string, unknown>)) {
            selected[field] = (row as Record<string, unknown>)[field];
          }
        }
        return selected;
      });
    }

    // Apply format
    if (format === 'summary') {
      return {
        count: result.length,
        sample: filtered.slice(0, 3),
        truncated: result.length > (maxRows || result.length),
      };
    } else if (format === 'sample') {
      return filtered.slice(0, 5);
    }

    return filtered;
  }

  // Handle object results with content array (common MCP pattern)
  const objResult = result as Record<string, unknown>;
  if (objResult.content && Array.isArray(objResult.content)) {
    return {
      ...objResult,
      content: applyResultFilter(objResult.content, filter),
    };
  }

  return result;
}
