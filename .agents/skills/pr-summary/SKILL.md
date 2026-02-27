# pr-summary

Creates comprehensive Pull Request summaries with changes, test plan, and related issues.

## Metadata
- **Version**: 1.0.0
- **Category**: git-workflow
- **Source**: workspace


## Tags
`git`, `pull-request`, `github`

## MCP Dependencies
None specified

## Inputs
- `title` (string) (required): PR title
- `changes` (array) (required): List of changes made
- `testPlan` (array) (optional): Test plan items
- `issues` (array) (optional): Related issue numbers



## Workflow
No workflow defined

## Anti-Hallucination Rules
None specified

## Verification Checklist
None specified

## Usage

```typescript
// Execute via MCP Gateway:
gateway_execute_skill({ name: "pr-summary", inputs: { ... } })

// Or via REST API:
// POST /api/code/skills/pr-summary/execute
// Body: { "inputs": { ... } }
```



## Code

```typescript

const { title, changes, testPlan = ['Verify tests pass', 'Manual testing'], issues = [] } = inputs;

let pr = `## Summary\n${title}\n\n## Changes\n`;
for (const c of changes) pr += `- ${c}\n`;

pr += `\n## Test Plan\n`;
for (const t of testPlan) pr += `- [ ] ${t}\n`;

if (issues.length > 0) {
  pr += `\n## Related Issues\n`;
  for (const i of issues) pr += `- Closes #${i}\n`;
}

pr += `\n---\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

console.log(pr);

```

---
Created: Mon Dec 22 2025 10:36:14 GMT+0800 (Singapore Standard Time)
Updated: Mon Dec 22 2025 10:36:14 GMT+0800 (Singapore Standard Time)
