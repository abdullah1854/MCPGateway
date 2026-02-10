---
name: test-driven-fix
description: Test-first debugging loop that reproduces bugs with failing tests, then iterates until tests pass. Activates for "write a test first", "test-driven fix", "TDD fix", "reproduce with test", "make it pass", or when fixing bugs that have an existing test suite.
allowed-tools: [Read, Grep, Glob, Bash, Edit, Write, Task]
---

# Test-Driven Fix Protocol

## When This Skill Activates
- "Write a test first", "fix with TDD", "test-driven fix"
- "Reproduce with a test", "make the tests pass"
- Bug fixes where a test suite already exists
- Iterative fix cycles where verification is automated
- After 2+ failed fix attempts on the same bug (escalation)

## Anti-Hallucination Rules (NEVER violate)

| Rule | Description |
|------|-------------|
| **TEST MUST FAIL FIRST** | Never skip the "reproduce" step. The test MUST fail before you fix anything, proving it captures the bug |
| **MINIMAL FIX ONLY** | Fix the bug, not the neighborhood. Don't refactor, don't add features, don't "improve" surrounding code |
| **NO BLIND RETRIES** | If a fix doesn't work, DIAGNOSE why before trying again. Never retry the same approach |
| **EVIDENCE AT EVERY STEP** | Show test output at each phase. User should see: failing test → diagnosis → fix → passing test |
| **FULL SUITE AFTER FIX** | After your fix passes the targeted test, run the FULL test suite. No regressions allowed |
| **3-ATTEMPT LIMIT** | If 3 fix attempts fail, STOP and escalate to the user with findings so far |

## The Loop: REPRODUCE → DIAGNOSE → FIX → VALIDATE

### Phase 1: REPRODUCE (Write or Identify Failing Test)

**If tests already exist:**
```bash
# Run existing tests to identify failures
npm test          # or: bun test, pytest, cargo test, etc.

# Isolate the specific failing test
npm test -- --grep "test name"
```

**If no test captures the bug, write one:**
```typescript
// The test MUST:
// 1. Set up the exact conditions that trigger the bug
// 2. Assert the EXPECTED behavior (what should happen)
// 3. FAIL with the current code (proving it catches the bug)

describe('BugDescription', () => {
  it('should [expected behavior] when [condition]', () => {
    // Arrange: set up the bug conditions
    const input = /* exact input that triggers the bug */;

    // Act: run the code
    const result = functionUnderTest(input);

    // Assert: what SHOULD happen (this will fail now)
    expect(result).toBe(expectedValue);
  });
});
```

**Run the test — it MUST fail:**
```bash
npm test -- --grep "BugDescription"
# Expected: FAIL (this proves the test captures the bug)
```

If the test passes immediately, your test doesn't capture the bug. Rewrite it.

### Phase 2: DIAGNOSE (Understand Root Cause)

Before writing any fix:
```
1. Read the failing test output carefully
2. Read the relevant source code (use Read, Grep, Glob)
3. Trace the execution path from input to failure point
4. Form a specific hypothesis:
   - NOT: "something is wrong"
   - YES: "fetchUser returns null when id=0 because the falsy check treats 0 as missing"
5. Document your hypothesis before proceeding
```

**Use TodoWrite to track your diagnosis:**
```
[ ] Identified failing test and its assertion
[ ] Read source code at failure point
[ ] Formed specific hypothesis with evidence
[ ] Planned minimal fix
```

### Phase 3: FIX (Implement Minimal Change)

Apply the smallest possible change that addresses the root cause:
```
- Change ONLY the lines needed to fix the bug
- Do NOT refactor surrounding code
- Do NOT add "nice-to-have" improvements
- Do NOT change unrelated files
- If fix requires changes in multiple files, verify each file path before editing
```

### Phase 4: VALIDATE (Run Tests)

**Step 1: Run the targeted test**
```bash
npm test -- --grep "BugDescription"
# Expected: PASS
```

**Step 2: Run the full test suite**
```bash
npm test
# Expected: ALL PASS (no regressions)
```

**Step 3: If targeted test fails → back to Phase 2**
```
- Do NOT retry the same fix
- Re-read the test output
- What's different from your hypothesis?
- Form a NEW hypothesis based on the new evidence
- Track attempt number (max 3 before escalation)
```

**Step 4: If full suite has regressions → adjust fix**
```
- Read the newly failing tests
- Your fix broke something else
- Adjust fix to handle both cases
- Re-run full suite
```

**Step 5: Only when ALL tests pass:**
```bash
# Commit with descriptive message
git add [specific files]
git commit -m "fix: [description of what was fixed and why]"
```

## Attempt Tracking

Track each fix attempt:

```markdown
### Attempt 1
- Hypothesis: [what you thought was wrong]
- Fix applied: [what you changed]
- Result: FAIL — [why it failed]
- Learning: [what you learned]

### Attempt 2
- Hypothesis: [updated hypothesis based on attempt 1]
- Fix applied: [different approach]
- Result: PASS/FAIL
```

After 3 failed attempts:
```markdown
### Escalation
- Bug: [description]
- 3 attempts tried: [summary]
- Evidence gathered: [what we know]
- Remaining hypotheses: [what hasn't been tried]
- Recommendation: [suggested next step]
```

## Framework-Specific Commands

| Framework | Run All | Run Specific | Watch Mode |
|-----------|---------|-------------|------------|
| Jest | `npm test` | `npm test -- --grep "name"` | `npm test -- --watch` |
| Vitest | `npx vitest` | `npx vitest -t "name"` | `npx vitest --watch` |
| Bun | `bun test` | `bun test --grep "name"` | N/A |
| Pytest | `pytest` | `pytest -k "name"` | `pytest-watch` |
| Cargo | `cargo test` | `cargo test test_name` | `cargo watch -x test` |
| Playwright | `npx playwright test` | `npx playwright test -g "name"` | N/A |

## Integration with LISA

For automated iteration, this skill pairs with LISA:
```bash
# LISA automates the loop with verification
npm run lisa -- "Fix [bug description]" --verify "npm test" --max 5
```

LISA will:
1. Attempt the fix
2. Run `--verify` command
3. If fail: capture error, try different approach
4. Loop until pass or max iterations

## Verification Checklist
- [ ] Failing test exists that reproduces the bug (test fails before fix)
- [ ] Root cause diagnosed with specific hypothesis and evidence
- [ ] Fix is minimal (only touches code needed to fix the bug)
- [ ] Targeted test now passes
- [ ] Full test suite passes (no regressions)
- [ ] Fix committed with descriptive message
- [ ] If 3 attempts failed: escalated to user with findings

## Key Principle
**The test is your contract.** Write a test that fails because of the bug, then make it pass with the smallest possible change. If you can't make it pass in 3 attempts, you don't understand the bug well enough yet — escalate with your evidence, don't keep guessing.
