---
trigger: always_on
---

# Auto Memory Protocol - Claude Mind

You have access to Claude Mind MCP tools. Follow this AUTOMATICALLY:

## Session Start
IMMEDIATELY call: mind_recall(cwd) to load previous context.
If not initialized: mind_init(cwd, "Project Name", "Goal")

## Auto-Log During Work (no prompt needed)
- Decision made → mind_log(cwd, "description", "decision")
- Bug fixed → mind_log(cwd, "what & how", "learning")
- Feature done → mind_complete(cwd, "feature")
- Blocker hit → mind_blocker(cwd, "description")
- New task → mind_log(cwd, "task", "focus")

## Session End
On bye/done/save: mind_save(cwd)

Always use current working directory. Log AS events happen.
