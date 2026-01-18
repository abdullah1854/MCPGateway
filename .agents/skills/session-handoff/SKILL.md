---
name: session-handoff
description: Preserves context across sessions and IDE switches. Activates for "save session", "handoff", "continue later", "switching IDE", "save context", "what did we do", "summarize session", "end session".
allowed-tools: [Read, Write, Grep, Glob, Bash, TodoWrite]
---

# Session Handoff Protocol

## When This Skill Activates
- "Save this session", "I need to continue later"
- "Switching to Cursor/Windsurf/VS Code"
- "What did we accomplish?"
- "End of session", "wrapping up"
- "Summarize what we did"

## Session Start Checklist

### When Starting a Session:
1. **Check for previous session notes**
```bash
# Look for session files
find . -name "SESSION-*.md" -mtime -7 | head -5
cat .claude/session-notes.md 2>/dev/null || echo "No previous session"
```

2. **Check git for recent context**
```bash
git log --oneline -10
git status
```

3. **Review open tasks**
```bash
grep -r "TODO:" --include="*.ts" --include="*.tsx" | head -10
```

## Session Handoff Document

When user ends session or switches IDE, create this document:

```markdown
# Session Handoff: [Date]

## What Was Accomplished
- [x] [Completed task 1]
- [x] [Completed task 2]
- [ ] [Started but not finished]

## Current State
- **Working on**: [Current task]
- **Branch**: [git branch name]
- **Last file modified**: [file path]
- **Uncommitted changes**: [yes/no, what]

## Key Decisions Made
1. **[Decision]**: [Rationale]
2. **[Decision]**: [Rationale]

## Open Issues / Blockers
- [ ] [Issue 1]: [Why blocked]
- [ ] [Issue 2]: [Next step needed]

## For Next Session
1. [Priority 1 - Must do first]
2. [Priority 2]
3. [Priority 3]

## Context Files to Review
- `path/to/important/file.ts` - [Why important]
- `path/to/another.ts` - [Why important]

## Commands to Remember
```bash
# Start dev server
npm run dev

# Run specific test
npm test -- path/to/test.ts
```

## Notes
[Any additional context the next session needs]
```

## Quick Handoff Commands

### Save Session State
```bash
# Create session file
cat > .claude/session-$(date +%Y%m%d).md << 'EOF'
# Session: $(date)

## Status
[Current state]

## Next Steps
[What to do next]
EOF
```

### Git-Based Context
```bash
# Create WIP commit with context
git add -A
git commit -m "WIP: [description]

Session context:
- Working on: [feature]
- Next step: [what to do]
- Blocked by: [if any]"
```

## Cipher Memory Integration

For cross-IDE persistence, store in Cipher:
```
Use cipher_ask_cipher to store:
- Key decisions made
- Patterns discovered
- Blockers encountered
- Solutions found

Always include projectPath: "/path/to/your/project"
```

### Store Session Summary
```javascript
cipher_ask_cipher({
  message: `SESSION SUMMARY for [project]:

  Accomplished:
  - [task 1]
  - [task 2]

  Decisions:
  - [decision]: [why]

  Next session:
  - [priority task]

  Blockers:
  - [if any]`,
  projectPath: "/path/to/your/project"
})
```

### Recall Previous Session
```javascript
cipher_ask_cipher({
  message: "Recall the last session for this project. What was accomplished and what should I focus on?",
  projectPath: "/path/to/your/project"
})
```

## IDE Switch Protocol

When switching between Claude Code, Cursor, Windsurf, etc:

1. **Before leaving current IDE**:
   - Save session notes
   - Commit or stash changes
   - Store key context in Cipher

2. **When entering new IDE**:
   - Read session notes
   - Recall from Cipher
   - Check git status
   - Review TODO list

## Quick Session Summary Format

For fast handoffs:
```
STATUS: [Working/Blocked/Done]
TASK: [What you were doing]
NEXT: [Immediate next action]
FILES: [Key files touched]
NOTES: [Anything important]
```

## Key Principle
The goal is seamless continuity. The next session (in any IDE) should be able to pick up exactly where this one left off without re-explaining context.
