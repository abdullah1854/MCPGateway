# Claude Desktop / Claude Code Configuration

Claude Desktop and Claude Code support remote MCP servers through the **Connectors** feature.

## Adding the Gateway to Claude

### Step 1: Open Settings

- **Claude Desktop**: Click the menu icon -> Settings -> Connectors
- **Claude Code**: Open settings panel -> Connectors

### Step 2: Add Remote MCP Server

1. Click **"Add remote MCP server"**
2. Enter your gateway URL:

```
http://localhost:3010/mcp
```

For production:
```
https://your-gateway.example.com/mcp
```

### Step 3: Authentication (if required)

If your gateway uses API key authentication:
- Some Claude versions support adding headers in the UI
- Otherwise, configure authentication in the gateway to allow unauthenticated access from trusted networks

### Step 4: Approve Connection

Claude will prompt you to approve the connection. Review the tools and resources the gateway provides, then approve.

## Token-Efficient Usage

MCP Gateway implements patterns from [Anthropic's Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use) to minimize token consumption:

### 1. Progressive Tool Discovery (Tool Search Tool Pattern)

Instead of loading all tool schemas upfront (200k+ tokens), use gateway meta-tools:

```typescript
// Step 1: List tool names (minimal tokens)
gateway_list_tool_names()

// Step 2: Search by category
gateway_search_tools({ category: "database", detailLevel: "name_description" })

// Step 3: Load schema only when needed
gateway_get_tool_schema({ toolName: "db_query", compact: true })
```

### 2. Programmatic Tool Calling (Code Execution)

Batch operations in code to avoid context pollution from intermediate results:

```typescript
gateway_execute_code({
  code: `
    // Fetch data in parallel
    const [users, orders] = await Promise.all([
      db_list_users(),
      db_list_orders()
    ]);
    
    // Process in code - intermediate data stays out of context
    const summary = users.map(u => ({
      name: u.name,
      orderCount: orders.filter(o => o.userId === u.id).length
    }));
    
    // Only this output enters Claude's context
    console.log(JSON.stringify(summary));
  `
})
```

### 3. Tool Use Examples

When backend tools provide `inputExamples`, use `includeExamples: true` for improved accuracy:

```typescript
gateway_search_tools({
  query: "create ticket",
  detailLevel: "full_schema",
  includeExamples: true
})
```

### 4. Schema Compression

Use `compact: true` to get schemas without descriptions (~40% token savings):

```typescript
// Compact - types only
gateway_get_tool_schema({ toolName: "my_tool", compact: true })

// Batch loading with compression
gateway_get_tool_schemas({
  toolNames: ["tool1", "tool2", "tool3"],
  compact: true
})
```

### 5. Result Filtering

Use filters to control response size:

```typescript
gateway_call_tool_filtered({
  toolName: "db_query",
  args: { sql: "SELECT * FROM users" },
  filter: {
    maxTokens: 1000,  // Stop at ~1000 tokens
    fields: ["id", "name", "email"],  // Only these fields
    format: "summary"  // Returns count + sample
  }
})
```

## Available Tool Categories

Use category filters for targeted discovery:
- `database` - SQL, queries, tables
- `filesystem` - Files, directories  
- `api` - HTTP, REST, webhooks
- `ai` - LLM, embeddings, analysis
- `search` - Search, lookup
- `transform` - Parse, convert, encode
- `auth` - Authentication, tokens
- `messaging` - Email, Slack, notifications

## IDE Configuration Endpoint

Get optimized settings for your IDE:
```bash
curl http://localhost:3010/api/ide-config/claude-code
```

## STDIO Proxy (Alternative)

For local config file support, use the STDIO proxy at `scripts/claude-stdio-proxy.mjs`:

```json
{
  "mcpServers": {
    "mcp-gateway": {
      "command": "node",
      "args": ["/path/to/mcp-gateway/scripts/claude-stdio-proxy.mjs"],
      "env": {
        "MCP_GATEWAY_URL": "http://localhost:3010/mcp"
      }
    }
  }
}
```

## Troubleshooting

### Connection Failed
- Verify gateway is running: `curl http://localhost:3010/health`
- Check CORS settings

### High Token Usage
- Use `compact: true` when loading schemas
- Use category filters in `gateway_search_tools`  
- Use `filter` options with `gateway_call_tool_filtered`
- Check `/metrics/tokens` for efficiency stats
