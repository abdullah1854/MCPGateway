# MCP Gateway - Project Configuration

> Single source of truth for all IDE configurations (Claude Code, Cursor, Windsurf, Codex)

**Project Path**: `/Users/abdullah/MCP Gateway`

---

## FIRST: Check Skill Triggers (MANDATORY)

**BEFORE responding to ANY user request**, scan the **Skill Auto-Activation** section below and check if the user's message matches any skill triggers.

**If a match is found:**
1. Read the skill: `.agents/skills/{skill-name}/SKILL.md`
2. Follow the skill's instructions in your response

**This applies to ALL IDEs** - Claude Code, Cursor, Windsurf, VS Code, Codex, etc.

Skip this check only for simple greetings or meta-questions about the AI itself.

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

1. **ALWAYS** use full absolute path: `/Users/abdullah/MCP Gateway`
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

## Skill Auto-Activation (ALL IDEs)

> **SCAN THIS SECTION FIRST** before responding to any user request.

When the user's message contains any trigger keyword below, **immediately read** the corresponding skill file before responding:

### Thinking & Analysis

| Skill | Triggers | Description |
|-------|----------|-------------|
| `deep-thinking` | "think harder", "ultrathink", "analyze thoroughly", "complex problem", "architecture decision", "trade-off", "design system" | Extended reasoning for complex problems |

### Code Quality

| Skill | Triggers | Description |
|-------|----------|-------------|
| `code-review` | "review code", "review PR", "security audit", "find bugs", "code quality", "check for vulnerabilities" | Security, performance, maintainability review |
| `debugging` | "debug", "fix bug", "not working", "undefined", "null", "crash", "fails", "broken", "error message", "stack trace" | Systematic debugging protocol |

### Git & Version Control

| Skill | Triggers | Description |
|-------|----------|-------------|
| `git-workflow` | "commit", "push", "merge", "rebase", "create PR", "pull request", "branch", "resolve conflict" | Git operations and conventional commits |

### Documents

| Skill | Triggers | Description |
|-------|----------|-------------|
| `docx` | "word document", ".docx", "create document", "edit document", "tracked changes", "redline" | Word document creation and editing |
| `pdf` | "pdf", "merge pdf", "split pdf", "extract from pdf", "create pdf", "pdf form" | PDF manipulation |
| `pptx` | "powerpoint", ".pptx", "presentation", "slides", "deck" | PowerPoint presentations |
| `xlsx` | "excel", "spreadsheet", ".xlsx", "financial model", "formulas", "pivot table", "workbook" | Excel spreadsheet operations |

### Frontend & UI

| Skill | Triggers | Description |
|-------|----------|-------------|
| `frontend-build` | "build UI", "build component", "landing page", "dashboard", "frontend", "tailwind", "responsive", "design", "react", "next.js", "shadcn" | Production-grade frontend with distinctive design |
| `web-artifacts` | "web artifact", "single-file app", "bundle html", "standalone app", "interactive demo", "portable app" | Self-contained HTML applications |
| `algorithmic-art` | "generative art", "algorithmic art", "p5.js", "creative coding", "procedural generation" | Generative art with p5.js |

### Testing

| Skill | Triggers | Description |
|-------|----------|-------------|
| `webapp-testing` | "playwright", "e2e test", "end-to-end", "browser automation", "ui test", "test webapp" | Playwright browser automation |

### Development Tools

| Skill | Triggers | Description |
|-------|----------|-------------|
| `mcp-builder` | "mcp server", "mcp tool", "build mcp", "model context protocol", "extend claude", "add tools to claude" | Build MCP servers |
| `skill-creator` | "create skill", "new skill", "build skill", "skill template", "SKILL.md" | Create new Claude Code skills |
| `api-integration` | "integrate api", "api call", "webhook", "REST", "GraphQL", "stripe", "fetch from" | External API integration |

### Documentation

| Skill | Triggers | Description |
|-------|----------|-------------|
| `doc-coauthoring` | "write document", "draft proposal", "draft spec", "co-author", "help me write", "RFC", "ADR", "design doc", "technical spec" | Collaborative document writing |

### Infrastructure

| Skill | Triggers | Description |
|-------|----------|-------------|
| `infra-deploy` | "deploy", "VPS", "docker", "coolify", "SSH", "nginx", "production", "server setup", "hosting" | Infrastructure and deployment |

### Session Management

| Skill | Triggers | Description |
|-------|----------|-------------|
| `session-handoff` | "save session", "handoff", "continue later", "switching IDE", "end session", "summarize session", "wrapping up" | Context preservation across sessions |

### Domain-Specific: ERP

| Skill | Triggers | Description |
|-------|----------|-------------|
| `d365fo-debugging` | "D365", "Dynamics 365", "Dynamics AX", "AX", "voucher", "DATAAREAID", "SSRS", "batch job", "posting", "invoice missing", "DMF", "data management", "WMS", "warehouse", "wave", "work order stuck", "can't post", "security role", "slow query", "blocking", "deadlock", "sales order", "purchase order", "PO", "SO", "wrong amount" | Complete D365 F&O debugging framework |
| `maximo-helper` | "maximo", "work order", "WONUM", "asset", "LABTRANS", "SITEID", "GBE" | Maximo database queries with site filtering |
| `gbcr-commission` | "GBCR", "commission", "agreement", "settlement", "FTCNV", "rebate", "vendor commission" | GBCR commission debugging |

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
- **Aggregation**: Use `gateway_call_tool_aggregate` for counts/sums.
- **Filtering**: Always set `maxRows` in `gateway_call_tool_filtered`.

### Database & Complex Tasks

**STOP & READ**: If the user asks about **Databases (Maximo, AX, CRM)**, **Hosting**, or **infrastructure**:
1. You DO NOT have the schema mapping in context to save tokens.
2. **READ THIS FILE FIRST**: `/Users/abdullah/MCP Gateway/docs/KEY_MCP_REFERENCE.md`
   - It contains: Server Mappings, Anti-Hallucination rules, and Examples.

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
