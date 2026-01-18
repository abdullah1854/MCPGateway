---
name: skill-creator
description: Create new Claude Code skills with proper structure and best practices. Activates for "create skill", "new skill", "build skill", "skill template", "SKILL.md".
allowed-tools: [Read, Write, Bash, Glob, Grep]
---

# Skill Creator - Meta Skill

## When This Skill Activates
- "Create a new skill", "build a skill"
- "Skill template", "SKILL.md format"
- "How to make a skill", "skill best practices"
- "Add a new capability"

## Core Concept

Skills are **modular instruction packages** that extend Claude's capabilities for specific domains. They function as onboarding guides, transforming Claude into a specialized agent.

## Skill Structure

```
skill-name/
├── SKILL.md              # Required: Instructions + metadata
└── resources/            # Optional: Additional files
    ├── scripts/          # Executable code
    ├── references/       # Reference material
    └── assets/           # Templates, examples
```

## SKILL.md Template

```markdown
---
name: skill-name
description: Clear, keyword-rich description. Activates for "keyword1", "keyword2", "use case".
allowed-tools: [Read, Write, Bash, Task]
---

# Skill Name

## When This Skill Activates
- Trigger phrase 1
- Trigger phrase 2
- Use case description

## Core Workflow

### Step 1: [Action]
[Detailed instructions]

### Step 2: [Action]
[Detailed instructions]

## Patterns & Templates

### Pattern 1
\`\`\`language
[Code or template]
\`\`\`

## Checklists

### Before Starting
- [ ] Prerequisite 1
- [ ] Prerequisite 2

### After Completion
- [ ] Verification 1
- [ ] Verification 2

## Common Issues

| Issue | Solution |
|-------|----------|
| Problem 1 | Fix 1 |
| Problem 2 | Fix 2 |

## Output Format

\`\`\`markdown
## [Skill Name]: [Action Taken]

### Input
[What was provided]

### Actions
1. [Action 1]
2. [Action 2]

### Output
[Results]
\`\`\`
```

## Design Principles

### 1. Concise Context Use
> "The context window is a public good."

Only include information Claude doesn't already possess:
- Domain-specific terminology
- Unique workflows
- Anti-patterns to avoid
- Verification checklists

**DON'T include:**
- General programming knowledge
- Common library usage
- Things Claude already knows

### 2. Appropriate Freedom Levels

| Task Type | Instruction Style |
|-----------|-------------------|
| Fragile workflows (financial, security) | Strict, step-by-step |
| Creative tasks | Loose guidelines, principles |
| Technical implementation | Patterns + flexibility |

### 3. Progressive Disclosure

Skills load in three stages:
1. **Metadata** (~100 words) - Name, description for matching
2. **Instructions** (<5k words) - Full SKILL.md when triggered
3. **Resources** (as needed) - Reference files on demand

### 4. Keyword-Rich Descriptions

The description field powers auto-activation. Include:
- Primary keywords (tool name, domain)
- Action verbs (create, debug, analyze)
- Use cases ("when building", "for troubleshooting")

```yaml
# GOOD - Multiple activation paths
description: Debug D365 Finance & Operations issues. Activates for "D365", "Dynamics", "voucher", "posting error", "batch job stuck".

# BAD - Too narrow
description: Helps with D365.
```

## Creation Workflow

### Step 1: Understand the Domain
```
1. What problem does this skill solve?
2. What are the key workflows?
3. What mistakes do people make?
4. What would an expert do differently?
```

### Step 2: Gather Examples
```
1. Collect 5-10 concrete examples
2. Identify common patterns
3. Note edge cases and gotchas
4. Document anti-patterns
```

### Step 3: Structure the Skill
```
1. Write the trigger descriptions
2. Define the core workflow steps
3. Add code patterns/templates
4. Create verification checklists
5. Document common issues
```

### Step 4: Test & Iterate
```
1. Try different trigger phrases
2. Verify workflow completeness
3. Check for missing edge cases
4. Validate output format
```

## Quality Checklist

```
[ ] Name is lowercase-hyphenated (skill-name)
[ ] Description is keyword-rich (50-150 chars)
[ ] Triggers cover common phrasings
[ ] Workflow is actionable, not just documentation
[ ] Includes verification/output format
[ ] Under 500 lines (split to resources if larger)
[ ] No generic knowledge Claude already has
[ ] Examples are concrete, not abstract
```

## Adding to Activation Hook

After creating a skill, add triggers to `.claude/hooks/skill-activation.mjs`:

```javascript
{
  name: 'skill-name',
  triggers: [
    /keyword1/i,
    /keyword2/i,
    /phrase\s*pattern/i,
  ],
  description: 'What this skill does'
}
```

## Output Format

```markdown
## Skill Created: [skill-name]

### Location
.claude/skills/[skill-name]/SKILL.md

### Triggers
- "trigger phrase 1"
- "trigger phrase 2"

### Workflow Steps
1. [Step 1]
2. [Step 2]

### Next Steps
1. Add triggers to skill-activation.mjs
2. Test with sample prompts
3. Iterate based on usage
```
