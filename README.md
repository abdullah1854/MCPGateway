# MCP Gateway

A universal Model Context Protocol (MCP) Gateway that aggregates multiple MCP servers and exposes them through a single endpoint. Works with all major MCP clients:

- ✅ **Claude Desktop / Claude Code**
- ✅ **Cursor**
- ✅ **OpenAI Codex**
- ✅ **VS Code Copilot**

![MCP Gateway Architecture](screenshots/MCPGateway.jpg)

## Why MCP Gateway?

**Problem:** AI agents connecting to multiple MCP servers face two critical issues:
1. **Tool Overload** - Loading 300+ tool definitions consumes 77,000+ context tokens before any work begins
2. **Result Bloat** - Large query results (10K rows) can consume 50,000+ tokens per call

**Solution:** MCP Gateway aggregates all your MCP servers and provides **7 layers of token optimization**:

| Layer | What It Does | Token Savings |
|-------|--------------|---------------|
| Progressive Disclosure | Load tool schemas on-demand | 85% |
| Smart Filtering | Auto-limit result sizes | 60-80% |
| Aggregations | Server-side analytics | 90%+ |
| Code Batching | Multiple ops in one call | 60-80% |
| **Skills** | Zero-shot task execution | **95%+** |
| Caching | Skip repeated queries | 100% |
| PII Tokenization | Redact sensitive data | Security |

**Result:** A typical session drops from ~500,000 tokens to ~25,000 tokens (95% reduction).

### 305 Tools Through 14 Gateway Tools

![Cursor showing 14 gateway tools providing access to 305 MCP tools](screenshots/gateway-tools-claude-desktop.png)

*Cursor connected to MCP Gateway - 14 tools provide access to 305 backend tools across 16 servers*

### Minimal Context Usage

![Claude Code context showing only 8.9k tokens for MCP tools](screenshots/context-usage-claude-code.jpg)

*Claude Code `/context` view - Only 8.9k tokens (4.5%) for all MCP tools instead of 200k+ for raw definitions*

## What's New (v1.0.0)

- **Gateway MCP Tools** - All code execution features now exposed as MCP tools (`gateway_*`) that any client can discover and use directly
- **Hot-Reload Server Management** - Add, edit, and delete MCP servers from the dashboard without restarting
- **UI State Persistence** - Disabled tools and backends are remembered across server restarts
- **Enhanced Dashboard** - Reconnect failed backends, view real-time status, improved error handling
- **Connection Testing** - Test server connections before adding them to your configuration
- **Export/Import Config** - Backup and share your server configurations easily
- **Parallel Tool Execution** - Execute multiple tool calls simultaneously for better performance
- **Result Filtering & Aggregation** - Reduce context bloat with `maxRows`, `fields`, `format`, and aggregation options

## Features

### Core Gateway Features
- 🔀 **Multi-Server Aggregation** - Route multiple MCP servers through one gateway
- 🎛️ **Web Dashboard** - Real-time UI to manage tools, backends, and server lifecycle
- ➕ **Hot-Reload Server Management** - Add, edit, delete MCP servers from dashboard without restart
- 🌐 **HTTP Streamable Transport** - Primary transport, works with all clients
- 📡 **SSE Transport** - Backward compatibility for older clients
- 🔐 **Authentication** - API Key and OAuth/JWT support
- ⚡ **Rate Limiting** - Protect your backend servers
- 🐳 **Docker Ready** - Easy deployment with Docker/Compose
- 📊 **Health Checks** - Monitor backend status with detailed diagnostics
- 🔄 **Auto-Restart** - Server restarts automatically on crash or via dashboard
- 💾 **UI State Persistence** - Remembers disabled tools/backends across restarts

### Code Execution Mode (Token-Efficient AI)
Inspired by [Anthropic's Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) - achieve up to **98.7% token reduction**:

- 🔍 **Progressive Tool Disclosure** - Search and lazy-load tools to reduce token usage (85% reduction)
- 💻 **Sandboxed Code Execution** - Execute TypeScript/JavaScript in secure Node.js VM
- 📉 **Context-Efficient Results** - Filter, aggregate, and transform tool results (60-80% reduction)
- 🔒 **Privacy-Preserving Operations** - PII tokenization for sensitive data
- 📁 **Skills System** - Save and reuse code patterns for zero-shot execution (eliminates prompt tokens)
- 🗄️ **State Persistence** - Workspace for agent state across sessions
- 🛠️ **Gateway MCP Tools** - All code execution features exposed as MCP tools for any client

### Monitoring & Observability
- 📈 **Prometheus Metrics** - Tool call latency, error rates, cache performance
- 📊 **JSON Metrics API** - Programmatic access to gateway statistics
- 💾 **Result Caching** - LRU cache with TTL for tool results
- 📝 **Audit Logging** - Track sensitive operations

## Screenshots

### Dashboard Overview
![Dashboard Main View](screenshots/dashboard_v2.png)

### Tools Management
![Expanded Tools View](screenshots/dashboard-expanded-tools.png)

### Add Server Dialog
![Add Server Form](screenshots/dashboard-add-server-form.png)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Backend Servers

Copy the example config and edit it:

```bash
cp config/servers.example.json config/servers.json
```

Edit `config/servers.json` to add your MCP servers:

```json
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "enabled": true,
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
      },
      "toolPrefix": "fs"
    }
  ]
}
```

### 3. Start the Gateway

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

The gateway will start on `http://localhost:3010` by default.

#### Security modes

For local experimentation you can run without auth:

- `AUTH_MODE=none`

However, **sensitive endpoints** (`/dashboard`, `/dashboard/api/*`, `/api/code/*`, `/metrics/json`) are blocked by default when `AUTH_MODE=none`. To allow unauthenticated access (not recommended except for isolated local use), explicitly opt in:

- `ALLOW_INSECURE=1`

For secure usage, prefer:

- `AUTH_MODE=api-key` with `API_KEYS=key1,key2`
- or `AUTH_MODE=oauth` with the appropriate `OAUTH_*` settings shown below.

## Endpoints

### Core Endpoints

| Endpoint | Transport | Use Case |
|----------|-----------|----------|
| `/mcp` | HTTP Streamable | Primary endpoint - works with all clients |
| `/sse` | Server-Sent Events | Backward compatibility |
| `/health` | JSON | Health checks and status |
| `/dashboard` | Web UI | Manage tools, backends, and restart server |
| `/metrics` | Prometheus | Prometheus-format metrics |
| `/metrics/json` | JSON | JSON-format metrics |

### Code Execution API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/code/tools/search` | GET | Search tools with filters |
| `/api/code/tools/tree` | GET | Get filesystem-like tool tree |
| `/api/code/tools/names` | GET | Get all tool names (minimal tokens) |
| `/api/code/tools/:name/schema` | GET | Lazy-load specific tool schema |
| `/api/code/tools/stats` | GET | Tool statistics by backend |
| `/api/code/sdk` | GET | Auto-generated TypeScript SDK |
| `/api/code/execute` | POST | Execute code in sandbox |
| `/api/code/tools/:name/call` | POST | Call tool with result filtering |
| `/api/code/tools/:name/call/aggregate` | POST | Call tool with aggregation |
| `/api/code/tools/parallel` | POST | Execute multiple tools in parallel |
| `/api/code/skills` | GET/POST | List or create skills |
| `/api/code/skills/search` | GET | Search skills |
| `/api/code/skills/:name` | GET/DELETE | Get or delete skill |
| `/api/code/skills/:name/execute` | POST | Execute a skill |
| `/api/code/workspace/session` | GET/POST | Get or update session state |
| `/api/code/cache/stats` | GET | Cache statistics |
| `/api/code/cache/clear` | POST | Clear cache |

### Dashboard API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboard/api/tools` | GET | Get all tools with enabled status |
| `/dashboard/api/backends` | GET | Get all backends with status |
| `/dashboard/api/tools/:name/toggle` | POST | Toggle tool enabled/disabled |
| `/dashboard/api/backends/:id/toggle` | POST | Toggle backend enabled/disabled |
| `/dashboard/api/backends/:id/reconnect` | POST | Reconnect a failed backend |
| `/dashboard/api/backends` | POST | Add new backend server |
| `/dashboard/api/backends/:id` | PUT | Update backend configuration |
| `/dashboard/api/backends/:id` | DELETE | Remove backend server |
| `/dashboard/api/config/export` | GET | Export server configuration |
| `/dashboard/api/config/import` | POST | Import server configuration |
| `/dashboard/api/restart` | POST | Restart the gateway server |

## Dashboard

Access the web dashboard at `http://localhost:3010/dashboard` to:

- View all connected backends and their real-time status
- **Add new MCP servers** with connection testing (STDIO, HTTP, SSE transports)
- **Edit existing servers** (modify command, args, environment variables)
- **Delete servers** with graceful disconnect
- Enable/disable individual tools or entire backends
- Search and filter tools across all backends
- **Export/import configuration** for backup and sharing
- **Reconnect failed backends** with one click
- Restart the entire gateway server
- View tool counts and backend health at a glance

The dashboard persists UI state (disabled tools/backends) across server restarts.

## Client Configuration

### Claude Desktop / Claude Code

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **Add remote MCP server**
3. Enter your gateway URL:

```
http://your-gateway-host:3010/mcp
```

4. Complete authentication if required

> **Note:** Claude requires adding remote servers through the UI, not config files.

### Cursor

1. Open Cursor → **Settings** → **Features** → **MCP**
2. Click **Add New MCP Server**
3. Choose **Type**: `HTTP` or `SSE`
4. Enter your gateway URL:

For HTTP (recommended):
```
http://your-gateway-host:3010/mcp
```

For SSE:
```
http://your-gateway-host:3010/sse
```

Or add to your Cursor settings JSON:

```json
{
  "mcpServers": {
    "my-gateway": {
      "type": "http",
      "url": "http://your-gateway-host:3010/mcp"
    }
  }
}
```

### OpenAI Codex

#### Option 1: CLI

```bash
codex mcp add my-gateway --transport http --url https://your-gateway-host:3010/mcp
```

#### Option 2: Config File

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.my_gateway]
type = "http"
url = "https://your-gateway-host:3010/mcp"

# With API key authentication
# headers = { Authorization = "Bearer your-api-key-here" }
```

> **Important:** Codex requires **HTTPS** for remote servers and only supports HTTP Streamable (not SSE).

### VS Code Copilot

1. Open Command Palette (`Cmd/Ctrl + Shift + P`)
2. Run **MCP: Add MCP Server**
3. Choose **Remote (URL)**
4. Enter your gateway URL:

```
http://your-gateway-host:3010/mcp
```

5. Approve the trust prompt

Or add to your VS Code `settings.json`:

```json
{
  "mcp.servers": {
    "my-gateway": {
      "type": "http",
      "url": "http://your-gateway-host:3010/mcp"
    }
  }
}
```

## Backend Server Configuration

The gateway can connect to MCP servers using different transports:

### STDIO (Local Process)

```json
{
  "id": "filesystem",
  "name": "Filesystem Server",
  "enabled": true,
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
    "env": {
      "SOME_VAR": "${ENV_VAR_NAME}"
    }
  },
  "toolPrefix": "fs",
  "timeout": 30000
}
```

### HTTP (Remote Server)

```json
{
  "id": "remote-server",
  "name": "Remote MCP Server",
  "enabled": true,
  "transport": {
    "type": "http",
    "url": "https://remote-mcp-server.com/mcp",
    "headers": {
      "Authorization": "Bearer ${REMOTE_API_KEY}"
    }
  },
  "toolPrefix": "remote",
  "timeout": 60000
}
```

### Tool Prefixing

Use `toolPrefix` to namespace tools from different servers:

- Server with `toolPrefix: "fs"` exposes `read_file` as `fs_read_file`
- Prevents naming collisions between servers
- Makes it clear which server handles each tool

## Authentication

### API Key Authentication

Set environment variables:

```bash
AUTH_MODE=api-key
API_KEYS=key1,key2,key3
```

Clients send the key in the Authorization header:

```
Authorization: Bearer your-api-key
```

### OAuth Authentication

```bash
AUTH_MODE=oauth
OAUTH_ISSUER=https://your-oauth-provider.com
OAUTH_AUDIENCE=mcp-gateway
OAUTH_JWKS_URI=https://your-oauth-provider.com/.well-known/jwks.json
```

## Docker Deployment

### Build and Run

```bash
# Build the image
docker build -t mcp-gateway .

# Run with environment variables
docker run -d \
  -p 3010:3010 \
  -v $(pwd)/config/servers.json:/app/config/servers.json:ro \
  -e AUTH_MODE=api-key \
  -e API_KEYS=your-secret-key \
  mcp-gateway
```

### Docker Compose

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3010` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `GATEWAY_NAME` | `mcp-gateway` | Gateway name in MCP responses |
| `AUTH_MODE` | `none` | Authentication mode (none, api-key, oauth) |
| `API_KEYS` | - | Comma-separated API keys |
| `OAUTH_ISSUER` | - | OAuth token issuer |
| `OAUTH_AUDIENCE` | - | OAuth audience |
| `OAUTH_JWKS_URI` | - | OAuth JWKS endpoint |
| `CORS_ORIGINS` | `http://localhost:3010,http://127.0.0.1:3010` | Allowed CORS origins (`*` to allow all) |
| `HEALTH_REQUIRE_BACKENDS` | `0` | If `1`, `/health` returns `503` when all configured backends are down |
| `ALLOW_INSECURE` | `0` | If `1`, allow unauthenticated access to dashboard, code APIs, and JSON metrics when `AUTH_MODE=none` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |

## Health Check

```bash
curl http://localhost:3010/health
```

Response:

```json
{
  "status": "ok",
  "gateway": "mcp-gateway",
  "backends": {
    "connected": 2,
    "total": 3,
    "details": {
      "filesystem": {
        "status": "connected",
        "toolCount": 5,
        "resourceCount": 0,
        "promptCount": 0
      }
    }
  },
  "tools": 10,
  "resources": 0,
  "prompts": 0
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          MCP Clients                            │
│  (Claude Desktop, Cursor, Codex, VS Code)                       │
└─────────────────────────────────────────────────────────────────┘
                                │
                    HTTP Streamable / SSE
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Gateway                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │   Auth      │  │ Rate Limit   │  │   Protocol Handler     │  │
│  │  Middleware │──│  Middleware  │──│  (Aggregates Tools)    │  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│                                              │                   │
│                         ┌────────────────────┼────────────────┐  │
│                         │                    │                │  │
│                         ▼                    ▼                ▼  │
│              ┌──────────────────┐ ┌──────────────────┐ ┌──────┐ │
│              │  STDIO Backend   │ │  HTTP Backend    │ │ ...  │ │
│              │  (Local Process) │ │  (Remote Server) │ │      │ │
│              └──────────────────┘ └──────────────────┘ └──────┘ │
└─────────────────────────────────────────────────────────────────┘
                         │                    │
                         ▼                    ▼
              ┌──────────────────┐ ┌──────────────────┐
              │  Local MCP       │ │  Remote MCP      │
              │  Server          │ │  Server          │
              └──────────────────┘ └──────────────────┘
```

## Code Execution Mode

The Code Execution Mode allows AI agents to write and execute code instead of making individual tool calls, achieving up to **98.7% token reduction** for complex workflows.

### Why Skills? (Efficiency & Token Usage)

Skills are the most powerful token-saving feature in MCP Gateway. Here's why:

#### The Token Problem

Without skills, every complex operation requires:
1. **Input tokens**: Describe the task in natural language (~200-500 tokens)
2. **Reasoning tokens**: Model thinks about how to implement it (~100-300 tokens)
3. **Output tokens**: Model generates code to execute (~200-1000 tokens)
4. **Result tokens**: Large query results enter context (~500-10,000+ tokens)

**Total: 1,000-12,000+ tokens per operation**

#### The Skills Solution

With skills, the same operation requires:
1. **Input tokens**: `gateway_execute_skill({ name: "daily-report" })` (~20 tokens)
2. **Result tokens**: Pre-filtered, summarized output (~50-200 tokens)

**Total: 70-220 tokens per operation → 95%+ reduction**

#### Key Benefits

| Benefit | Description | Token Savings |
|---------|-------------|---------------|
| **Zero-Shot Execution** | No prompt explaining *how* to do the task | 500-2000 tokens/call |
| **Deterministic Results** | Pre-tested code, no LLM hallucinations | Eliminates retries |
| **Batched Operations** | Multiple tool calls in single skill | 60-80% fewer round-trips |
| **Pre-filtered Output** | Results processed before returning | 80-95% on large datasets |
| **Cached Execution** | Repeated skill calls hit cache | 100% on cache hits |

#### Real-World Example

**Without Skills** (Traditional approach):
```
User: "Get me the daily sales report grouped by region"
Model: [Thinks about SQL, table schema, grouping logic...]
Model: [Generates code block with query, filtering, aggregation...]
Tool: [Returns 10,000 rows of raw data]
Model: [Processes and summarizes...]

Total: ~8,000 tokens, 4 round-trips, 15 seconds
```

**With Skills** (Skill-based approach):
```
User: "Get me the daily sales report grouped by region"
Model: gateway_execute_skill({ name: "daily-sales-report", inputs: { date: "today" } })
Tool: [Returns pre-aggregated summary: 5 regions, totals, trends]

Total: ~150 tokens, 1 round-trip, 2 seconds
```


### Gateway MCP Tools

All code execution features are exposed as MCP tools that any client can use directly. When connected to the gateway, clients automatically get these **14 tools** instead of 300+ raw tool definitions:

#### Tool Discovery (Progressive Disclosure)

| Tool | Purpose | Token Impact |
|------|---------|--------------|
| `gateway_list_tool_names` | Get all tool names with pagination | ~50 bytes/tool |
| `gateway_search_tools` | Search by name, description, category, backend | Filters before loading |
| `gateway_get_tool_schema` | Lazy-load specific tool schema | Load only when needed |
| `gateway_get_tool_schemas` | Batch load multiple schemas | 40% smaller with `compact: true` |
| `gateway_get_tool_categories` | Get semantic categories (database, filesystem, etc.) | Navigate 300+ tools easily |
| `gateway_get_tool_tree` | Get tools organized by backend | Visual hierarchy |
| `gateway_get_tool_stats` | Get statistics about tools | Counts by backend |

#### Execution & Filtering

| Tool | Purpose | Token Impact |
|------|---------|--------------|
| `gateway_execute_code` | Execute TypeScript/JavaScript in sandbox | Batch multiple ops |
| `gateway_call_tool_filtered` | Call any tool with result filtering | 60-80% smaller results |
| `gateway_call_tool_aggregate` | Call tool with aggregation | 90%+ smaller for analytics |
| `gateway_call_tools_parallel` | Execute multiple tools in parallel | Fewer round-trips |

#### Skills (Highest Token Savings)

| Tool | Purpose | Token Impact |
|------|---------|--------------|
| `gateway_list_skills` | List saved code patterns | Discover available skills |
| `gateway_search_skills` | Search skills by name/tags | Find the right skill fast |
| `gateway_get_skill` | Get skill details and code | Inspect before executing |
| `gateway_execute_skill` | Execute a saved skill | **~20 tokens per call** |
| `gateway_create_skill` | Save a new reusable skill | One-time investment |

### Progressive Tool Disclosure

Instead of loading all tool definitions upfront (which can consume excessive tokens with 300+ tools), use progressive disclosure:

```bash
# Get just tool names (minimal tokens)
curl http://localhost:3010/api/code/tools/names

# Search for specific tools
curl "http://localhost:3010/api/code/tools/search?query=database&backend=mssql"

# Get filesystem-like tree view
curl http://localhost:3010/api/code/tools/tree

# Lazy-load specific tool schema when needed
curl http://localhost:3010/api/code/tools/mssql_execute_query/schema
```

Detail levels for search:
- `name_only` - Just tool names
- `name_description` - Names with descriptions
- `full_schema` - Complete JSON schema

### Sandboxed Code Execution

Execute TypeScript/JavaScript code in a secure Node.js VM sandbox:

```bash
curl -X POST http://localhost:3010/api/code/execute \
  -H "Content-Type: application/json" \
  -d '{
    "code": "const data = await mssql.executeQuery({ query: \"SELECT * FROM users\" });\nconst active = data.filter(u => u.active);\nconsole.log(`Found ${active.length} active users`);",
    "timeout": 30000
  }'
```

The sandbox:
- Auto-generates TypeScript SDK from your MCP tools
- Supports async/await, loops, and conditionals
- Returns only `console.log` output (not raw data)
- Has configurable timeout protection

### Context-Efficient Results

Reduce context bloat from large tool results:

```bash
# Call tool with filtering
curl -X POST http://localhost:3010/api/code/tools/mssql_get_table_data/call \
  -H "Content-Type: application/json" \
  -d '{
    "args": { "tableName": "users" },
    "options": {
      "maxRows": 10,
      "fields": ["id", "name", "email"],
      "format": "summary"
    }
  }'

# Call with aggregation
curl -X POST http://localhost:3010/api/code/tools/mssql_get_table_data/call/aggregate \
  -H "Content-Type: application/json" \
  -d '{
    "args": { "tableName": "orders" },
    "aggregation": {
      "operation": "groupBy",
      "field": "status",
      "countField": "count"
    }
  }'
```

Available aggregations: `count`, `sum`, `avg`, `min`, `max`, `groupBy`, `distinct`

### Privacy-Preserving Operations

Automatically tokenize PII so sensitive data never enters model context:

```bash
curl -X POST http://localhost:3010/api/code/execute \
  -H "Content-Type: application/json" \
  -d '{
    "code": "const users = await mssql.executeQuery({ query: \"SELECT * FROM users\" });\nconsole.log(users);",
    "privacy": {
      "tokenize": true,
      "patterns": ["email", "phone", "ssn", "credit_card"]
    }
  }'
```

Output shows tokenized values:
```
[{ name: "John", email: "[EMAIL_1]", phone: "[PHONE_1]" }]
```

Tokens are automatically untokenized when data flows to another tool.

### Skills System

Save successful code patterns as reusable skills:

```bash
# Create a skill
curl -X POST http://localhost:3010/api/code/skills \
  -H "Content-Type: application/json" \
  -d '{
    "name": "export-active-users",
    "description": "Export active users to CSV",
    "code": "const users = await mssql.executeQuery({ query: \"SELECT * FROM users WHERE active = 1\" });\nreturn users;",
    "parameters": {
      "type": "object",
      "properties": {
        "limit": { "type": "number", "default": 100 }
      }
    }
  }'

# List all skills
curl http://localhost:3010/api/code/skills

# Execute a skill
curl -X POST http://localhost:3010/api/code/skills/export-active-users/execute \
  -H "Content-Type: application/json" \
  -d '{ "limit": 50 }'
```

Skills are stored in the `skills/` directory and can be discovered via filesystem exploration.

### Session State & Workspace

Persist state across agent sessions:

```bash
# Save session state
curl -X POST http://localhost:3010/api/code/workspace/session \
  -H "Content-Type: application/json" \
  -d '{
    "lastQuery": "SELECT * FROM users",
    "results": { "count": 150 }
  }'

# Retrieve session state
curl http://localhost:3010/api/code/workspace/session
```

State is stored in the `workspace/` directory.

## Monitoring & Metrics

### Prometheus Metrics

```bash
curl http://localhost:3010/metrics
```

Returns metrics including:
- `mcp_tool_calls_total` - Total tool calls by backend and tool
- `mcp_tool_call_duration_seconds` - Tool call latency histogram
- `mcp_tool_errors_total` - Error count by backend
- `mcp_cache_hits_total` / `mcp_cache_misses_total` - Cache performance
- `mcp_active_connections` - Active client connections

### JSON Metrics

```bash
curl http://localhost:3010/metrics/json
```

### Caching

Tool results are cached using an LRU cache with TTL:

```bash
# View cache statistics
curl http://localhost:3010/api/code/cache/stats

# Clear cache
curl -X POST http://localhost:3010/api/code/cache/clear
```

## Token Efficiency Architecture

MCP Gateway implements a multi-layered approach to minimize token usage at every stage of AI agent interactions.

### Layer 1: Progressive Tool Disclosure (85% Reduction)

Traditional MCP clients load all tool schemas upfront. With 300+ tools, this can consume 77,000+ tokens before any work begins.

```
Traditional: Load 305 tools → 77,000 tokens in context
Gateway:     Load 14 gateway tools → 8,900 tokens in context (89% less)
```

**How it works:**

```javascript
// Step 1: Get just tool names (50 bytes each)
const names = await gateway_list_tool_names();
// Returns: ["db_query", "db_insert", "fs_read", ...]

// Step 2: Search with minimal detail
const tools = await gateway_search_tools({
  query: "database",
  detailLevel: "name_only"  // or "name_description"
});

// Step 3: Load full schema ONLY when calling
const schema = await gateway_get_tool_schema({
  toolName: "db_query",
  compact: true  // 40% smaller schemas
});
```

### Layer 2: Smart Result Filtering (60-80% Reduction)

Large tool results can consume thousands of tokens. Smart filtering is **enabled by default**.

```javascript
// Default behavior - auto-applies smart filtering
await gateway_call_tool_filtered({
  toolName: "database_query",
  args: { query: "SELECT * FROM users" }
});
// Returns: { rowCount: 10000, sample: [...first 20 rows...], truncated: true }

// Explicit filtering for more control
await gateway_call_tool_filtered({
  toolName: "database_query",
  args: { query: "SELECT * FROM users" },
  filter: {
    maxRows: 10,              // Limit rows
    maxTokens: 500,           // Budget-aware truncation
    fields: ["id", "name"],   // Select columns
    format: "summary"         // Count + sample
  }
});
```

### Layer 3: Server-Side Aggregations

Instead of fetching raw data and processing client-side, compute aggregations in the gateway:

```javascript
// Without aggregation: Fetch 10,000 orders → 50,000 tokens
// With aggregation: Get summary → 200 tokens

await gateway_call_tool_aggregate({
  toolName: "orders_table",
  args: { tableName: "orders" },
  aggregation: {
    operation: "groupBy",
    groupByField: "status"
  }
});
// Returns: { "completed": 5420, "pending": 3210, "cancelled": 1370 }
```

**Available operations:** `count`, `sum`, `avg`, `min`, `max`, `groupBy`, `distinct`

### Layer 4: Code Execution Batching

Execute multiple operations in a single round-trip. Results are processed server-side; only `console.log` output returns.

```javascript
// Without batching: 5 tool calls = 5 round-trips + 5 result payloads
// With batching: 1 code execution = 1 round-trip + 1 summarized output

await gateway_execute_code({
  code: `
    const users = await db.query("SELECT * FROM users WHERE active = 1");
    const orders = await db.query("SELECT * FROM orders WHERE user_id IN (...)");

    const summary = users.map(u => ({
      name: u.name,
      orderCount: orders.filter(o => o.user_id === u.id).length
    }));

    console.log(JSON.stringify(summary.slice(0, 10)));
  `
});
```

### Layer 5: Skills (95%+ Reduction)

Skills eliminate prompt engineering entirely for recurring tasks:

```javascript
// Create once
await gateway_create_skill({
  name: "user-activity-report",
  description: "Get user activity summary for a date range",
  code: `
    const users = await db.query(\`SELECT * FROM users WHERE last_active BETWEEN '\${startDate}' AND '\${endDate}'\`);
    const grouped = users.reduce((acc, u) => {
      acc[u.department] = (acc[u.department] || 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify({ total: users.length, byDepartment: grouped }));
  `,
  inputs: [
    { name: "startDate", type: "string", required: true },
    { name: "endDate", type: "string", required: true }
  ]
});

// Execute forever (~20 tokens per call)
await gateway_execute_skill({
  name: "user-activity-report",
  inputs: { startDate: "2024-01-01", endDate: "2024-01-31" }
});
```

### Layer 6: Result Caching

Identical queries hit the LRU cache instead of re-executing:

```javascript
// First call: Executes tool, caches result
await gateway_call_tool_filtered({ toolName: "db_query", args: { query: "SELECT COUNT(*) FROM users" } });

// Second call: Returns cached result instantly (0 tool execution tokens)
await gateway_call_tool_filtered({ toolName: "db_query", args: { query: "SELECT COUNT(*) FROM users" } });
```

### Layer 7: PII Tokenization

Sensitive data never enters model context while still flowing between tools:

```javascript
// Raw data: { email: "john@example.com", ssn: "123-45-6789" }
// Model sees: { email: "[EMAIL_1]", ssn: "[SSN_1]" }
// Next tool receives: Original values (auto-detokenized)
```

### Combined Token Savings

| Layer | Feature | Typical Savings |
|-------|---------|-----------------|
| 1 | Progressive Disclosure | 85% on tool schemas |
| 2 | Smart Filtering | 60-80% on results |
| 3 | Aggregations | 90%+ on analytics |
| 4 | Code Batching | 60-80% fewer round-trips |
| 5 | Skills | 95%+ on recurring tasks |
| 6 | Caching | 100% on repeated queries |
| 7 | PII Tokenization | Prevents data leakage |

**Real-world impact:** A typical 10-minute agent session with 50 tool calls drops from ~500,000 tokens to ~25,000 tokens.

## Tips for AI Agents

When using MCP Gateway with AI agents (Claude, GPT, etc.), follow these best practices for efficient token usage:

### 1. Start with Tool Discovery
```javascript
// First, get just tool names (minimal tokens)
const names = await gateway_list_tool_names();

// Search for specific functionality
const dbTools = await gateway_search_tools({ query: "database", detailLevel: "name_description" });

// Only load full schema when you need to call a tool
const schema = await gateway_get_tool_schema({ toolName: "mssql_execute_query" });
```

### 2. Use Code Execution for Complex Workflows
```javascript
// Instead of multiple tool calls, batch operations in code
await gateway_execute_code({
  code: `
    const users = await mssql.executeQuery({ query: "SELECT * FROM users WHERE active = 1" });
    const summary = users.reduce((acc, u) => {
      acc[u.department] = (acc[u.department] || 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify(summary));
  `
});
```

### 3. Filter Large Results
```javascript
// Reduce context bloat from large datasets
await gateway_call_tool_filtered({
  toolName: "mssql_get_table_data",
  args: { tableName: "orders" },
  filter: { maxRows: 10, fields: ["id", "status", "total"], format: "summary" }
});

// Smart filtering is ON by default (maxRows: 20, format: "summary")
// Just call without filter - tokens are minimized automatically
await gateway_call_tool_filtered({
  toolName: "mssql_get_table_data",
  args: { tableName: "orders" }
});

// Opt-out for raw results when you need full data
await gateway_call_tool_filtered({
  toolName: "mssql_get_table_data",
  args: { tableName: "orders" },
  smart: false
});
```

### 4. Use Aggregations
```javascript
// Get summaries instead of raw data
await gateway_call_tool_aggregate({
  toolName: "mssql_get_table_data",
  args: { tableName: "orders" },
  aggregation: { operation: "groupBy", groupByField: "status" }
});
```

### 5. Save Reusable Patterns as Skills
```javascript
// Create a skill for common operations
await gateway_create_skill({
  name: "daily-sales-report",
  description: "Generate daily sales summary",
  code: "const sales = await mssql.executeQuery({...}); console.log(sales);",
  tags: ["reporting", "sales"]
});

// Execute later with different inputs
await gateway_execute_skill({ name: "daily-sales-report", inputs: { date: "2024-01-15" } });
```

## macOS Auto-Start (LaunchAgent)

To run the gateway automatically on login:

1. Copy and customize the example plist file:

```bash
# Copy the example file
cp com.mcp-gateway.plist.example ~/Library/LaunchAgents/com.mcp-gateway.plist

# Edit the file to update paths for your installation
nano ~/Library/LaunchAgents/com.mcp-gateway.plist
```

Update these paths in the plist file:
- `/path/to/mcp-gateway` → Your actual installation path
- `/usr/local/bin/node` → Your Node.js path (run `which node` to find it)

2. Load the LaunchAgent:

```bash
# Create logs directory
mkdir -p /path/to/mcp-gateway/logs

# Load (start) the service
launchctl load ~/Library/LaunchAgents/com.mcp-gateway.plist

# Unload (stop) the service
launchctl unload ~/Library/LaunchAgents/com.mcp-gateway.plist

# Restart the service
launchctl kickstart -k gui/$(id -u)/com.mcp-gateway
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Type check
npm run typecheck

# Lint
npm run lint

# Build for production
npm run build
```

## License

MIT
