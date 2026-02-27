# MCP Gateway - Project Configuration

> Single source of truth for all IDE configurations (Claude Code, Cursor, Windsurf, Codex)

**Project Path**: (set to your local clone path)

---

## FIRST: Check Skill Triggers (LAZY LOADING)

**Skill Loading Strategy** (Token-Optimized):
- For **SIMPLE** tasks: Use your built-in knowledge, don't load skills
- For **COMPLEX** tasks: Load the appropriate skill file only when needed

**Simple Tasks** (Don't load skills):
- Single-line fixes, typos, obvious bugs
- Basic questions about concepts
- Simple git commands (status, log)
- File reads, basic edits

**Complex Tasks** (Load skill first):
- Multi-file refactoring
- Architecture design decisions
- Security reviews or audits
- Advanced git workflows (interactive rebase, conflict resolution)
- Production deployments
- Database schema migrations
- Performance optimization

**If loading a skill:**
1. Read the skill: `.agents/skills/{skill-name}/SKILL.md`
2. Follow the skill's instructions in your response

**This applies to ALL IDEs** - Claude Code, Cursor, Windsurf, VS Code, Codex, etc.

---

## What is MCP Gateway?

**MCP Gateway** is a universal Model Context Protocol (MCP) aggregation server that:
- Combines 305+ tools from multiple backend MCP servers into a single endpoint
- Provides 15 layers of token optimization (95-98% reduction)
- Works with Claude Desktop, Cursor, VS Code Copilot, OpenAI Codex
- Includes a web dashboard for tool/backend management

---

## Cipher Memory Protocol (MANDATORY)

**CRITICAL RULE**: If the user asks ANY memory-related question (e.g., "What have we worked on today?", "Recall context"), **NEVER check git log, git status, or conversation history summaries**. ALWAYS use the `cipher_ask_cipher` tool.

### Tool Schema

```typescript
cipher_ask_cipher({
  message: string,      // Required: What to store or ask
  projectPath: string   // MANDATORY: Full project path
})
```

### projectPath Rules

1. **ALWAYS** use full absolute path: `/path/to/mcp-gateway`
2. **NEVER** use placeholders like `{cwd}` - they don't resolve!
3. **NEVER** use just the project name

### Quick Reference

| Action | Message Format |
|--------|----------------|
| **Recall context** | `"Recall context for this project. What do you remember?"` |
| **Store decision** | `"STORE DECISION: [description]. Reasoning: [why]"` |
| **Store bug fix** | `"STORE LEARNING: Fixed [bug]. Root cause: [cause]. Solution: [fix]"` |
| **Store milestone** | `"STORE MILESTONE: Completed [feature]. Key files: [files]"` |
| **Store pattern** | `"STORE PATTERN: [pattern_name]. Usage: [when_to_use]"` |
| **Store blocker** | `"STORE BLOCKER: [description]. Attempted: [what_tried]"` |
| **Search memory** | `"Search memory for: [topic]. What patterns or learnings are relevant?"` |
| **Session end** | `"Consolidate session. Accomplishments: [list]. Open: [items]"` |

---

## Skill Auto-Activation

Skills auto-activate via hook in Claude Code. For other IDEs, see `.agents/AGENTS.md`.

Skills location: `.agents/skills/{skill-name}/SKILL.md`

### AI Delegation Workflow (MANDATORY)

**CRITICAL**: Use a team-of-agents pass for direction, then apply one orchestrator-owned minimal-risk patch.

#### Orchestrator Rule

- Claude is the orchestrator and owns architecture, coding, and final edits.
- Specialist agents provide support outputs only (research/analysis/summarization/translation/file ops).

#### Routing Rules

| Task Type | Primary | Fallback | Why |
|-----------|---------|----------|-----|
| **Research** | Kimi | Z.AI | Fast exploration, multilingual |
| **Analysis** | Z.AI | Kimi | Reasoning cross-check |
| **Creative** | Kimi | Z.AI | Ideation quality |
| **Translation** | Kimi | Z.AI | Multilingual quality |
| **Summarization** | Minimax | Kimi | Long context + cost |
| **Long-context** | Minimax | Kimi | 1M-context processing |
| **Fast/Cheap** | Minimax | Z.AI | Latency and cost control |
| **File editing** | Codex CLI | Kimi | Local workspace operations |
| **General** | Kimi | Minimax | Balanced default |

#### Correct CLI Usage

Gemini does **not** support `-w`; use `--include-directories`:

```bash
gemini --include-directories "/path/to/mcp-gateway" -p "Plan implementation for <task>" --yolo
```

Kimi workspace form (requires valid CLI login/auth):

```bash
kimi -w "/path/to/mcp-gateway" -p "Research/analyze <task>" --yolo
```

#### Workflow Pattern

1. Delegate to one or two specialists for direction.
2. Compare outputs and resolve conflicts.
3. Apply one final patch in the main codebase.
4. Validate with tests/build.

#### Security: NEVER Share Credentials

**CRITICAL**: Only Abdullah's primary orchestrator is trusted with credentials.

- **NEVER** expose passwords, API keys, or secrets to delegated agents
- **NEVER** delegate raw secret-bearing files
- Sanitize/redact sensitive data before delegation

---

### Loading Skills

**Action Required**: When triggers match, read the skill file BEFORE responding:

```
.agents/skills/{skill-name}/SKILL.md
```

Example: User says "review this code" → Read `.agents/skills/code-review/SKILL.md` → Follow its instructions.

**Claude Code**: Auto-loads via hook (backup mechanism).
**Other IDEs**: Must follow this instruction manually.

---

## MCP Gateway Efficient Usage

### Detection
Active when `gateway_*` tools are available.

### Minimal Token Protocol

1. **Discovery**: Call `gateway_list_tool_names` first
2. **Search**: If unsure of tool name, use `gateway_search_tools`
3. **Execution**:
   - **Simple**: `gateway_call_tool_filtered` (use `filter` to limit rows/fields)
   - **Complex/Batch**: `gateway_execute_code` (Write TS to batch multiple calls)

### Critical Rules

- **Progressive Disclosure**: Never request `full_schema` for all tools. Load only what you use.
- **Skills Listing**: ALWAYS use `gateway_list_skills` with `detail="minimal"` (saves ~95% tokens). Only use `detail="full"` if you need the complete code.
- **Aggregation**: Use `gateway_call_tool_aggregate` for counts/sums.
- **Filtering**: Always set `maxRows` in `gateway_call_tool_filtered`.

### Database & Complex Tasks

**STOP & READ**: If the user asks about **Databases**, **Hosting**, or **infrastructure**:
1. You DO NOT have the schema mapping in context to save tokens.
2. **READ THIS FILE FIRST**: `docs/MCP_REFERENCE.md` (relative to project root)
   - It contains: Server Mappings, Anti-Hallucination rules, Tool prefix mapping, Troubleshooting, and Examples.
   - **Token Cost**: ~4,000 tokens (only load when needed)

---

## Architecture Overview

```
+-------------------------------------------------+
|         MCP Gateway (Express.js:3010)           |
+-------------------------------------------------+
|  /mcp          -> HTTP Streamable Transport     |
|  /sse          -> SSE Transport                 |
|  /dashboard    -> Web UI                        |
|  /api/code     -> Code Execution API            |
|  /metrics      -> Prometheus Metrics            |
|  /health       -> Health Check                  |
+-------------------------------------------------+
                      |
    +-----------------+------------------+
    v                 v                  v
[STDIO Backends] [HTTP Backends] [SSE Backends]
 (subprocesses)   (remote HTTP)   (remote SSE)
```

## Directory Structure

```
src/
+-- index.ts              # Entry point
+-- server.ts             # MCPGatewayServer class
+-- config.ts             # ConfigManager singleton
+-- types.ts              # Zod schemas & types
+-- logger.ts             # Winston logging
|
+-- backend/              # MCP Server Connections
|   +-- base.ts           # BaseBackend abstract
|   +-- stdio.ts          # STDIO transport
|   +-- http.ts           # HTTP/SSE transport
|   +-- manager.ts        # BackendManager
|
+-- protocol/
|   +-- handler.ts        # MCPProtocolHandler
|
+-- code-execution/       # Token Optimization
|   +-- executor.ts       # Sandboxed VM
|   +-- tool-discovery.ts # Progressive disclosure
|   +-- gateway-tools.ts  # 14 gateway tools
|   +-- skills.ts         # Reusable patterns
|   +-- pii-tokenizer.ts  # Privacy protection
|   +-- cache.ts          # LRU caching
|
+-- dashboard/
    +-- index.ts          # Web UI routes

config/
+-- servers.json          # Backend config (hot-reload)
+-- servers.schema.json   # JSON Schema

workspace/
+-- sessions/             # Session state
+-- skills/               # Saved skills
```

## Key Classes

| Class | File | Purpose |
|-------|------|---------|
| `MCPGatewayServer` | `src/server.ts` | Main Express app |
| `ConfigManager` | `src/config.ts` | Config management |
| `BackendManager` | `src/backend/manager.ts` | Backend orchestration |
| `MCPProtocolHandler` | `src/protocol/handler.ts` | JSON-RPC routing |
| `CodeExecutor` | `src/code-execution/executor.ts` | Sandboxed VM |
| `SkillsManager` | `src/code-execution/skills.ts` | Skill CRUD |

## 15 Token Optimization Layers

1. **Progressive Disclosure** - Load schemas on-demand
2. **Smart Filtering** - Auto-limit result sizes
3. **Aggregations** - Server-side count/sum/avg/groupBy
4. **Code Batching** - Multiple ops in one call
5. **Skills System** - Reusable code patterns
6. **Result Caching** - LRU cache with TTL
7. **PII Tokenization** - Privacy-preserving ops
8. **Response Optimization** - Strip null/empty values
9. **Session Context** - Avoid resending data
10. **Schema Deduplication** - Reference by hash
11. **Micro-Schema Mode** - Ultra-compact types (60-70%)
12. **Delta Responses** - Only changes (90%+)
13. **Context Tracking** - Prevent overflow
14. **Auto-Summarization** - Extract insights (60-90%)
15. **Query Planning** - Optimization hints (30-50%)

---

## Build & Run

```bash
npm run dev      # Development with hot-reload
npm run build    # Compile TypeScript
npm start        # Production mode
```

### Restart Service (macOS)

```bash
launchctl stop com.mcp-gateway && launchctl start com.mcp-gateway
```

### Dashboard

http://localhost:3010/dashboard

---

## Configuration

### Environment Variables

```bash
PORT=3010
HOST=0.0.0.0
AUTH_MODE=none|api-key|oauth
API_KEYS=key1,key2
LOG_LEVEL=info
CORS_ORIGINS=*
```

### Server Config (`config/servers.json`)

```json
{
  "servers": [{
    "id": "unique-id",
    "name": "Display Name",
    "enabled": true,
    "transport": {
      "type": "stdio",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/path"]
    },
    "toolPrefix": "fs",
    "timeout": 30000
  }]
}
```

---

## Security Features

- **Code Execution Sandbox**: VM with frozen objects
- **Tool Allowlisting**: Restrict callable tools
- **API Key Auth**: Constant-time comparison
- **Rate Limiting**: Per-IP window-based
- **PII Tokenization**: Detect and mask sensitive data

---

## Data Flow

```
HTTP Request -> Auth Middleware -> Rate Limit
    |
HTTP Transport -> Session Management
    |
MCP Protocol Handler -> Route by method
    |
Gateway tool? -> gateway-tools.ts
Backend tool? -> BackendManager -> Backend -> MCP Server
    |
[Optional] PII Tokenization -> Result Filtering -> Caching
    |
HTTP Response
```

---

## Owner Notes

- Always ask before deploying
- Use MCP Gateway efficient patterns when working with gateway tools
- Dashboard: http://localhost:3010/dashboard
- **DELEGATE ON EVERY PROMPT**:
  - Planning/Architecture → `gemini -p "..." --yolo`
  - Small tasks/Code → `kimi -p "..." --yolo`
