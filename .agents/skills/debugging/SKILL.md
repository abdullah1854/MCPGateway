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

## Systematic Debugging Process

### Phase 1: Reproduce
Before fixing anything:
```
1. Can I reproduce the bug consistently?
2. What are the exact steps to trigger it?
3. What is the expected behavior?
4. What is the actual behavior?
```

### Phase 2: Isolate
Narrow down the problem:
```
1. When did it last work? (check git history)
2. What changed recently?
3. Is it specific to certain inputs?
4. Does it happen in all environments?
```

### Phase 3: Investigate

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

### Phase 4: Hypothesize
Form specific hypotheses:
```
NOT: "Something is wrong with the data"
YES: "The API returns null when user has no orders, but we expect an empty array"
```

### Phase 5: Test Hypothesis
Add strategic logging:
```typescript
// Before the error
console.log('DEBUG: data before map:', JSON.stringify(data, null, 2));
console.log('DEBUG: data type:', typeof data, Array.isArray(data));

// Or use conditional breakpoints in debugger
```

### Phase 6: Fix
Apply minimal fix:
```typescript
// BAD: Overly broad fix
const items = data?.items?.map?.(x => x) ?? [];

// GOOD: Fix the actual problem
if (!data.items) {
  throw new Error('Expected items array but got: ' + typeof data.items);
}
// Or handle the null case explicitly where data is fetched
```

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
- OS: [macOS/Windows/Linux]
- Node: [version]
- Browser: [if applicable]

### Error Message
```
[Full error message and stack trace]
```

### Root Cause
[After investigation]

### Fix
[Solution applied]
```

## Key Principle
Don't guess. Gather evidence. Form hypotheses. Test them. The bug tells you what's wrong if you listen.
