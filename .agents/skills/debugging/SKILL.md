---
name: debugging
description: Systematic debugging protocol for finding and fixing bugs. Activates for "debug", "fix bug", "not working", "error", "broken", "issue", "fails", "crash", "undefined", "null" problems. Hardened against 169 sessions of real-world friction data.
allowed-tools: [Read, Grep, Glob, Bash, LSP, Edit, Task, SendMessage]
---

# Debugging Protocol (v2 -- Friction-Hardened)

> Built from 169 real sessions. Addresses 38 "wrong approach" events, 30 "buggy code" events,
> 17 "misunderstood request" events. Every rule below exists because it was violated in production.

## When This Skill Activates
- "Debug this", "fix this bug", "not working"
- Error messages, stack traces
- "Undefined", "null", "crash", "fails"
- Unexpected behavior
- Performance issues
- Database query returning wrong data
- "Who changed X?" / audit trail questions

---

## STOP-THINK-ACT Protocol (MANDATORY -- Execute Before EVERY Action)

> **Origin**: 38 sessions had "wrong approach" friction -- Claude jumped to the wrong tool,
> wrong file, or wrong strategy before understanding context. This protocol is non-negotiable.

### STOP -- Before writing code, running commands, or choosing an approach:

| Check | Question | If Unclear |
|-------|----------|------------|
| **System** | Which system/environment is this? Local app? Remote server? Database? | **ASK the user. Never assume.** |
| **Output format** | What format does the user want? SQL? Code fix? Plan document? Working code? | **ASK if ambiguous.** |
| **Target file** | Am I editing the right file? Local vs remote? Config vs code? Is there a secondary config file? | **Verify path before editing.** |
| **Database** | Which database connection? Which server? | **Confirm before querying.** |
| **Branch/Env** | Am I on the right branch? Right environment? | **Check with `git branch` or ask.** |

### THINK -- Before stating conclusions:

| Check | Question | Violation Example |
|-------|----------|-------------------|
| **Evidence** | Do I have concrete evidence? | Saying "User X broke this" without a `git blame` diff |
| **Schema** | Have I verified actual schemas via MCP? | Assuming a column `TransactionDate` exists when it's actually `TRANSDATE` |
| **Scope** | Am I about to explore when I should execute, or code when asked for a plan? | Spending 45 minutes reading files when user wants a one-line fix |
| **Attribution** | Am I about to blame someone/something without proof? | "This was probably caused by the last deployment" -- prove it |

### ACT -- Only after confirming context and approach:

1. Make the **minimal change** needed. Don't refactor surrounding code.
2. **Verify the change works** before declaring done. Show proof.
3. If something fails, **diagnose root cause** -- don't retry the same failing approach.
4. If unsure, **ask the user** rather than guessing.

---

## Anti-Hallucination Rules (NEVER violate)

| Rule | Description | Real Violation |
|------|-------------|----------------|
| **CONFIRM ENVIRONMENT** | ALWAYS confirm target system/environment FIRST. Ask: "Which system? Which environment?" Never assume which system or database | Connected to wrong database because system wasn't confirmed |
| **EVIDENCE BEFORE CONCLUSIONS** | NEVER state a root cause without showing concrete evidence (logs, data, diffs). Show findings FIRST, then interpretation | Claude attributed changes to wrong people without proof |
| **SCHEMA FIRST** | When debugging database issues, ALWAYS check actual table schemas before writing queries. Never assume column names | Claude assumed column names that didn't exist, wasted entire sessions |
| **RIGHT FILE, RIGHT PATH** | ALWAYS verify you're editing the correct file. Local vs remote? Config vs code? Check for secondary config files | Claude edited local file when user meant remote VPS config |
| **NO PREMATURE FIXES** | Don't fix without understanding. Gather evidence, form hypothesis, THEN fix. Never "try and see" without a hypothesis | Claude applied 5 different "fixes" without understanding the actual bug |
| **STOP CONDITIONS** | If your approach isn't working after 3 attempts, STOP and pivot. Don't retry the same failing approach | Claude retried the same broken query 7 times |
| **RESPECT OUTPUT FORMAT** | If user asks for SQL, give SQL. Never silently switch formats | Gave wrong output format when user explicitly asked for a specific one |
| **NO UNPROVEN ATTRIBUTION** | Never say "Person X caused this" or "This happened because of Y" without showing audit trail, git blame, or log evidence | Claude blamed a team member based on assumption, not data |

---

## Multi-System Identification

> When debugging involves multiple systems or databases, always confirm which system
> the user is referring to before querying. Never assume.

### Identify the System First

```
User mentions a bug/issue
        |
        v
Does the user specify a system?
        |
   YES -+-> Use that system
        |
   NO --+-> Look for contextual clues in their message
             |
             +-- Database-related keywords? --> Confirm which database
             +-- Server/infrastructure keywords? --> Confirm which server
             +-- None of the above or ambiguous
                 --> ASK: "Which system should I investigate?"
```

### Schema Verification (MANDATORY)

```
BEFORE writing any query:
  1. Identify target table(s)
  2. Run schema check (SELECT TOP 1 *, sp_columns, or MCP metadata tools)
  3. Verify column names MATCH what you plan to use
  4. Only THEN write the actual query

NEVER skip this step. NEVER assume column names.
```

---

## Anti-Exploration-Spiral Rule

> **Origin**: Claude spent entire sessions exploring without executing fixes.
> Multiple sessions consumed 100% of context just reading files without ever fixing anything.

### The Rule

```
INVESTIGATION BUDGET:
  - Time-box investigation to 3-5 tool calls before forming a hypothesis
  - After 5 exploration calls without a hypothesis: STOP and ask the user
  - After 8 exploration calls total: You MUST have started fixing OR explained to user why not
  - NEVER spend an entire session only exploring/planning when user asked for a fix
```

### Investigation Checkpoints

| Tool Calls Used | Required Action |
|-----------------|----------------|
| **0-3** | Gather evidence freely. Read files, check logs, query data. |
| **3-5** | You should have a working hypothesis by now. State it explicitly. |
| **5-8** | Begin implementing fix based on hypothesis. If no hypothesis, STOP and ask user. |
| **8+** | You MUST be actively fixing, not still exploring. If stuck, say so. |

### Self-Check Questions (Ask Yourself Every 3 Calls)

1. "Do I have enough information to form a hypothesis?" -- If yes, state it and fix.
2. "Am I reading files that are actually relevant, or am I spiraling?" -- If spiraling, stop.
3. "Did the user ask for exploration or a fix?" -- If fix, execute.
4. "Am I repeating the same type of investigation?" -- If yes, try a different angle or ask.

---

## Evidence-Before-Conclusions Enforcement

> **Origin**: 17 "misunderstood request" events. Claude attributed root causes without proof,
> blamed team members without evidence, and stated conclusions before showing data.

### The Evidence Protocol

```
WRONG ORDER (violation):
  1. "The bug is caused by X"          <-- conclusion first
  2. "Let me verify..." (maybe)        <-- evidence after
  3. User has to correct you           <-- friction

RIGHT ORDER (required):
  1. "Let me gather evidence..."       <-- investigate first
  2. "Here's what I found: [data]"     <-- show raw evidence
  3. "Based on this, the cause is X"   <-- evidence-backed conclusion
```

### Attribution Rules

When investigating "who changed X" or "what caused this":

```
NEVER DO:
  "This was probably caused by [person/event]"
  "Someone must have changed..."
  "This looks like it was broken by..."

ALWAYS DO:
  1. Run: git log --oneline -20 -- path/to/file
  2. Run: git blame path/to/file | grep "relevant_line"
  3. Run: git diff <commit_before>..<commit_after> -- path/to/file
  4. SHOW the diff/log output
  5. THEN say: "Commit [hash] by [author] on [date] changed [specific line]. Here's the diff: ..."
```

### Showing Evidence (Templates)

**For code bugs:**
```
Evidence gathered:
- File: [path], line [N]
- Current value: [what the code does]
- Expected value: [what it should do]
- Proof: [test output / error log / stack trace]

Conclusion: [root cause based on above evidence]
```

**For database issues:**
```
Evidence gathered:
- Query: [the query run]
- Result: [actual output, first N rows]
- Expected: [what should have returned]
- Schema check: [confirmed columns exist]

Conclusion: [root cause based on above evidence]
```

**For "who changed this" questions:**
```
Evidence gathered:
- git blame output: [relevant lines]
- Commit: [hash], Author: [name], Date: [date]
- Diff: [what changed]
- Context: [commit message, PR if available]

Conclusion: [factual statement based on git data]
```

---

## Systematic Debugging Process

### Phase 0: STOP-THINK-ACT (MANDATORY -- Do This First)

Before ANY debugging action, execute the full STOP-THINK-ACT protocol above.

**Minimum required confirmations before proceeding:**
```
[ ] System/environment identified (which app? which server? which database?)
[ ] Output format confirmed (SQL? Code fix? Plan? Report?)
[ ] Target file/path verified (correct file, correct server, correct branch)
[ ] Database connection identified (if applicable)
[ ] User's actual request understood (fix? investigate? explain? plan?)
```

If ANY of these are unclear, ASK before proceeding.

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
Narrow down the problem (budget: 3-5 tool calls):
```
1. When did it last work? (check git history)
2. What changed recently? (git diff, git log)
3. Is it specific to certain inputs?
4. Does it happen in all environments?
```

### Phase 3: Investigate
Gather concrete evidence (stay within investigation budget):

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

# Attribution investigation (when asked "who changed X")
git blame path/to/file
git log --oneline --follow -- path/to/file
git diff <old_commit>..<new_commit> -- path/to/file
```

#### For Database Issues (MANDATORY schema check)
```sql
-- STEP 1: ALWAYS check schema before querying
SELECT TOP 1 * FROM [table_name];
-- NEVER assume column names exist

-- STEP 2: Verify the table exists
SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'xyz'

-- STEP 3: Only THEN write your actual diagnostic query
-- Match column names EXACTLY to what schema returned
```

**Database anti-patterns to avoid:**
- Writing a query with assumed column names (ALWAYS schema-check first)
- Querying the wrong database connection when multiple are available
- Forgetting required filters (tenant, site, company ID, etc.)
- Confusing snapshot/cached data with live data

### Phase 4: Hypothesize

**You MUST have a hypothesis by tool call 5. State it explicitly.**

Form specific, evidence-backed hypotheses:
```
NOT: "Something is wrong with the data"
YES: "The API returns null when user has no orders, but we expect an empty array"

NOT: "User X probably changed this"
YES: "git blame shows line 45 was changed in commit abc123 on Jan 5 by [user]"

NOT: "The database might be wrong"
YES: "Column TRANSDATE contains UTC timestamps but the query filters by SGT without conversion"
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

### Phase 7: Verify & Report
```
REQUIRED before declaring "done":
  1. Show the fix applied (diff or code snippet)
  2. Show proof it works (test output, query result, application behavior)
  3. Show no regressions (existing tests still pass)
  4. If database fix: re-run the original failing query to show correct results
```

---

## Parallel Agent Investigation Pattern

> For multi-system issues (e.g., data mismatch between frontend and backend),
> dispatch parallel sub-agents to investigate different systems simultaneously.

### When to Use Parallel Investigation

- Bug involves data flowing between 2+ systems (API -> Database -> Report)
- Need to compare state across environments (prod vs staging)
- Root cause could be in multiple places (frontend AND backend AND database)
- Time pressure -- need to investigate multiple angles at once

### Pattern: Coordinator + Investigators

```
COORDINATOR (you):
  1. Identify which systems/areas need investigation
  2. Dispatch sub-agents with SPECIFIC investigation tasks
  3. Each sub-agent gets:
     - Exact system to investigate
     - Specific questions to answer
     - Investigation budget (max tool calls)
     - Required evidence format
  4. Synthesize findings from all sub-agents
  5. Form unified hypothesis based on all evidence

SUB-AGENT TEMPLATE:
  "Investigate [SYSTEM] for [ISSUE].
   Check: [specific things to look for]
   Return: [evidence format needed]
   Budget: [max N tool calls]
   Do NOT fix anything -- investigation only."
```

### Example: Data Mismatch Between API and Report

```
Sub-agent 1 (Database):
  "Query the primary database for orders in date range X-Y.
   Check: Do the totals match the expected value?
   Return: Row count, total amount, sample of 5 rows."

Sub-agent 2 (Cache/Replica):
  "Query the read replica or cache for same date range.
   Check: Are all records present? Any replication lag?
   Return: Row count, total amount, latest sync timestamp."

Sub-agent 3 (Report):
  "Check the report logic/query.
   Check: Does it filter correctly? Any timezone issues?
   Return: The actual query used and any filter logic."

Coordinator synthesizes:
  "Primary DB has 150 records totaling $X. Replica has 148 -- missing 2 records
   due to replication lag. Report query is correct but reads from replica,
   so it's missing 2 records. Root cause: replication delay, not a bug."
```

---

## Output Format Discipline

> **Origin**: Claude delivered the wrong output format -- gave one language/format when user explicitly asked for another.
> 17 "misunderstood request" events.

### Format Decision Matrix

| User Says | Deliver | NEVER Deliver Instead |
|-----------|---------|----------------------|
| "SQL view" / "write a view" | SQL `CREATE VIEW` statement | A different query language |
| "Fix the bug" / "fix this" | Working code change | Plan document / exploration |
| "Plan" / "design" / "spec" | Plan document | Code implementation |
| "Investigate" / "root cause" | Evidence + analysis | Fix without asking |
| "Query" / "check the data" | Query + results | Just the query without running it |
| Ambiguous | **ASK**: "Do you want me to [option A] or [option B]?" | Guess wrong |

### Self-Check Before Responding

```
Before writing your response, verify:
  [ ] My output format matches what the user asked for
  [ ] If user said "SQL", I'm giving SQL (not something else)
  [ ] If user said "fix", I'm fixing (not just exploring/planning)
  [ ] If user said "plan", I'm planning (not coding)
  [ ] If ambiguous, I'm asking for clarification
```

---

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

### 8. Wrong Database / Wrong System
```
// BUG: Querying the wrong database when multiple are available
// BUG: Using column names from one system in queries for another
// BUG: Forgetting required filters (tenant ID, site ID, company code, etc.)

// FIX: Always confirm which system/database before querying
```

### 9. Timezone / Data Staleness
```
// BUG: Comparing snapshot data with live data without accounting for lag
// BUG: Filtering by local timezone when database stores UTC
// BUG: Missing records because they were created after snapshot cutoff

// FIX: Know your data source's refresh cycle and timezone
```

### 10. Silent Failure / Swallowed Errors
```typescript
// BUG: Error swallowed, appears to "work" but doesn't
try {
  await saveData(data);
} catch (e) {
  // silently fails
}

// FIX: Handle or re-throw
try {
  await saveData(data);
} catch (e) {
  logger.error('Failed to save data:', e);
  throw e;  // Or handle meaningfully
}
```

---

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

### Git Investigation Commands
```bash
# Who changed this line?
git blame path/to/file

# What changed in last 5 commits for this file?
git log --oneline -5 -- path/to/file

# Full diff of what changed
git diff HEAD~5 -- path/to/file

# Find when a specific string was added/removed
git log -S "searchString" --oneline

# Find commits by a specific author
git log --author="name" --oneline -10
```

---

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

### Database Query Performance
```sql
-- Check execution plan
SET SHOWPLAN_TEXT ON;
GO
SELECT ... FROM ...;
GO
SET SHOWPLAN_TEXT OFF;

-- Look for: Table scans (need index), high estimated rows, sort operations
-- Fix: Add indexes, limit result sets, use specific columns instead of SELECT *
```

---

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
- Database: [connection used]
- Branch: [git branch]

### Evidence Gathered
[Logs, query results, diffs -- concrete data, not assumptions]

### Root Cause
[After investigation, with evidence reference -- NOT speculation]

### Fix
[Solution applied -- minimal and targeted]

### Verification
[Proof that fix works -- test output, query results, screenshots]
```

---

## Verification Checklist

- [ ] STOP-THINK-ACT executed (Phase 0 complete)
- [ ] System/environment confirmed with user
- [ ] Output format matches user's request
- [ ] Database schema verified before writing queries (if applicable)
- [ ] Bug reproduced with specific steps
- [ ] Evidence gathered before any conclusions stated
- [ ] Root cause identified with supporting evidence (not speculation)
- [ ] No unproven attribution of blame
- [ ] Fix is minimal and targeted (no unrelated changes)
- [ ] Fix verified to work (test output shown)
- [ ] No regressions introduced (existing tests pass)
- [ ] Secondary config files checked
- [ ] Investigation stayed within budget (not spiraling)

---

## Quick Reference: Friction Prevention

| Friction Type (from 169 sessions) | Prevention Rule |
|-----------------------------------|-----------------|
| **Wrong approach** (38 events) | STOP-THINK-ACT before every action. Confirm system, format, file. |
| **Buggy code** (30 events) | Schema-first for DB. Test hypothesis before fixing. Verify fix works. |
| **Misunderstood request** (17 events) | Confirm output format. ASK if ambiguous. Deliver exactly what was asked for. |
| **Wrong database** | Confirm which database before querying. Never assume. |
| **Wrong file edited** | Verify path: local vs remote? config vs code? correct branch? |
| **Unproven blame** | Show git blame / audit trail data FIRST, then state who changed what. |
| **Exploration spiral** | 3-5 calls to hypothesis. 5-8 calls to fixing. Never all-explore sessions. |
| **Format mismatch** | Check Format Decision Matrix. Deliver what was asked for. |
| **Assumed column names** | MANDATORY schema check before any database query. |
| **Retried same failure** | After 3 failed attempts at same approach, STOP and pivot strategy. |

---

## Key Principle

**STOP before acting. Confirm context. Gather evidence. Show findings before conclusions. Fix what's proven broken.**

Don't guess. Don't assume which system. Don't attribute causes without diffs. Don't explore when asked to fix. Don't deliver the wrong format. The bug tells you what's wrong if you listen -- but only after you've confirmed you're looking at the right system, the right file, and the right data.
