import { SkillsManager, isValidSkillName, SKILL_CATEGORIES, SkillCategory } from '../skills.js';
import { GatewayTool, GatewayToolsConfig } from './types.js';

export function getSkillsTools(config: GatewayToolsConfig, liteMode: boolean): GatewayTool[] {
    const prefix = config.prefix ?? 'gateway';
    const tools: GatewayTool[] = [];

    tools.push({
        name: `${prefix}_list_skills`,
        description: 'List all available skills (reusable code patterns). Use detail="minimal" to save ~95% tokens (returns only name/description/category/tags), or detail="full" for complete skill details including code.',
        inputSchema: {
            type: 'object',
            properties: {
                detail: {
                    type: 'string',
                    enum: ['minimal', 'full'],
                    description: 'Detail level: "minimal" (name/description/category/tags only, ~5KB) or "full" (everything including code, ~165KB). Default: "minimal"',
                },
            },
        },
        inputExamples: [
            { detail: 'minimal' },
            { detail: 'full' },
        ],
    });

    tools.push({
        name: `${prefix}_search_skills`,
        description: 'Search skills by name, description, or tags.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query',
                },
            },
            required: ['query'],
        },
        inputExamples: [
            { query: 'sql' },
        ],
    });

    tools.push({
        name: `${prefix}_get_skill`,
        description: 'Get details of a specific skill including its code and input parameters.',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Skill name',
                },
            },
            required: ['name'],
        },
        inputExamples: [
            { name: 'my-skill' },
        ],
    });

    tools.push({
        name: `${prefix}_execute_skill`,
        description: 'Execute a saved skill with provided inputs.',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Skill name to execute',
                },
                inputs: {
                    type: 'object',
                    description: 'Input parameters for the skill',
                },
            },
            required: ['name'],
        },
        inputExamples: [
            { name: 'my-skill', inputs: { limit: 5 } },
        ],
    });

    // Non-essential skills tools - only in full mode
    if (!liteMode) {
        tools.push({
            name: `${prefix}_create_skill`,
            description: 'Create a new reusable skill from code. Skills can be executed later with different inputs.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Unique skill name (lowercase, hyphens allowed)',
                    },
                    description: {
                        type: 'string',
                        description: 'What this skill does',
                    },
                    code: {
                        type: 'string',
                        description: 'TypeScript/JavaScript code for the skill',
                    },
                    category: {
                        type: 'string',
                        enum: Object.keys(SKILL_CATEGORIES),
                        description: 'Skill category for organization',
                    },
                    inputs: {
                        type: 'array',
                        description: 'Input parameter definitions',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                type: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array'] },
                                description: { type: 'string' },
                                required: { type: 'boolean', default: true },
                            },
                        },
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Tags for categorizing the skill',
                    },
                    mcpDependencies: {
                        type: 'array',
                        description: 'MCP tools this skill depends on',
                        items: {
                            type: 'object',
                            properties: {
                                toolPattern: { type: 'string', description: 'Tool name or pattern (e.g., "mssql_*")' },
                                description: { type: 'string' },
                                required: { type: 'boolean', default: true },
                            },
                        },
                    },
                    chainOfThought: {
                        type: 'string',
                        description: 'Thinking process guidance for the skill',
                    },
                    antiHallucination: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Rules to prevent hallucination',
                    },
                    verificationChecklist: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Verification steps after execution',
                    },
                },
                required: ['name', 'description', 'code'],
            },
            inputExamples: [
                {
                    name: 'list-recent-orders',
                    description: 'Fetch recent orders and print a summary',
                    code: "const r = await callTool('database_query', { query: \"SELECT TOP 5 id, status FROM orders ORDER BY created_at DESC\" });\nconsole.log(r);",
                    inputs: [{ name: 'limit', type: 'number', description: 'Max rows to fetch', required: false }],
                    tags: ['database', 'query'],
                    category: 'database',
                },
            ],
        });

        tools.push({
            name: `${prefix}_get_skill_categories`,
            description: 'Get all skill categories with descriptions and skill counts.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            inputExamples: [{}],
        });

        tools.push({
            name: `${prefix}_search_skills_advanced`,
            description: 'Advanced skill search with category, tags, and source filtering.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query for name/description',
                    },
                    category: {
                        type: 'string',
                        enum: Object.keys(SKILL_CATEGORIES),
                        description: 'Filter by category',
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Filter by tags',
                    },
                    source: {
                        type: 'string',
                        enum: ['workspace', 'external', 'all'],
                        description: 'Filter by source (workspace skills vs external skills)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum results to return',
                    },
                },
            },
            inputExamples: [
                { category: 'code-quality' },
                { query: 'git', source: 'external' },
                { tags: ['productivity', 'automation'] },
            ],
        });

        tools.push({
            name: `${prefix}_execute_skill_chain`,
            description: 'Execute multiple skills in sequence, passing outputs as inputs to the next skill.',
            inputSchema: {
                type: 'object',
                properties: {
                    skillNames: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Skill names to execute in order',
                    },
                    inputs: {
                        type: 'object',
                        description: 'Initial inputs for the first skill',
                    },
                },
                required: ['skillNames'],
            },
            inputExamples: [
                { skillNames: ['code-review', 'git-smart-commit'], inputs: { language: 'typescript' } },
            ],
        });

        tools.push({
            name: `${prefix}_import_skill`,
            description: 'Import an external skill from external-skills folder into the workspace for customization.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name of the external skill to import',
                    },
                },
                required: ['name'],
            },
            inputExamples: [
                { name: 'code-review' },
                { name: 'git-smart-commit' },
            ],
        });

        tools.push({
            name: `${prefix}_sync_external_skills`,
            description: 'Sync all external skills from external-skills folder to workspace.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            inputExamples: [{}],
        });

        tools.push({
            name: `${prefix}_get_skill_templates`,
            description: 'Get available skill templates for quick skill creation.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            inputExamples: [{}],
        });

        tools.push({
            name: `${prefix}_create_skill_from_template`,
            description: 'Create a new skill from a template with customizations.',
            inputSchema: {
                type: 'object',
                properties: {
                    templateName: {
                        type: 'string',
                        description: 'Name of the template to use',
                    },
                    skillName: {
                        type: 'string',
                        description: 'Name for the new skill',
                    },
                    customizations: {
                        type: 'object',
                        description: 'Optional customizations (description, code, inputs, tags)',
                    },
                },
                required: ['templateName', 'skillName'],
            },
            inputExamples: [
                { templateName: 'code-review-template', skillName: 'my-code-review' },
                { templateName: 'git-commit-template', skillName: 'team-commit-style', customizations: { tags: ['team'] } },
            ],
        });

        tools.push({
            name: `${prefix}_get_external_paths`,
            description: 'Get the external skills directories being monitored.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            inputExamples: [{}],
        });

        tools.push({
            name: `${prefix}_add_external_path`,
            description: 'Add a new external skills directory to monitor.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the external skills directory',
                    },
                },
                required: ['path'],
            },
            inputExamples: [
                { path: './external-skills' },
            ],
        });
    }

    return tools;
}

export async function handleSkillsToolCall(
    name: string,
    params: Record<string, unknown>,
    skillsManager: SkillsManager,
    config: GatewayToolsConfig,
    ctx?: { sessionId?: string }
): Promise<unknown> {
    const prefix = config.prefix ?? 'gateway';

    if (name === `${prefix}_list_skills`) {
        const detail = (params.detail as 'minimal' | 'full') || 'minimal';
        const skills = skillsManager.listSkills(detail);
        return { skills, count: skills.length };
    }

    if (name === `${prefix}_search_skills`) {
        const query = params.query as string;
        const skills = skillsManager.searchSkills(query);
        return { skills, count: skills.length };
    }

    if (name === `${prefix}_get_skill`) {
        const skillName = params.name as string;
        if (!isValidSkillName(skillName)) {
            return { error: 'Invalid skill name' };
        }
        const skill = skillsManager.getSkill(skillName);
        if (!skill) {
            return { error: `Skill '${skillName}' not found` };
        }
        return { skill };
    }

    if (name === `${prefix}_execute_skill`) {
        const skillName = params.name as string;
        if (!isValidSkillName(skillName)) {
            return { error: 'Invalid skill name' };
        }
        const inputs = params.inputs as Record<string, unknown> || {};
        return await skillsManager.executeSkill(skillName, inputs, { sessionId: ctx?.sessionId });
    }

    if (name === `${prefix}_create_skill`) {
        const skillName = params.name as string;
        if (!isValidSkillName(skillName)) {
            return { error: 'Invalid skill name' };
        }
        const rawInputs = params.inputs as Array<{
            name: string;
            type: 'string' | 'number' | 'boolean' | 'object' | 'array';
            description?: string;
            required?: boolean;
            default?: unknown;
        }> || [];

        const normalizedInputs = rawInputs.map(input => ({
            name: input.name,
            type: input.type,
            description: input.description,
            required: input.required ?? true,
            default: input.default,
        }));

        const skill = skillsManager.createSkill({
            name: skillName,
            description: params.description as string,
            code: params.code as string,
            version: '1.0.0',
            category: params.category as SkillCategory | undefined,
            inputs: normalizedInputs,
            tags: (params.tags as string[]) || [],
            mcpDependencies: params.mcpDependencies as Array<{ toolPattern: string; description?: string; required: boolean }> || [],
            chainOfThought: params.chainOfThought as string | undefined,
            antiHallucination: params.antiHallucination as string[] || [],
            verificationChecklist: params.verificationChecklist as string[] || [],
        });
        return { success: true, skill };
    }

    if (name === `${prefix}_get_skill_categories`) {
        const stats = skillsManager.getCategoryStats();
        const categories = Object.entries(SKILL_CATEGORIES).map(([key, value]) => ({
            id: key,
            ...value,
            count: stats[key as SkillCategory] || 0,
        }));
        return { categories };
    }

    if (name === `${prefix}_search_skills_advanced`) {
        return {
            skills: skillsManager.searchSkills({
                query: params.query as string,
                category: params.category as SkillCategory,
                tags: params.tags as string[],
                source: params.source as 'workspace' | 'external' | 'all',
                limit: params.limit as number,
            }),
        };
    }

    if (name === `${prefix}_execute_skill_chain`) {
        const skillNames = params.skillNames as string[];
        const initialInputs = params.inputs as Record<string, unknown> || {};
        return await skillsManager.executeSkillChain(skillNames, initialInputs, { sessionId: ctx?.sessionId });
    }

    if (name === `${prefix}_import_skill`) {
        const skillName = params.name as string;
        const skill = await skillsManager.importSkill(skillName);
        return { success: true, skill };
    }

    if (name === `${prefix}_sync_external_skills`) {
        const results = await skillsManager.syncExternalSkills();
        return { success: true, results };
    }

    if (name === `${prefix}_get_skill_templates`) {
        const templates = skillsManager.getTemplates();
        return { templates };
    }

    if (name === `${prefix}_create_skill_from_template`) {
        const { templateName, skillName, customizations } = params as {
            templateName: string;
            skillName: string;
            customizations?: Record<string, unknown>;
        };
        const skill = skillsManager.createFromTemplate(templateName, skillName, customizations);
        return { success: true, skill };
    }

    if (name === `${prefix}_get_external_paths`) {
        return { paths: skillsManager.getExternalPaths() };
    }

    if (name === `${prefix}_add_external_path`) {
        const path = params.path as string;
        skillsManager.addExternalPath(path);
        return { success: true, path };
    }

    return undefined; // Not handled
}
