/**
 * Skills System
 *
 * Allows agents to save working code patterns as reusable skills
 * that can be discovered and executed later.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { WorkspaceManager } from './workspace.js';
import { CodeExecutor, ExecutionResult } from './executor.js';
import { logger } from '../logger.js';

export interface Skill {
  name: string;
  description: string;
  version: string;
  author?: string;
  tags: string[];
  inputs: SkillInput[];
  code: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required: boolean;
  default?: unknown;
}

export interface SkillExecutionResult extends ExecutionResult {
  skillName: string;
}

/**
 * Skills Manager - Create, discover, and execute reusable code patterns
 */
export class SkillsManager {
  private executor: CodeExecutor;
  private skillsPath: string;

  constructor(workspace: WorkspaceManager, executor: CodeExecutor) {
    this.executor = executor;
    this.skillsPath = workspace.getSkillsPath();
  }

  /**
   * Create a new skill from code
   */
  createSkill(skill: Omit<Skill, 'createdAt' | 'updatedAt'>): Skill {
    const skillDir = join(this.skillsPath, skill.name);

    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }

    const fullSkill: Skill = {
      ...skill,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Save SKILL.md with documentation
    const skillMd = this.generateSkillMarkdown(fullSkill);
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

    // Save index.ts with code
    writeFileSync(join(skillDir, 'index.ts'), skill.code, 'utf-8');

    // Save skill.json with metadata
    writeFileSync(
      join(skillDir, 'skill.json'),
      JSON.stringify(fullSkill, null, 2),
      'utf-8'
    );

    logger.info(`Created skill: ${skill.name}`);
    return fullSkill;
  }

  /**
   * Update an existing skill
   */
  updateSkill(name: string, updates: Partial<Omit<Skill, 'name' | 'createdAt'>>): Skill | null {
    const skill = this.getSkill(name);
    if (!skill) return null;

    const updatedSkill: Skill = {
      ...skill,
      ...updates,
      name: skill.name, // Name cannot be changed
      createdAt: skill.createdAt,
      updatedAt: new Date(),
    };

    const skillDir = join(this.skillsPath, name);

    // Update files
    if (updates.code) {
      writeFileSync(join(skillDir, 'index.ts'), updates.code, 'utf-8');
    }

    const skillMd = this.generateSkillMarkdown(updatedSkill);
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');
    writeFileSync(
      join(skillDir, 'skill.json'),
      JSON.stringify(updatedSkill, null, 2),
      'utf-8'
    );

    logger.info(`Updated skill: ${name}`);
    return updatedSkill;
  }

  /**
   * Get a skill by name
   */
  getSkill(name: string): Skill | null {
    const skillDir = join(this.skillsPath, name);
    const metadataPath = join(skillDir, 'skill.json');

    if (!existsSync(metadataPath)) {
      return null;
    }

    try {
      const content = readFileSync(metadataPath, 'utf-8');
      return JSON.parse(content) as Skill;
    } catch {
      return null;
    }
  }

  /**
   * List all available skills
   */
  listSkills(): Skill[] {
    if (!existsSync(this.skillsPath)) {
      return [];
    }

    const entries = readdirSync(this.skillsPath, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skill = this.getSkill(entry.name);
        if (skill) {
          skills.push(skill);
        }
      }
    }

    return skills;
  }

  /**
   * Search skills by name, description, or tags
   */
  searchSkills(query: string): Skill[] {
    const allSkills = this.listSkills();
    const queryLower = query.toLowerCase();

    return allSkills.filter(skill =>
      skill.name.toLowerCase().includes(queryLower) ||
      skill.description.toLowerCase().includes(queryLower) ||
      skill.tags.some(tag => tag.toLowerCase().includes(queryLower))
    );
  }

  /**
   * Execute a skill with given inputs
   */
  async executeSkill(
    name: string,
    inputs: Record<string, unknown> = {},
    options?: { sessionId?: string }
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
    });

    return {
      ...result,
      skillName: name,
    };
  }

  /**
   * Delete a skill
   */
  deleteSkill(name: string): boolean {
    const skillDir = join(this.skillsPath, name);

    if (!existsSync(skillDir)) {
      return false;
    }

    // Remove all files in skill directory
    const files = readdirSync(skillDir);
    for (const file of files) {
      const filePath = join(skillDir, file);
      require('fs').unlinkSync(filePath);
    }

    // Remove directory
    require('fs').rmdirSync(skillDir);

    logger.info(`Deleted skill: ${name}`);
    return true;
  }

  /**
   * Generate skill documentation markdown
   */
  private generateSkillMarkdown(skill: Skill): string {
    const inputDocs = skill.inputs
      .map(input => {
        const required = input.required ? '(required)' : '(optional)';
        const defaultVal = input.default !== undefined ? ` [default: ${JSON.stringify(input.default)}]` : '';
        return `- \`${input.name}\` (${input.type}) ${required}${defaultVal}: ${input.description || 'No description'}`;
      })
      .join('\n');

    return `# ${skill.name}

${skill.description}

## Version
${skill.version}

${skill.author ? `## Author\n${skill.author}\n` : ''}

## Tags
${skill.tags.map(t => `\`${t}\``).join(', ')}

## Inputs
${inputDocs || 'No inputs required.'}

## Usage

\`\`\`typescript
// Execute this skill via the API:
// POST /api/code/skills/${skill.name}/execute
// Body: { "inputs": { ... } }
\`\`\`

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
   * Import skill from external source
   */
  importSkill(skillData: Skill): Skill {
    return this.createSkill({
      name: skillData.name,
      description: skillData.description,
      version: skillData.version,
      author: skillData.author,
      tags: skillData.tags,
      inputs: skillData.inputs,
      code: skillData.code,
    });
  }

  /**
   * Export skill for sharing
   */
  exportSkill(name: string): Skill | null {
    return this.getSkill(name);
  }
}
