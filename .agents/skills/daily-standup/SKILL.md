# daily-standup

Generates daily standup reports from accomplishments, plans, and blockers.

## Metadata
- **Version**: 1.0.0
- **Category**: productivity
- **Source**: workspace


## Tags
`standup`, `agile`, `productivity`

## MCP Dependencies
None specified

## Inputs
- `accomplishments` (array) (required): Yesterday's accomplishments
- `planned` (array) (required): Today's plan
- `blockers` (array) (optional): Current blockers



## Workflow
No workflow defined

## Anti-Hallucination Rules
None specified

## Verification Checklist
None specified

## Usage

```typescript
// Execute via MCP Gateway:
gateway_execute_skill({ name: "daily-standup", inputs: { ... } })

// Or via REST API:
// POST /api/code/skills/daily-standup/execute
// Body: { "inputs": { ... } }
```



## Code

```typescript

const { accomplishments, planned, blockers = [] } = inputs;
const date = new Date().toISOString().split('T')[0];

let report = `# Daily Standup - ${date}\n\n## ✅ Yesterday\n`;
for (const a of accomplishments) report += `- ${a}\n`;

report += `\n## 📋 Today\n`;
for (const p of planned) report += `- ${p}\n`;

if (blockers.length > 0) {
  report += `\n## 🚧 Blockers\n`;
  for (const b of blockers) report += `- ${b}\n`;
}

console.log(report);

```

---
Created: Mon Dec 22 2025 10:36:14 GMT+0800 (Singapore Standard Time)
Updated: Mon Dec 22 2025 10:36:14 GMT+0800 (Singapore Standard Time)
