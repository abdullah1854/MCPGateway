# MCP Gateway - Future Improvements

## Dashboard Server Management ✅ COMPLETED

### Add New MCP Server from Dashboard ✅
- [x] Create "Add Server" button in dashboard UI
- [x] Form with fields: server name, type (stdio/http), command/URL, args, env vars
- [x] Validate server configuration before saving
- [x] Hot-reload: Add server without restarting gateway
- [x] Persist new server to `config/servers.json`
- [x] Test connection before adding

### Delete MCP Server from Dashboard ✅
- [x] Add delete button on each backend card
- [x] Confirmation dialog before deletion
- [x] Graceful disconnect: Close backend connection before removing
- [x] Remove from `config/servers.json`
- [x] Update UI immediately after deletion

### Edit Existing MCP Server ✅
- [x] Edit button on backend cards
- [x] Modify command, args, env vars
- [x] Reconnect after changes

---

## Code Execution with MCP ✅ COMPLETED (Inspired by [Anthropic Engineering Blog](https://www.anthropic.com/engineering/code-execution-with-mcp))

### 1. Progressive Tool Disclosure ✅
**Problem:** Loading 300+ tool definitions upfront consumes excessive tokens

- [x] Implement `search_tools` endpoint with filters:
  - Search by name, description, backend
  - Detail levels: `name_only`, `name_description`, `full_schema`
- [x] Generate filesystem-like tool tree structure:
  ```
  servers/
  ├── filesystem/
  │   ├── read_file.ts
  │   └── write_file.ts
  ├── mssql-prod/
  │   ├── execute_query.ts
  │   └── get_schema.ts
  ```
- [x] Lazy-load tool definitions on demand
- [x] Cache frequently used tool definitions

**API Endpoints:**
- `GET /api/code/tools/search` - Search tools with filters
- `GET /api/code/tools/tree` - Get filesystem-like tree
- `GET /api/code/tools/names` - Get all tool names (minimal)
- `GET /api/code/tools/:name/schema` - Lazy-load specific tool
- `GET /api/code/tools/stats` - Tool statistics by backend

### 2. Code Execution Mode ✅
**Benefit:** 98.7% token reduction by letting agents write code instead of direct tool calls

- [x] Generate TypeScript/JavaScript SDK from MCP tools
- [x] Create sandboxed code execution environment (Node.js VM)
- [x] Allow agents to write code like:
  ```typescript
  const data = await mssql.executeQuery({ query: 'SELECT * FROM users' });
  const filtered = data.filter(u => u.active);
  console.log(`Found ${filtered.length} active users`);
  ```
- [x] Return only `console.log` output to agent (not full data)
- [x] Support async/await, loops, conditionals in code

**API Endpoints:**
- `GET /api/code/sdk` - Get auto-generated TypeScript SDK
- `POST /api/code/execute` - Execute code in sandbox

### 3. Context-Efficient Tool Results ✅
**Problem:** Large tool results (10K rows, documents) bloat context

- [x] Add result transformation options:
  - `maxRows`: Limit returned rows
  - `fields`: Select specific fields only
  - `format`: `summary`, `sample`, `full`
- [x] Implement streaming for large results (JSONL/chunked)
- [x] Add aggregation helpers (count, sum, avg, min, max, groupBy, distinct)
- [x] Filter results before returning to agent

**API Endpoints:**
- `POST /api/code/tools/:name/call` - Call tool with filtering
- `POST /api/code/tools/:name/call/aggregate` - Call tool with aggregation
- `POST /api/code/tools/parallel` - Execute multiple tools in parallel

### 4. Privacy-Preserving Operations ✅
**Benefit:** Sensitive data flows through workflow without entering model context

- [x] Implement PII tokenization layer:
  - Detect emails, phone numbers, names, SSNs, credit cards, IP addresses
  - Replace with tokens: `[EMAIL_1]`, `[PHONE_2]`
  - Untokenize when data flows to another tool
- [x] Create data flow rules:
  - Define which tools can receive which data types
  - Block sensitive data from logging
- [x] Add `sensitive: true` flag to tool parameters

### 5. State Persistence & Skills ✅
**Benefit:** Agents can resume work and reuse successful code patterns

- [x] Create `/workspace` directory for agent state
- [x] Save intermediate results to files
- [x] Implement Skills system:
  ```
  skills/
  ├── export-leads-to-csv/
  │   ├── SKILL.md
  │   └── index.ts
  ├── sync-crm-data/
  │   ├── SKILL.md
  │   └── index.ts
  ```
- [x] Allow agents to save working code as reusable skills
- [x] Skill discovery via filesystem exploration

**API Endpoints:**
- `GET /api/code/skills` - List all skills
- `GET /api/code/skills/search` - Search skills
- `GET /api/code/skills/:name` - Get skill details
- `POST /api/code/skills` - Create new skill
- `POST /api/code/skills/:name/execute` - Execute skill
- `DELETE /api/code/skills/:name` - Delete skill
- `GET /api/code/workspace/session` - Get session state
- `POST /api/code/workspace/session` - Update session state

---

## Additional Improvements ✅ COMPLETED

### Performance ✅
- [x] Implement tool result caching with TTL (LRU cache)
- [x] Connection pooling for HTTP backends (keep-alive, concurrent request limiting)
- [x] Parallel tool execution when possible

**API Endpoints:**
- `GET /api/code/cache/stats` - Cache statistics
- `POST /api/code/cache/clear` - Clear cache

### Monitoring & Observability ✅
- [x] Add metrics endpoint (Prometheus format)
- [x] Tool call latency tracking
- [x] Error rate per backend
- [x] Token usage estimation per request

**API Endpoints:**
- `GET /metrics` - Prometheus format metrics
- `GET /metrics/json` - JSON format metrics
- `POST /metrics/reset` - Reset metrics (testing)

### Security ✅
- [x] Rate limiting per client
- [x] Audit logging for sensitive operations

### Dashboard Enhancements ✅
- [x] Export/import server configuration

**API Endpoints:**
- `GET /dashboard/api/config/export` - Export configuration
- `POST /dashboard/api/config/import` - Import configuration

---

## Priority Order

1. **High Priority** (Dashboard essentials) ✅ COMPLETED
   - ~~Add/Delete MCP servers from dashboard~~
   - ~~Edit server configuration~~
   - ~~Connection testing~~

2. **Medium Priority** (Efficiency gains) ✅ COMPLETED
   - ~~Progressive tool disclosure~~
   - ~~Result filtering/transformation~~
   - ~~Tool search endpoint~~

3. **Future** (Advanced features) ✅ COMPLETED
   - ~~Code execution mode~~
   - ~~PII tokenization~~
   - ~~Skills system~~
   - ~~State persistence~~

---

## References

- [Code Execution with MCP - Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Cloudflare Code Mode](https://blog.cloudflare.com/mcp-code-mode)

