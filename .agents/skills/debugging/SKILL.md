---
name: debugging
description: Systematic debugging protocol for finding and fixing bugs. Activates for "debug", "fix bug", "not working", "error", "broken", "issue", "fails", "crash", "undefined", "null" problems.
allowed-tools: [Read, Grep, Glob, Bash, LSP, Edit, Task]
---

# Debugging Protocol

## When This Skill Activates
- "Debug this", "fix this bug", "not working"
- Error messages, stack traces
- "Undefined", "null", "crash", "fails"
- Unexpected behavior
- Performance issues

## Anti-Hallucination Rules (NEVER violate)

| Rule | Description |
|------|-------------|
| **CONFIRM ENVIRONMENT** | ALWAYS confirm target system/environment FIRST. Ask: "Which system? Which environment?" Never assume D365 vs Maximo vs Fabric vs local |
| **EVIDENCE BEFORE CONCLUSIONS** | NEVER state a root cause without showing concrete evidence (logs, data, diffs). Show findings FIRST, then interpretation |
| **SCHEMA FIRST** | When debugging database issues, ALWAYS check actual table schemas before writing queries. Never assume column names |
| **RIGHT FILE, RIGHT PATH** | ALWAYS verify you're editing the correct file. Local vs remote? Config vs code? Check for secondary config files |
| **NO PREMATURE FIXES** | Don't fix without understanding. Gather evidence, form hypothesis, THEN fix. Never "try and see" without a hypothesis |
| **STOP CONDITIONS** | If your approach isn't working after 3 attempts, STOP and pivot. Don't retry the same failing approach |

## Systematic Debugging Process

### Phase 0: Confirm Context (MANDATORY - Do This First)
Before ANY debugging action:
```
1. Which system/environment is this? (D365? Maximo? Fabric? Local app? VPS? Production?)
   - If unclear, ASK the user. Never assume.
2. What is the user's expected output? (Fix? Root cause analysis? Report?)
3. Are there multiple config files? (Check for .env, config.json, secondary configs)
4. Am I looking at the right file/path? (Local vs remote? Which branch?)
```

### Phase 1: Reproduce
Before fixing anything:
```
1. Can I reproduce the bug consistently?
2. What are the exact steps to trigger it?
3. What is the expected behavior?
4. What is the actual behavior?
5. What error message/log output do I see? (Show it BEFORE interpreting)
```

### Phase 2: Isolate
Narrow down the problem:
```
1. When did it last work? (check git history)
2. What changed recently? (git diff, git log)
3. Is it specific to certain inputs?
4. Does it happen in all environments?
```

### Phase 3: Investigate
Gather concrete evidence:

#### Read the Error Message Carefully
```
Error: Cannot read property 'map' of undefined
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
       This tells you: something is undefined that should be an array

at UserList.render (UserList.tsx:15:23)
   ^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^
   Component name    File and line number
```

#### Key Investigation Commands
```bash
# Find where variable is defined
grep -r "variableName" --include="*.ts" -n

# Find where function is called
grep -r "functionName(" --include="*.ts" -n

# Check git history for recent changes
git log --oneline -20
git diff HEAD~5 -- path/to/file

# Find related tests
find . -name "*.test.ts" | xargs grep "FunctionName"
```

#### For Database Issues (MANDATORY schema check)
```sql
-- ALWAYS check schema before querying
SELECT TOP 1 * FROM [table_name];
-- Or use MCP: fabric_get_lakehouse_table_schema, etc.
-- NEVER assume column names exist
```

### Phase 4: Hypothesize
Form specific, evidence-backed hypotheses:
```
NOT: "Something is wrong with the data"
YES: "The API returns null when user has no orders, but we expect an empty array"

NOT: "User X probably changed this"
YES: "git blame shows line 45 was changed in commit abc123 on Jan 5 by [user]"
```

**Show your evidence to the user before proposing causes.**

### Phase 5: Test Hypothesis
Add strategic logging or run targeted queries:
```typescript
// Before the error
console.log('DEBUG: data before map:', JSON.stringify(data, null, 2));
console.log('DEBUG: data type:', typeof data, Array.isArray(data));
```

### Phase 6: Fix
Apply minimal, targeted fix:
```typescript
// BAD: Overly broad fix
const items = data?.items?.map?.(x => x) ?? [];

// GOOD: Fix the actual problem at its source
if (!data.items) {
  throw new Error('Expected items array but got: ' + typeof data.items);
}
```

**After fixing:**
1. Verify the fix works (run test, check output, show proof)
2. Check for secondary config files or related files that may also need changes
3. Run existing tests to check for regressions
4. Show the user proof the fix works before declaring done

## Common Bug Patterns

### 1. Undefined/Null Access
```typescript
// BUG
user.profile.name  // crashes if profile is undefined

// FIX
user?.profile?.name  // safe access
// OR
if (!user?.profile) throw new Error('User profile required');
```

### 2. Async/Await Issues
```typescript
// BUG: Missing await
const data = fetchData();  // Returns Promise, not data
console.log(data.items);   // undefined

// FIX
const data = await fetchData();
```

### 3. State Race Conditions
```typescript
// BUG: State not updated yet
setCount(count + 1);
console.log(count);  // Still old value

// FIX: Use callback form
setCount(prev => prev + 1);
```

### 4. Closure Stale Values
```typescript
// BUG: Stale closure
useEffect(() => {
  const interval = setInterval(() => {
    console.log(count);  // Always logs initial value
  }, 1000);
}, []);  // Missing dependency

// FIX
useEffect(() => {
  const interval = setInterval(() => {
    console.log(count);
  }, 1000);
  return () => clearInterval(interval);
}, [count]);  // Add dependency
```

### 5. Off-by-One Errors
```typescript
// BUG
for (let i = 0; i <= array.length; i++)  // Goes one too far

// FIX
for (let i = 0; i < array.length; i++)
```

### 6. Type Coercion
```typescript
// BUG
if (value == 0)   // "" == 0 is true!
if (value == "")  // 0 == "" is true!

// FIX
if (value === 0)
if (value === "")
```

### 7. Wrong File / Wrong Environment
```
// BUG: Editing local file when user means remote VPS config
// BUG: Editing .env when the app reads from config.json
// BUG: Editing the right file on the wrong branch

// FIX: Always confirm file path and environment in Phase 0
```

## Debugging Tools

### Console Methods
```typescript
console.log(variable);                    // Basic output
console.table(arrayOfObjects);            // Formatted table
console.trace();                          // Stack trace
console.time('label'); /* code */ console.timeEnd('label');  // Timing
console.group('Section'); /* logs */ console.groupEnd();     // Grouping
```

### Node.js Debugging
```bash
# Start with inspector
node --inspect dist/index.js

# Break on first line
node --inspect-brk dist/index.js

# Then open Chrome DevTools at chrome://inspect
```

### React DevTools
- Components tab: Inspect props/state
- Profiler tab: Find re-render issues

## Performance Debugging

### Identify Slow Code
```typescript
console.time('operation');
// ... code to measure
console.timeEnd('operation');
```

### Memory Leaks
```typescript
// Common causes:
// 1. Uncleared intervals/timeouts
// 2. Event listeners not removed
// 3. Closures holding references
// 4. Growing arrays/maps

// Fix: Always cleanup
useEffect(() => {
  const handler = () => {};
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);  // Cleanup!
}, []);
```

## Bug Report Format
When documenting bugs:
```markdown
## Bug: [Short description]

### Steps to Reproduce
1. [Step 1]
2. [Step 2]
3. [Step 3]

### Expected Behavior
[What should happen]

### Actual Behavior
[What actually happens]

### Environment
- System: [D365/Maximo/Fabric/Local/VPS]
- OS: [macOS/Windows/Linux]
- Node: [version]
- Browser: [if applicable]

### Evidence Gathered
[Logs, query results, diffs — concrete data]

### Root Cause
[After investigation, with evidence reference]

### Fix
[Solution applied]

### Verification
[Proof that fix works]
```

## Verification Checklist
- [ ] Environment/system confirmed with user (Phase 0 complete)
- [ ] Bug reproduced with specific steps
- [ ] Evidence gathered before any conclusions stated
- [ ] Root cause identified with supporting evidence
- [ ] Fix is minimal and targeted (no unrelated changes)
- [ ] Fix verified to work (test output shown)
- [ ] No regressions introduced (existing tests pass)
- [ ] Secondary config files checked

## Key Principle
**Confirm context. Gather evidence. Show findings before conclusions. Fix what's proven broken.** Don't guess, don't assume which system, don't attribute causes without diffs. The bug tells you what's wrong if you listen — but only after you've confirmed you're looking at the right system.
