/**
 * Enhanced Skills System
 *
 * Based on Claude's skills methodology:
 * - Skills encode procedural knowledge and workflows
 * - Skills work with MCP tools to provide expertise layer
 * - Skills can be chained and composed
 * - Skills support external directories for sharing
 *
 * @see https://claude.com/blog/extending-claude-capabilities-with-skills-mcp-servers
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, watch, FSWatcher } from 'fs';
import { join, resolve, sep } from 'path';
import { WorkspaceManager } from './workspace.js';
import { CodeExecutor, ExecutionResult } from './executor.js';
import { logger } from '../logger.js';

const SKILL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidSkillName(name: string): boolean {
  if (!SKILL_NAME_REGEX.test(name)) {
    return false;
  }
  return name.length >= 1 && name.length <= 100;
}

// Skill Categories aligned with common use cases
export const SKILL_CATEGORIES = {
  'code-quality': {
    description: 'Code review, linting, refactoring suggestions',
    keywords: ['review', 'lint', 'refactor', 'quality', 'clean'],
  },
  'git-workflow': {
    description: 'Git operations, commits, PR management',
    keywords: ['git', 'commit', 'pr', 'branch', 'merge'],
  },
  'database': {
    description: 'Database queries, schema analysis, migrations',
    keywords: ['sql', 'database', 'query', 'schema', 'migration'],
  },
  'api': {
    description: 'API testing, documentation, integration',
    keywords: ['api', 'rest', 'graphql', 'endpoint', 'http'],
  },
  'documentation': {
    description: 'Documentation generation, README updates',
    keywords: ['doc', 'readme', 'comment', 'jsdoc', 'markdown'],
  },
  'testing': {
    description: 'Test generation, coverage analysis',
    keywords: ['test', 'spec', 'coverage', 'unit', 'integration'],
  },
  'devops': {
    description: 'CI/CD, Docker, deployment workflows',
    keywords: ['docker', 'ci', 'cd', 'deploy', 'pipeline', 'github-actions'],
  },
  'productivity': {
    description: 'General productivity and automation',
    keywords: ['automate', 'scaffold', 'generate', 'template'],
  },
  'analysis': {
    description: 'Code analysis, metrics, reporting',
    keywords: ['analyze', 'metric', 'report', 'standup', 'summary'],
  },
  'domain-specific': {
    description: 'Domain-specific helpers (ERP, CRM, etc.)',
    keywords: ['maximo', 'dynamics', 'ax', 'erp', 'crm', 'fabric'],
  },
  'memory': {
    description: 'Memory and context management',
    keywords: ['memory', 'cipher', 'context', 'recall', 'store'],
  },
  'browser': {
    description: 'Browser automation and data extraction',
    keywords: ['chrome', 'browser', 'scrape', 'extract', 'web'],
  },
} as const;

export type SkillCategory = keyof typeof SKILL_CATEGORIES;

export interface SkillInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required: boolean;
  default?: unknown;
}

export interface MCPDependency {
  toolPattern: string; // Tool name or pattern (e.g., "mssql_*", "github_*")
  description?: string;
  required: boolean;
}

export interface WorkflowStep {
  id: string;
  description: string;
  toolsUsed?: string[];
  condition?: string; // Optional condition for execution
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  author?: string;
  tags: string[];
  category?: SkillCategory;
  inputs: SkillInput[];
  code: string;

  // Enhanced metadata for Claude-style skills
  mcpDependencies?: MCPDependency[];
  workflow?: WorkflowStep[];
  chainOfThought?: string; // Thinking process guidance
  antiHallucination?: string[]; // Rules to prevent hallucination
  verificationChecklist?: string[]; // Verification steps
  examples?: Array<{
    input: Record<string, unknown>;
    description: string;
  }>;

  // Source tracking
  source?: 'workspace' | 'external' | 'imported';
  sourcePath?: string;

  createdAt: Date;
  updatedAt: Date;
}

export interface SkillExecutionResult extends ExecutionResult {
  skillName: string;
  category?: SkillCategory;
  mcpToolsCalled?: string[];
}

export interface SkillSearchOptions {
  query?: string;
  category?: SkillCategory;
  tags?: string[];
  source?: 'workspace' | 'external' | 'all';
  limit?: number;
}

export interface SkillTemplate {
  name: string;
  description: string;
  category: SkillCategory;
  codeTemplate: string;
  inputsTemplate: SkillInput[];
  tagsTemplate: string[];
}

// Built-in skill templates
export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    name: 'code-review-template',
    description: 'Template for code review skills',
    category: 'code-quality',
    codeTemplate: `const language = inputs?.language || 'typescript';
const focus = inputs?.focus || 'all';

const checklist = \`
# Code Review Checklist for \${language}

## Security
- [ ] No hardcoded credentials
- [ ] Input validation in place
- [ ] SQL injection prevention

## Performance
- [ ] No N+1 queries
- [ ] Proper pagination

## Maintainability
- [ ] Clear naming conventions
- [ ] Single responsibility functions

Focus: \${focus}
\`;

console.log(checklist);`,
    inputsTemplate: [
      { name: 'language', type: 'string', required: false, default: 'typescript', description: 'Programming language' },
      { name: 'focus', type: 'string', required: false, default: 'all', description: 'Focus area' },
    ],
    tagsTemplate: ['code-review', 'quality'],
  },
  {
    name: 'git-commit-template',
    description: 'Template for smart git commit skills',
    category: 'git-workflow',
    codeTemplate: `const scope = inputs?.scope || '';
const breaking = inputs?.breaking ? '!' : '';

const guide = \`
# Conventional Commit Guide

## Types
- feat: New feature
- fix: Bug fix
- docs: Documentation
- refactor: Code restructure
- chore: Maintenance

Format: type\${scope ? '(' + scope + ')' : ''}\${breaking}: description
\`;

console.log(guide);`,
    inputsTemplate: [
      { name: 'scope', type: 'string', required: false, description: 'Commit scope' },
      { name: 'breaking', type: 'boolean', required: false, default: false, description: 'Breaking change' },
    ],
    tagsTemplate: ['git', 'commit', 'conventional-commits'],
  },
  {
    name: 'database-query-template',
    description: 'Template for database query analysis skills',
    category: 'database',
    codeTemplate: `const dialect = inputs?.dialect || 'mssql';
const query = inputs?.query || '';

const guide = \`
# SQL Query Guide for \${dialect.toUpperCase()}

## Best Practices
- Always use parameterized queries
- Include USE statement for multi-DB servers
- Optimize WHERE clauses (indexed columns first)
- Avoid SELECT * in production

\${query ? 'Query to analyze: ' + query : 'No query provided'}
\`;

console.log(guide);`,
    inputsTemplate: [
      { name: 'dialect', type: 'string', required: false, default: 'mssql', description: 'SQL dialect' },
      { name: 'query', type: 'string', required: false, description: 'Query to analyze' },
    ],
    tagsTemplate: ['sql', 'database', 'query'],
  },
  {
    name: 'api-test-template',
    description: 'Template for API testing skills',
    category: 'api',
    codeTemplate: `const endpoint = inputs?.endpoint || '';
const method = inputs?.method || 'GET';

const template = \`
# API Test Template

## Endpoint: \${method} \${endpoint}

### Test Cases
1. Happy path - Valid request
2. Invalid input - 400 response
3. Unauthorized - 401 response
4. Not found - 404 response
5. Rate limit - 429 response

### Assertions
- Response status code
- Response time < 500ms
- Response body schema
- Required headers present
\`;

console.log(template);`,
    inputsTemplate: [
      { name: 'endpoint', type: 'string', required: true, description: 'API endpoint' },
      { name: 'method', type: 'string', required: false, default: 'GET', description: 'HTTP method' },
    ],
    tagsTemplate: ['api', 'testing', 'http'],
  },
];

/**
 * Enhanced Skills Manager
 *
 * Supports:
 * - Multiple skills directories (workspace + external)
 * - Skill categories and semantic search
 * - MCP dependencies tracking
 * - Skill chaining and composition
 * - Hot-reload from external directories
 */
export class SkillsManager {
  private executor: CodeExecutor;
  private workspaceSkillsPath: string;
  private externalSkillsPaths: string[];
  private skillsCache: Map<string, Skill> = new Map();
  private watchers: FSWatcher[] = [];
  private lastRefresh: number = 0;
  private refreshInterval: number = 30000; // 30 seconds

  constructor(
    workspace: WorkspaceManager,
    executor: CodeExecutor,
    externalPaths: string[] = []
  ) {
    this.executor = executor;
    this.workspaceSkillsPath = workspace.getSkillsPath();

    // Include default external skills path if not provided
    const defaultMSkillsPath = join(process.cwd(), 'external-skills');
    this.externalSkillsPaths = externalPaths.length > 0
      ? externalPaths
      : (existsSync(defaultMSkillsPath) ? [defaultMSkillsPath] : []);

    // Initial cache population
    this.refreshCache();

    // Set up file watchers for hot-reload
    this.setupWatchers();
  }

  /**
   * Set up file watchers for hot-reload
   */
  private setupWatchers(): void {
    const watchPaths = [this.workspaceSkillsPath, ...this.externalSkillsPaths];

    for (const watchPath of watchPaths) {
      if (existsSync(watchPath)) {
        try {
          const watcher = watch(watchPath, { recursive: true }, (eventType, filename) => {
            if (filename && (filename.endsWith('.json') || filename.endsWith('.ts'))) {
              logger.debug(`Skills change detected: ${eventType} ${filename}`);
              this.invalidateCache();
            }
          });
          this.watchers.push(watcher);
        } catch (err) {
          logger.warn(`Could not watch skills directory: ${watchPath}`);
        }
      }
    }
  }

  /**
   * Invalidate the cache to force refresh
   */
  private invalidateCache(): void {
    this.lastRefresh = 0;
  }

  /**
   * Refresh the skills cache
   */
  private refreshCache(): void {
    const now = Date.now();
    if (now - this.lastRefresh < this.refreshInterval) {
      return;
    }

    this.skillsCache.clear();

    // Load from workspace
    this.loadSkillsFromDirectory(this.workspaceSkillsPath, 'workspace');

    // Load from external paths
    for (const extPath of this.externalSkillsPaths) {
      this.loadSkillsFromDirectory(extPath, 'external');
    }

    this.lastRefresh = now;
    logger.debug(`Skills cache refreshed: ${this.skillsCache.size} skills loaded`);
  }

  /**
   * Load skills from a directory
   */
  private loadSkillsFromDirectory(dirPath: string, source: 'workspace' | 'external'): void {
    if (!existsSync(dirPath)) {
      return;
    }

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const skillDir = join(dirPath, entry.name);
          const skill = this.loadSkillFromDir(skillDir, source);
          if (skill) {
            // External skills may override workspace skills
            this.skillsCache.set(skill.name, skill);
          }
        }
      }
    } catch (err) {
      logger.warn(`Error loading skills from ${dirPath}: ${err}`);
    }
  }

  /**
   * Load a skill from a directory
   */
  private loadSkillFromDir(skillDir: string, source: 'workspace' | 'external'): Skill | null {
    const metadataPath = join(skillDir, 'skill.json');
    const codePath = join(skillDir, 'index.ts');

    if (!existsSync(metadataPath)) {
      return null;
    }

    try {
      const metadataContent = readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);

      // Read code if exists
      let code = metadata.code || '';
      if (existsSync(codePath)) {
        code = readFileSync(codePath, 'utf-8');
      }

      // Auto-detect category from tags
      const category = metadata.category || this.detectCategory(metadata.tags || [], metadata.name);

      const skill: Skill = {
        name: metadata.name,
        description: metadata.description || '',
        version: metadata.version || '1.0.0',
        author: metadata.author,
        tags: metadata.tags || [],
        category,
        inputs: this.normalizeInputs(metadata.inputs || []),
        code,
        mcpDependencies: metadata.mcpDependencies || [],
        workflow: metadata.workflow || [],
        chainOfThought: metadata.chainOfThought,
        antiHallucination: metadata.antiHallucination || [],
        verificationChecklist: metadata.verificationChecklist || [],
        examples: metadata.examples || [],
        source,
        sourcePath: skillDir,
        createdAt: new Date(metadata.createdAt || Date.now()),
        updatedAt: new Date(metadata.updatedAt || Date.now()),
      };

      return skill;
    } catch (err) {
      logger.warn(`Error loading skill from ${skillDir}: ${err}`);
      return null;
    }
  }

  /**
   * Normalize inputs to ensure required is always boolean
   */
  private normalizeInputs(inputs: SkillInput[]): SkillInput[] {
    return inputs.map(input => ({
      ...input,
      required: input.required ?? true,
    }));
  }

  /**
   * Auto-detect category from tags and name
   */
  private detectCategory(tags: string[], name: string): SkillCategory | undefined {
    const searchTerms = [...tags, ...name.toLowerCase().split('-')];

    for (const [category, config] of Object.entries(SKILL_CATEGORIES)) {
      for (const keyword of config.keywords) {
        if (searchTerms.some(term => term.includes(keyword) || keyword.includes(term))) {
          return category as SkillCategory;
        }
      }
    }

    return 'productivity'; // Default category
  }

  private resolveSkillDir(name: string): string | null {
    if (!isValidSkillName(name)) {
      return null;
    }

    const basePath = resolve(this.workspaceSkillsPath);
    const skillPath = resolve(basePath, name);
    if (!skillPath.startsWith(basePath + sep)) {
      return null;
    }

    return skillPath;
  }

  /**
   * Create a new skill
   */
  createSkill(skill: Omit<Skill, 'createdAt' | 'updatedAt' | 'source' | 'sourcePath'>): Skill {
    const skillDir = this.resolveSkillDir(skill.name);
    if (!skillDir) {
      throw new Error('Invalid skill name');
    }

    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }

    // Auto-detect category if not provided
    const category = skill.category || this.detectCategory(skill.tags, skill.name);

    const fullSkill: Skill = {
      ...skill,
      category,
      inputs: this.normalizeInputs(skill.inputs || []),
      source: 'workspace',
      sourcePath: skillDir,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Save SKILL.md with enhanced documentation
    const skillMd = this.generateSkillMarkdown(fullSkill);
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

    // Save index.ts with code
    writeFileSync(join(skillDir, 'index.ts'), skill.code, 'utf-8');

    // Save skill.json with metadata (exclude code and sourcePath for portability)
    const { code: _code, sourcePath: _sourcePath, ...metadata } = fullSkill;
    writeFileSync(
      join(skillDir, 'skill.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8'
    );

    // Update cache
    this.skillsCache.set(fullSkill.name, fullSkill);

    logger.info(`Created skill: ${skill.name}`);
    return fullSkill;
  }

  /**
   * Update an existing skill
   */
  updateSkill(name: string, updates: Partial<Omit<Skill, 'name' | 'createdAt' | 'source' | 'sourcePath'>>): Skill | null {
    const skill = this.getSkill(name);
    if (!skill) return null;

    // Don't allow updating external skills directly
    if (skill.source === 'external') {
      throw new Error('Cannot update external skills. Import them first.');
    }

    const updatedSkill: Skill = {
      ...skill,
      ...updates,
      name: skill.name,
      createdAt: skill.createdAt,
      source: skill.source,
      sourcePath: skill.sourcePath,
      updatedAt: new Date(),
    };

    const skillDir = this.resolveSkillDir(name);
    if (!skillDir) {
      return null;
    }

    // Update files
    if (updates.code) {
      writeFileSync(join(skillDir, 'index.ts'), updates.code, 'utf-8');
    }

    const skillMd = this.generateSkillMarkdown(updatedSkill);
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

    // Exclude code and sourcePath for portability
    const { code: _code, sourcePath: _sourcePath, ...metadata } = updatedSkill;
    writeFileSync(
      join(skillDir, 'skill.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8'
    );

    // Update cache
    this.skillsCache.set(name, updatedSkill);

    logger.info(`Updated skill: ${name}`);
    return updatedSkill;
  }

  /**
   * Get a skill by name
   */
  getSkill(name: string): Skill | null {
    this.refreshCache();
    return this.skillsCache.get(name) || null;
  }

  /**
   * List all available skills
   */
  listSkills(): Skill[] {
    this.refreshCache();
    return Array.from(this.skillsCache.values());
  }

  /**
   * Search skills with advanced filtering
   */
  searchSkills(query: string): Skill[];
  searchSkills(options: SkillSearchOptions): Skill[];
  searchSkills(queryOrOptions: string | SkillSearchOptions): Skill[] {
    this.refreshCache();

    const allSkills = Array.from(this.skillsCache.values());

    // Simple string query
    if (typeof queryOrOptions === 'string') {
      const queryLower = queryOrOptions.toLowerCase();
      return allSkills.filter(skill =>
        skill.name.toLowerCase().includes(queryLower) ||
        skill.description.toLowerCase().includes(queryLower) ||
        skill.tags.some(tag => tag.toLowerCase().includes(queryLower)) ||
        (skill.category && skill.category.toLowerCase().includes(queryLower))
      );
    }

    // Advanced search options
    const { query, category, tags, source, limit } = queryOrOptions;

    let results = allSkills;

    if (query) {
      const queryLower = query.toLowerCase();
      results = results.filter(skill =>
        skill.name.toLowerCase().includes(queryLower) ||
        skill.description.toLowerCase().includes(queryLower) ||
        skill.tags.some(tag => tag.toLowerCase().includes(queryLower))
      );
    }

    if (category) {
      results = results.filter(skill => skill.category === category);
    }

    if (tags && tags.length > 0) {
      results = results.filter(skill =>
        tags.some(tag => skill.tags.includes(tag))
      );
    }

    if (source && source !== 'all') {
      results = results.filter(skill => skill.source === source);
    }

    if (limit && limit > 0) {
      results = results.slice(0, limit);
    }

    return results;
  }

  /**
   * Get skills by category
   */
  getSkillsByCategory(category: SkillCategory): Skill[] {
    return this.searchSkills({ category });
  }

  /**
   * Get category statistics
   */
  getCategoryStats(): Record<SkillCategory, number> {
    this.refreshCache();
    const stats: Record<string, number> = {};

    for (const category of Object.keys(SKILL_CATEGORIES)) {
      stats[category] = 0;
    }

    for (const skill of this.skillsCache.values()) {
      if (skill.category) {
        stats[skill.category] = (stats[skill.category] || 0) + 1;
      }
    }

    return stats as Record<SkillCategory, number>;
  }

  /**
   * Execute a skill with given inputs
   */
  async executeSkill(
    name: string,
    inputs: Record<string, unknown> = {},
    options?: { sessionId?: string; timeout?: number }
  ): Promise<SkillExecutionResult> {
    const skill = this.getSkill(name);

    if (!skill) {
      return {
        skillName: name,
        success: false,
        output: [],
        error: `Skill not found: ${name}`,
        executionTime: 0,
      };
    }

    // Validate required inputs
    for (const input of skill.inputs) {
      if (input.required && !(input.name in inputs)) {
        if (input.default !== undefined) {
          inputs[input.name] = input.default;
        } else {
          return {
            skillName: name,
            success: false,
            output: [],
            error: `Missing required input: ${input.name}`,
            executionTime: 0,
          };
        }
      }
    }

    // Execute the skill code with inputs as context
    const result = await this.executor.execute(skill.code, {
      context: { inputs, ...inputs },
      sessionId: options?.sessionId,
      timeout: options?.timeout ?? 60000,
    });

    return {
      ...result,
      skillName: name,
      category: skill.category,
    };
  }

  /**
   * Execute a chain of skills
   */
  async executeSkillChain(
    skillNames: string[],
    initialInputs: Record<string, unknown> = {},
    options?: { sessionId?: string; timeout?: number }
  ): Promise<SkillExecutionResult[]> {
    const results: SkillExecutionResult[] = [];
    let currentInputs = { ...initialInputs };

    for (const skillName of skillNames) {
      const result = await this.executeSkill(skillName, currentInputs, options);
      results.push(result);

      if (!result.success) {
        break; // Stop chain on failure
      }

      // Pass outputs as inputs to next skill
      if (result.output && result.output.length > 0) {
        try {
          const lastOutput = result.output[result.output.length - 1];
          if (typeof lastOutput === 'object') {
            currentInputs = { ...currentInputs, previousResult: lastOutput };
          } else {
            currentInputs = { ...currentInputs, previousResult: lastOutput };
          }
        } catch {
          // Continue with current inputs
        }
      }
    }

    return results;
  }

  /**
   * Import a skill from an external source to workspace
   */
  importSkill(name: string): Skill | null {
    const skill = this.getSkill(name);
    if (!skill) {
      return null;
    }

    if (skill.source === 'workspace') {
      return skill; // Already in workspace
    }

    // Create a copy in workspace
    return this.createSkill({
      name: skill.name,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      tags: skill.tags,
      category: skill.category,
      inputs: skill.inputs,
      code: skill.code,
      mcpDependencies: skill.mcpDependencies,
      workflow: skill.workflow,
      chainOfThought: skill.chainOfThought,
      antiHallucination: skill.antiHallucination,
      verificationChecklist: skill.verificationChecklist,
      examples: skill.examples,
    });
  }

  /**
   * Sync all external skills to workspace
   */
  syncExternalSkills(): { imported: string[]; failed: string[] } {
    this.refreshCache();

    const imported: string[] = [];
    const failed: string[] = [];

    for (const skill of this.skillsCache.values()) {
      if (skill.source === 'external') {
        try {
          this.importSkill(skill.name);
          imported.push(skill.name);
        } catch (err) {
          failed.push(skill.name);
        }
      }
    }

    return { imported, failed };
  }

  /**
   * Create skill from template
   */
  createFromTemplate(templateName: string, skillName: string, customizations?: Partial<Skill>): Skill {
    const template = SKILL_TEMPLATES.find(t => t.name === templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    return this.createSkill({
      name: skillName,
      description: customizations?.description || template.description,
      version: '1.0.0',
      category: template.category,
      tags: [...template.tagsTemplate, ...(customizations?.tags || [])],
      inputs: customizations?.inputs || template.inputsTemplate,
      code: customizations?.code || template.codeTemplate,
    });
  }

  /**
   * Get available templates
   */
  getTemplates(): SkillTemplate[] {
    return SKILL_TEMPLATES;
  }

  /**
   * Delete a skill
   */
  deleteSkill(name: string): boolean {
    const skill = this.getSkill(name);
    if (!skill) {
      return false;
    }

    if (skill.source === 'external') {
      throw new Error('Cannot delete external skills');
    }

    const skillDir = this.resolveSkillDir(name);
    if (!skillDir || !existsSync(skillDir)) {
      return false;
    }

    rmSync(skillDir, { recursive: true, force: true });
    this.skillsCache.delete(name);

    logger.info(`Deleted skill: ${name}`);
    return true;
  }

  /**
   * Generate enhanced skill documentation
   */
  private generateSkillMarkdown(skill: Skill): string {
    const inputDocs = skill.inputs
      .map(input => {
        const required = input.required ? '(required)' : '(optional)';
        const defaultVal = input.default !== undefined ? ` [default: ${JSON.stringify(input.default)}]` : '';
        return `- \`${input.name}\` (${input.type}) ${required}${defaultVal}: ${input.description || 'No description'}`;
      })
      .join('\n');

    const mcpDeps = skill.mcpDependencies?.length
      ? skill.mcpDependencies.map(dep => `- \`${dep.toolPattern}\`: ${dep.description || 'Required'}`).join('\n')
      : 'None specified';

    const workflow = skill.workflow?.length
      ? skill.workflow.map(step => `${step.id}. ${step.description}`).join('\n')
      : 'No workflow defined';

    const antiHallucination = skill.antiHallucination?.length
      ? skill.antiHallucination.map((rule, i) => `${i + 1}. ${rule}`).join('\n')
      : 'None specified';

    const verification = skill.verificationChecklist?.length
      ? skill.verificationChecklist.map(check => `- [ ] ${check}`).join('\n')
      : 'None specified';

    return `# ${skill.name}

${skill.description}

## Metadata
- **Version**: ${skill.version}
- **Category**: ${skill.category || 'Uncategorized'}
- **Source**: ${skill.source || 'workspace'}
${skill.author ? `- **Author**: ${skill.author}` : ''}

## Tags
${skill.tags.map(t => `\`${t}\``).join(', ') || 'None'}

## MCP Dependencies
${mcpDeps}

## Inputs
${inputDocs || 'No inputs required.'}

${skill.chainOfThought ? `## Chain of Thought\n${skill.chainOfThought}\n` : ''}

## Workflow
${workflow}

## Anti-Hallucination Rules
${antiHallucination}

## Verification Checklist
${verification}

## Usage

\`\`\`typescript
// Execute via MCP Gateway:
gateway_execute_skill({ name: "${skill.name}", inputs: { ... } })

// Or via REST API:
// POST /api/code/skills/${skill.name}/execute
// Body: { "inputs": { ... } }
\`\`\`

${skill.examples?.length ? `## Examples\n${skill.examples.map(ex => `- ${ex.description}: \`${JSON.stringify(ex.input)}\``).join('\n')}` : ''}

## Code

\`\`\`typescript
${skill.code}
\`\`\`

---
Created: ${skill.createdAt}
Updated: ${skill.updatedAt}
`;
  }

  /**
   * Export skill for sharing
   */
  exportSkill(name: string): Skill | null {
    return this.getSkill(name);
  }

  /**
   * Get external paths being monitored
   */
  getExternalPaths(): string[] {
    return [...this.externalSkillsPaths];
  }

  /**
   * Add an external skills path
   */
  addExternalPath(path: string): boolean {
    if (!existsSync(path)) {
      return false;
    }

    if (!this.externalSkillsPaths.includes(path)) {
      this.externalSkillsPaths.push(path);
      this.invalidateCache();
      this.setupWatchers();
    }

    return true;
  }

  /**
   * Cleanup watchers on shutdown
   */
  cleanup(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore errors on cleanup
      }
    }
    this.watchers = [];
  }
}
