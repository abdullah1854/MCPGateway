# code-review

Comprehensive code review for pull requests using parallel agents. Reviews for CLAUDE.md compliance, bugs, historical context, previous PR comments, and code comment guidance.

## Metadata
- **Version**: 2.0.0
- **Category**: code-quality
- **Source**: anthropic-official
- **License**: MIT

## Tags
`code-review`, `pr-review`, `security`, `bugs`, `claude-md`, `agents`

## MCP Dependencies
- GitHub CLI (`gh`) for PR interaction

## Inputs
- `pr_number` (string) (optional): Pull request number to review
- `confidence_threshold` (number) (optional): Minimum confidence to report (default: 80)

## Review Process

### Phase 1: Eligibility Check (Haiku Agent)
Check if the PR:
- Is closed
- Is a draft
- Doesn't need review (automated or very simple)
- Already has a code review from earlier

If any condition is true, do not proceed.

### Phase 2: CLAUDE.md Discovery (Haiku Agent)
Find all relevant CLAUDE.md files:
- Root CLAUDE.md (if exists)
- CLAUDE.md files in directories whose files the PR modified

### Phase 3: PR Summary (Haiku Agent)
View the pull request and return a summary of the change.

### Phase 4: Parallel Review (5 Sonnet Agents)

Launch 5 agents in parallel to independently code review:

| Agent | Focus Area |
|-------|------------|
| #1 | CLAUDE.md compliance audit |
| #2 | Shallow bug scan (focus on changes, avoid false positives) |
| #3 | Git blame and history context for bugs |
| #4 | Previous PRs and comments that may apply |
| #5 | Code comments compliance in modified files |

Each agent returns a list of issues with reasons (CLAUDE.md adherence, bug, historical context, etc.)

### Phase 5: Confidence Scoring (Parallel Haiku Agents)

For each issue found, launch a Haiku agent to score confidence:

| Score | Meaning |
|-------|---------|
| 0 | Not confident - false positive or pre-existing issue |
| 25 | Somewhat confident - might be real, couldn't verify |
| 50 | Moderately confident - real but minor/nitpick |
| 75 | Highly confident - verified real issue, important |
| 100 | Absolutely certain - confirmed, will happen frequently |

For CLAUDE.md issues, agents must verify the instruction actually exists.

### Phase 6: Filter and Comment

1. Filter out issues with score < 80
2. Re-verify PR eligibility
3. Comment on PR with high-confidence issues

## False Positives to Avoid

- Pre-existing issues
- Things that look like bugs but aren't
- Pedantic nitpicks senior engineers wouldn't call out
- Linter/typechecker/compiler catches (imports, types, formatting)
- General code quality without CLAUDE.md requirement
- Issues silenced by lint ignore comments
- Intentional functionality changes
- Issues on lines the user didn't modify

## Output Format

### If issues found:

```markdown
### Code review

Found 3 issues:

1. (CLAUDE.md says "<...>")

2. (some/other/CLAUDE.md says "<...>")

3. (bug due to <reason>)

Generated with [Claude Code](https://claude.ai/code)

_- If this code review was useful, please react with thumbs up. Otherwise, react with thumbs down._
```

### If no issues:

```markdown
### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

Generated with [Claude Code](https://claude.ai/code)
```

## Link Format

When linking to code, use this format:
```
https://github.com/owner/repo/blob/FULL_SHA/path/file.ts#L10-L15
```

Requirements:
- Full git SHA (not short hash)
- Repo name matches the PR
- `#` after file name
- Line range format: `L[start]-L[end]`
- Include 1 line of context before and after

## Workflow

```yaml
steps:
  - name: eligibility_check
    agent: haiku
    description: Check if PR is eligible for review

  - name: claudemd_discovery
    agent: haiku
    description: Find all relevant CLAUDE.md files

  - name: pr_summary
    agent: haiku
    description: Get PR summary

  - name: parallel_review
    agents: 5x sonnet
    parallel: true
    description: Independent code review from multiple angles

  - name: confidence_scoring
    agents: N x haiku
    parallel: true
    description: Score each issue for confidence

  - name: filter_and_comment
    description: Filter low-confidence, re-verify eligibility, post comment
```

## Chain of Thought
1. Check PR eligibility (closed, draft, automated, already reviewed)
2. Find all CLAUDE.md files in affected directories
3. Get PR summary
4. Launch 5 parallel agents for different review perspectives
5. Score each issue with Haiku agents
6. Filter issues below 80 confidence
7. Re-verify eligibility
8. Post comment with high-confidence issues only

## Verification Checklist
- [ ] PR is open and not a draft
- [ ] All relevant CLAUDE.md files identified
- [ ] 5 review agents launched in parallel
- [ ] Each issue scored for confidence
- [ ] Only issues with confidence >= 80 reported
- [ ] Code links use full SHA and correct format
- [ ] Comment follows exact output format

## Usage

```typescript
// Review a specific PR
gateway_execute_skill({
  name: "code-review",
  inputs: {
    pr_number: "123"
  }
})

// Review with lower threshold
gateway_execute_skill({
  name: "code-review",
  inputs: {
    pr_number: "123",
    confidence_threshold: 70
  }
})
```

## Code

```typescript
// Code Review Skill - Anthropic Official
const pr_number = inputs.pr_number;
const confidence_threshold = inputs.confidence_threshold || 80;

console.log(`# Code Review: PR #${pr_number || 'current'}

## Review Process

### Phase 1: Eligibility Check
Launch Haiku agent to verify:
- [ ] PR is not closed
- [ ] PR is not a draft
- [ ] PR needs review (not automated/trivial)
- [ ] No existing code review from earlier

### Phase 2: CLAUDE.md Discovery
Launch Haiku agent to find:
- Root CLAUDE.md file
- CLAUDE.md files in modified directories

### Phase 3: PR Summary
Launch Haiku agent to summarize the change.

### Phase 4: Parallel Review (5 Agents)

| Agent | Focus | Status |
|-------|-------|--------|
| #1 | CLAUDE.md compliance | Pending |
| #2 | Bug scan (changes only) | Pending |
| #3 | Git blame/history context | Pending |
| #4 | Previous PR comments | Pending |
| #5 | Code comments compliance | Pending |

### Phase 5: Confidence Scoring

For each issue:
- 0: False positive / pre-existing
- 25: Might be real, couldn't verify
- 50: Real but minor
- 75: Verified, important
- 100: Certain, will happen frequently

### Phase 6: Results

Filter threshold: ${confidence_threshold}

Only issues with confidence >= ${confidence_threshold} will be reported.

## Commands

\`\`\`bash
# View PR
gh pr view ${pr_number || 'CURRENT'}

# Get diff
gh pr diff ${pr_number || 'CURRENT'}

# Post comment
gh pr comment ${pr_number || 'CURRENT'} --body "..."
\`\`\`

---

Begin by checking PR eligibility with a Haiku agent.
`);
```

## References

See `references/languages.md` for language-specific review patterns.

---
Created: Mon Dec 22 2025 10:35:19 GMT+0800 (Singapore Standard Time)
Updated: Sun Dec 29 2025 (Anthropic Official Version)
