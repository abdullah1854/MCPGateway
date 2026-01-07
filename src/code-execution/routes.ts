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
import { SkillsManager, isValidSkillName, SKILL_CATEGORIES, SkillCategory } from './skills.js';
import { ResultCache } from './cache.js';
import { getPIITokenizerForSession } from './pii-tokenizer.js';
import { z } from 'zod';

const requireAllowlist = process.env.CODE_EXECUTION_REQUIRE_ALLOWLIST === '1';
const allowedTools = (process.env.CODE_EXECUTION_ALLOWED_TOOLS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const allowedPrefixes = (process.env.CODE_EXECUTION_ALLOWED_TOOL_PREFIXES ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const enforceToolAllowlist = requireAllowlist || allowedTools.length > 0 || allowedPrefixes.length > 0;
const allowedToolNames = new Set(allowedTools);

function isProgrammaticToolAllowed(toolName: string): boolean {
  if (!enforceToolAllowlist) return true;
  if (allowedToolNames.has(toolName)) return true;
  return allowedPrefixes.some(p => toolName.startsWith(p));
}

function getSessionId(req: Request): string | undefined {
  return (req.headers['mcp-session-id'] as string) || (req.headers['x-session-id'] as string);
}

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

// MCP Dependency schema for skill tool requirements
const MCPDependencySchema = z.object({
  toolPattern: z.string().min(1).describe('Tool name or pattern (e.g., "mssql_*", "github_*")'),
  description: z.string().optional(),
  required: z.boolean().default(true),
});

// Workflow step schema for multi-step skills
const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  toolsUsed: z.array(z.string()).optional(),
  condition: z.string().optional().describe('Optional condition for execution'),
});

// Example schema for skill usage examples
const SkillExampleSchema = z.object({
  input: z.record(z.unknown()),
  description: z.string().min(1),
});

// Skill categories matching SKILL_CATEGORIES in skills.ts
const SkillCategoryEnum = z.enum([
  'code-quality',
  'git-workflow',
  'database',
  'api',
  'documentation',
  'testing',
  'devops',
  'productivity',
  'analysis',
  'domain-specific',
  'memory',
  'browser',
]);

const SkillSchema = z.object({
  // Core fields (required)
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  description: z.string().min(1).max(500),
  code: z.string().min(1).max(100000),

  // Basic metadata (optional with defaults)
  version: z.string().default('1.0.0'),
  author: z.string().optional(),
  tags: z.array(z.string()).default([]),
  category: SkillCategoryEnum.optional(),

  // Inputs definition
  inputs: z.array(z.object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    description: z.string().optional(),
    required: z.boolean().default(true),
    default: z.unknown().optional(),
  })).default([]),

  // Enhanced metadata for Claude-style skills
  mcpDependencies: z.array(MCPDependencySchema).optional()
    .describe('MCP tools this skill depends on'),
  workflow: z.array(WorkflowStepSchema).optional()
    .describe('Multi-step workflow definition'),
  chainOfThought: z.string().optional()
    .describe('Thinking process guidance for the skill'),
  antiHallucination: z.array(z.string()).optional()
    .describe('Rules to prevent hallucination'),
  verificationChecklist: z.array(z.string()).optional()
    .describe('Verification steps after execution'),
  examples: z.array(SkillExampleSchema).optional()
    .describe('Usage examples with input/description'),
});

// Schema for partial updates (all fields optional except identifying ones)
const SkillUpdateSchema = SkillSchema.partial().omit({ name: true });

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
   * Get tool names (minimal response for token efficiency)
   */
  router.get('/tools/names', (req: Request, res: Response) => {
    try {
      const backend = req.query.backend as string | undefined;
      const prefix = req.query.prefix as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;
      const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;

      const result = toolDiscovery.searchTools({
        backend,
        prefix,
        detailLevel: 'name_only',
        limit: safeLimit,
        offset: safeOffset,
      });

      res.json({
        names: result.tools.map(t => t.name),
        total: result.total,
        limit: safeLimit,
        offset: safeOffset,
        hasMore: result.hasMore,
      });
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

      const sessionId = getSessionId(req);

      const result = await codeExecutor.execute(code, {
        timeout,
        context,
        captureConsole: true,
        sessionId,
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

      if (!isProgrammaticToolAllowed(name)) {
        res.status(403).json({
          success: false,
          error: `Tool not allowed for programmatic calls: ${name}`,
        });
        return;
      }

      const tokenizer = getPIITokenizerForSession(getSessionId(req));
      const detokenizedArgs = tokenizer ? tokenizer.detokenizeObject(args) : args;

      // Call the tool
      const response = await backendManager.callTool(name, detokenizedArgs);

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

      if (tokenizer) {
        result = tokenizer.tokenizeObject(result).result;
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

      if (!isProgrammaticToolAllowed(name)) {
        res.status(403).json({
          success: false,
          error: `Tool not allowed for programmatic calls: ${name}`,
        });
        return;
      }

      const tokenizer = getPIITokenizerForSession(getSessionId(req));
      const detokenizedArgs = tokenizer ? tokenizer.detokenizeObject(args) : args;

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
      const response = await backendManager.callTool(name, detokenizedArgs);

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
        result: tokenizer ? tokenizer.tokenizeObject(aggregated).result : aggregated,
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

      for (const c of calls) {
        if (!isProgrammaticToolAllowed(c.toolName)) {
          res.status(403).json({
            success: false,
            error: `Tool not allowed for programmatic calls: ${c.toolName}`,
          });
          return;
        }
      }

      const tokenizer = getPIITokenizerForSession(getSessionId(req));
      const detokenizedCalls = tokenizer
        ? calls.map(c => ({ toolName: c.toolName, args: tokenizer.detokenizeObject(c.args) }))
        : calls;

      const results = await backendManager.callToolsParallel(detokenizedCalls);

      res.json({
        success: true,
        results: results.map((r, i) => ({
          toolName: detokenizedCalls[i].toolName,
          result: tokenizer ? tokenizer.tokenizeObject(r.result).result : r.result,
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

  // ==================== Enhanced Skills API (static routes first) ====================

  /**
   * GET /skills/categories
   * Get all skill categories with counts
   */
  router.get('/skills/categories', (_req: Request, res: Response) => {
    try {
      const stats = skillsManager.getCategoryStats();
      const categories = Object.entries(SKILL_CATEGORIES).map(([key, value]) => ({
        name: key,
        description: value.description,
        keywords: value.keywords,
        skillCount: stats[key as SkillCategory] || 0,
      }));
      res.json({ categories, total: Object.values(stats).reduce((a, b) => a + b, 0) });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get skill categories',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /skills/templates
   * Get available skill templates
   */
  router.get('/skills/templates', (_req: Request, res: Response) => {
    try {
      const templates = skillsManager.getTemplates();
      res.json({
        templates: templates.map(t => ({
          name: t.name,
          description: t.description,
          category: t.category,
          tags: t.tagsTemplate,
          inputs: t.inputsTemplate,
        })),
        count: templates.length,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get skill templates',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /skills/external-paths
   * Get external skills directories
   */
  router.get('/skills/external-paths', (_req: Request, res: Response) => {
    try {
      const paths = skillsManager.getExternalPaths();
      res.json({ paths, count: paths.length });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get external paths',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills/search/advanced
   * Advanced skill search
   */
  router.post('/skills/search/advanced', (req: Request, res: Response) => {
    try {
      const { query, category, tags, source, limit } = req.body;
      const skills = skillsManager.searchSkills({
        query,
        category: category as SkillCategory | undefined,
        tags,
        source,
        limit,
      });
      res.json({ skills, count: skills.length });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to search skills',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills/chain/execute
   * Execute a chain of skills
   */
  router.post('/skills/chain/execute', async (req: Request, res: Response) => {
    try {
      const { skillNames, inputs = {} } = req.body;
      if (!Array.isArray(skillNames) || skillNames.length === 0) {
        res.status(400).json({ error: 'skillNames array is required' });
        return;
      }

      const results = await skillsManager.executeSkillChain(skillNames, inputs, {
        sessionId: getSessionId(req),
      });

      res.json({
        success: results.every(r => r.success),
        results,
        skillsExecuted: results.length,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to execute skill chain',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills/sync
   * Sync all external skills to workspace
   */
  router.post('/skills/sync', (_req: Request, res: Response) => {
    try {
      const result = skillsManager.syncExternalSkills();
      res.json({
        success: true,
        imported: result.imported,
        failed: result.failed,
        message: `Imported ${result.imported.length} skills, ${result.failed.length} failed`,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to sync skills',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills/from-template
   * Create a skill from a template
   */
  router.post('/skills/from-template', (req: Request, res: Response) => {
    try {
      const { templateName, skillName, customizations } = req.body;

      if (!templateName || !skillName) {
        res.status(400).json({ error: 'templateName and skillName are required' });
        return;
      }

      if (!isValidSkillName(skillName)) {
        res.status(400).json({ error: 'Invalid skill name' });
        return;
      }

      const skill = skillsManager.createFromTemplate(templateName, skillName, customizations);
      res.status(201).json({ success: true, skill });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to create skill from template',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills/external-paths
   * Add an external skills directory
   */
  router.post('/skills/external-paths', (req: Request, res: Response) => {
    try {
      const { path } = req.body;
      if (!path) {
        res.status(400).json({ error: 'path is required' });
        return;
      }

      const success = skillsManager.addExternalPath(path);
      if (!success) {
        res.status(400).json({ error: `Path does not exist: ${path}` });
        return;
      }

      res.json({ success: true, paths: skillsManager.getExternalPaths() });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to add external path',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==================== Parameterized Skills Routes ====================

  /**
   * GET /skills/:name
   * Get a specific skill
   */
  router.get('/skills/:name', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      if (!isValidSkillName(name)) {
        res.status(400).json({ error: 'Invalid skill name' });
        return;
      }
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
   * Body: { inputs: object, timeout?: number (ms, 1000-120000) }
   */
  router.post('/skills/:name/execute', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      if (!isValidSkillName(name)) {
        res.status(400).json({ error: 'Invalid skill name' });
        return;
      }
      const { inputs = {}, timeout } = req.body;

      // Validate timeout if provided (1s to 2min)
      const validTimeout = typeof timeout === 'number' && timeout >= 1000 && timeout <= 120000
        ? timeout
        : undefined;

      const result = await skillsManager.executeSkill(name, inputs, {
        sessionId: getSessionId(req),
        timeout: validTimeout,
      });
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
      if (!isValidSkillName(name)) {
        res.status(400).json({ error: 'Invalid skill name' });
        return;
      }
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

  /**
   * PATCH /skills/:name
   * Update an existing skill (partial update)
   */
  router.patch('/skills/:name', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      if (!isValidSkillName(name)) {
        res.status(400).json({ error: 'Invalid skill name' });
        return;
      }

      // Check if skill exists
      const existingSkill = skillsManager.getSkill(name);
      if (!existingSkill) {
        res.status(404).json({ error: `Skill '${name}' not found` });
        return;
      }

      // External skills cannot be updated directly
      if (existingSkill.source === 'external') {
        res.status(400).json({
          error: 'Cannot update external skill directly. Import it first with POST /skills/:name/import',
        });
        return;
      }

      // Validate partial update data
      const parseResult = SkillUpdateSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid skill update data',
          details: parseResult.error.errors,
        });
        return;
      }

      const updates = parseResult.data;
      const updatedSkill = skillsManager.updateSkill(name, updates);

      if (!updatedSkill) {
        res.status(500).json({ error: 'Failed to update skill' });
        return;
      }

      res.json({
        success: true,
        skill: updatedSkill,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to update skill',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /skills/:name/import
   * Import an external skill to workspace
   */
  router.post('/skills/:name/import', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      if (!isValidSkillName(name)) {
        res.status(400).json({ error: 'Invalid skill name' });
        return;
      }

      const skill = skillsManager.importSkill(name);
      if (!skill) {
        res.status(404).json({ error: `Skill '${name}' not found or already in workspace` });
        return;
      }

      res.json({ success: true, skill, message: `Imported '${name}' to workspace` });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to import skill',
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
      const sessionId =
        (req.headers['mcp-session-id'] as string) ||
        (req.headers['x-session-id'] as string) ||
        'default';
      const session = workspaceManager.loadSessionState(sessionId);
      res.json({ session, sessionId });
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
      const sessionId =
        (req.headers['mcp-session-id'] as string) ||
        (req.headers['x-session-id'] as string) ||
        'default';
      const updates = req.body;

      const session = workspaceManager.updateSessionState(sessionId, updates);

      res.json({ success: true, session, sessionId });
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
