# sql-analyzer

Analyzes SQL queries for anti-patterns, performance issues, and suggests optimizations.

## Metadata
- **Version**: 1.0.0
- **Category**: database
- **Source**: workspace


## Tags
`sql`, `database`, `performance`, `optimization`

## MCP Dependencies
None specified

## Inputs
- `query` (string) (required): SQL query to analyze
- `dialect` (string) (optional): SQL dialect: mssql, postgres, mysql



## Workflow
No workflow defined

## Anti-Hallucination Rules
None specified

## Verification Checklist
None specified

## Usage

```typescript
// Execute via MCP Gateway:
gateway_execute_skill({ name: "sql-analyzer", inputs: { ... } })

// Or via REST API:
// POST /api/code/skills/sql-analyzer/execute
// Body: { "inputs": { ... } }
```



## Code

```typescript

const { query, dialect = 'mssql' } = inputs;
const upperQuery = query.toUpperCase();

const issues = [];

// Check for SELECT *
if (/SELECT\s+\*/.test(upperQuery)) {
  issues.push({ severity: 'medium', issue: 'SELECT * retrieves all columns', fix: 'List only needed columns' });
}

// Check for missing WHERE on UPDATE/DELETE
if (/(UPDATE|DELETE)\s+\w+/.test(upperQuery) && !/WHERE/.test(upperQuery)) {
  issues.push({ severity: 'critical', issue: 'UPDATE/DELETE without WHERE', fix: 'Add WHERE clause' });
}

// Check for leading wildcard LIKE
if (/LIKE\s+['"]%/.test(upperQuery)) {
  issues.push({ severity: 'high', issue: 'LIKE with leading wildcard prevents index usage', fix: 'Use full-text search or remove leading wildcard' });
}

// Check for ORDER BY ordinal
if (/ORDER\s+BY\s+\d+/.test(upperQuery)) {
  issues.push({ severity: 'low', issue: 'ORDER BY with ordinal position', fix: 'Use column names' });
}

// Complexity score
let score = 1;
const joinCount = (upperQuery.match(/\bJOIN\b/g) || []).length;
score += joinCount * 2;
const subqueryCount = (upperQuery.match(/SELECT/g) || []).length - 1;
score += subqueryCount * 3;

let result = `# SQL Analysis\n\n`;
result += `**Complexity**: ${score < 5 ? 'Low' : score < 10 ? 'Medium' : 'High'} (${score}/10)\n\n`;

if (issues.length === 0) {
  result += '✅ No significant issues found\n';
} else {
  result += `## Issues (${issues.length})\n\n`;
  for (const i of issues) {
    const icon = i.severity === 'critical' ? '🔴' : i.severity === 'high' ? '🟡' : '🟢';
    result += `${icon} **${i.severity.toUpperCase()}**: ${i.issue}\n   Fix: ${i.fix}\n\n`;
  }
}

console.log(result);

```

---
Created: Mon Dec 22 2025 10:35:19 GMT+0800 (Singapore Standard Time)
Updated: Mon Dec 22 2025 10:35:19 GMT+0800 (Singapore Standard Time)
