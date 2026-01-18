---
name: git-workflow
description: Smart git operations including conventional commits, PR creation, branch management, and conflict resolution. Activates for "commit", "create PR", "push", "merge", "resolve conflict", "git" operations.
allowed-tools: [Bash, Read, Grep, Glob, Write]
---

# Git Workflow Protocol

## When This Skill Activates
- "Commit this", "commit changes", "save changes"
- "Create PR", "open pull request", "push to remote"
- "Merge", "rebase", "resolve conflicts"
- Any git-related operations

## Commit Message Convention

### Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
| Type | Use For |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructuring (no behavior change) |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `test` | Adding/fixing tests |
| `chore` | Build, deps, config changes |
| `style` | Formatting (no code change) |

### Before Committing - Always Run:
```bash
# 1. See what's changed
git status
git diff --staged

# 2. Check recent commit style
git log --oneline -10

# 3. Verify no secrets
git diff --staged | grep -i -E "(password|secret|key|token|api_key)" || echo "No secrets found"
```

### Commit Message Examples

**Good:**
```
feat(auth): add OAuth2 login with Google

- Implement GoogleAuthProvider with PKCE flow
- Add /api/auth/google callback endpoint
- Store refresh tokens in encrypted session

Closes #123
```

**Bad:**
```
fixed stuff
update
wip
```

## Pull Request Workflow

### Before Creating PR:
```bash
# 1. Ensure branch is up to date
git fetch origin main
git rebase origin/main

# 2. Run tests
npm test

# 3. Check for lint errors
npm run lint

# 4. Review your own changes
git diff origin/main...HEAD
```

### PR Title Format
Same as commit: `type(scope): description`

### PR Body Template
```markdown
## Summary
[1-3 bullet points of what this PR does]

## Changes
- [Specific change 1]
- [Specific change 2]

## Testing
- [ ] Unit tests pass
- [ ] Manual testing done
- [ ] Edge cases covered

## Screenshots (if UI change)
[Before/After images]

## Related Issues
Closes #XXX
```

### PR Creation Command
```bash
gh pr create --title "feat(scope): description" --body "$(cat <<'EOF'
## Summary
- Change 1
- Change 2

## Test Plan
- [ ] Tests pass
- [ ] Manual verification done

---
Generated with Claude Code
EOF
)"
```

## Branch Naming
```
feature/short-description
fix/issue-number-description
refactor/what-is-being-refactored
```

## Conflict Resolution

### Step-by-Step:
```bash
# 1. Update main
git fetch origin main

# 2. Start rebase
git rebase origin/main

# 3. When conflicts occur:
# - Open conflicted files
# - Look for <<<<<<< markers
# - Keep correct version, remove markers
# - Stage resolved files
git add <resolved-file>

# 4. Continue rebase
git rebase --continue

# 5. If stuck, abort and try merge instead
git rebase --abort
git merge origin/main
```

### Conflict Markers
```
<<<<<<< HEAD
Your changes
=======
Their changes
>>>>>>> branch-name
```

## Safety Rules
1. NEVER force push to main/master
2. NEVER commit .env files or secrets
3. ALWAYS review diff before committing
4. ALWAYS run tests before pushing
5. NEVER use `git add .` without reviewing status first

## Quick Reference
```bash
# Undo last commit (keep changes)
git reset --soft HEAD~1

# Discard all local changes
git checkout -- .

# See what would be pushed
git log origin/main..HEAD

# Interactive rebase last N commits
git rebase -i HEAD~N
```
