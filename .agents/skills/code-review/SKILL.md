---
name: code-review
description: Comprehensive code review for security, performance, and maintainability. Activates when asked to "review code", "check this code", "audit", "find bugs", "security review", or when reviewing PRs or diffs.
allowed-tools: [Read, Grep, Glob, LSP, Task]
---

# Code Review Protocol

## When This Skill Activates
- "Review this code", "check this", "audit this"
- "Find bugs", "find issues", "what's wrong with this"
- "Security review", "performance review"
- PR reviews, diff reviews
- Before committing significant changes

## Review Checklist

### 1. Security (CRITICAL - Check First)
```
[ ] SQL Injection: Are queries parameterized?
[ ] XSS: Is user input escaped before rendering?
[ ] Auth: Are endpoints properly protected?
[ ] Secrets: Any hardcoded keys, passwords, tokens?
[ ] SSRF: Are URLs validated before fetching?
[ ] Path Traversal: Are file paths sanitized?
[ ] Dependency: Any known vulnerable packages?
```

**Red Flags to Search For:**
```typescript
// DANGEROUS - search for these patterns
eval(                    // Code injection
dangerouslySetInnerHTML  // XSS risk
innerHTML =              // XSS risk
exec(                    // Command injection
child_process            // Command injection
fs.readFile(userInput    // Path traversal
SELECT.*\$\{             // SQL injection
.env                     // Exposed secrets
password.*=.*["']        // Hardcoded secrets
```

### 2. Performance
```
[ ] N+1 Queries: Database calls in loops?
[ ] Missing Indexes: Queries on unindexed columns?
[ ] Memory Leaks: Uncleared intervals/listeners?
[ ] Unbounded Data: Pagination for large datasets?
[ ] Blocking Operations: Sync I/O in async context?
[ ] Unnecessary Re-renders: React memo/useMemo needed?
```

**Patterns to Check:**
```typescript
// PERFORMANCE ISSUES
for (const item of items) {
  await db.query(...)     // N+1 - batch this
}

useEffect(() => {
  const interval = setInterval(...)
  // Missing cleanup - memory leak
}, [])

const data = await fetchAll()  // Unbounded - add limit
```

### 3. Maintainability
```
[ ] Naming: Are variables/functions clearly named?
[ ] Complexity: Any function > 50 lines?
[ ] Duplication: Same logic in multiple places?
[ ] Error Handling: Are errors caught and handled?
[ ] Types: Are TypeScript types specific (not `any`)?
[ ] Comments: Is complex logic explained?
```

### 4. Logic Errors
```
[ ] Off-by-one: Array bounds, loop conditions
[ ] Null checks: Optional chaining where needed?
[ ] Race conditions: Concurrent state mutations?
[ ] Edge cases: Empty arrays, null values, zero?
```

## Review Output Format

```markdown
## Code Review: [File/Feature Name]

### Critical Issues (Must Fix)
1. **[SECURITY]** Line X: [Issue description]
   - Risk: [What could happen]
   - Fix: [How to fix]

### Warnings (Should Fix)
1. **[PERFORMANCE]** Line X: [Issue description]
   - Impact: [Why it matters]
   - Fix: [How to fix]

### Suggestions (Nice to Have)
1. **[MAINTAINABILITY]** Line X: [Suggestion]

### What's Good
- [Positive observation 1]
- [Positive observation 2]

### Summary
[1-2 sentence overall assessment]
```

## Review Commands

Before reviewing, gather context:
```bash
# Find related files
grep -r "FunctionName" --include="*.ts"

# Check for tests
find . -name "*.test.ts" -o -name "*.spec.ts"

# Look for similar patterns
grep -r "pattern" --include="*.ts" | head -20
```

## Key Principle
Be specific and actionable. "This could be better" is useless. "Line 42: Use parameterized query to prevent SQL injection" is useful.
