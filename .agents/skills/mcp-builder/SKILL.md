---
name: mcp-builder
description: Build high-quality MCP servers that enable LLMs to interact with external services. Activates for "MCP server", "MCP tool", "build MCP", "create server", "Model Context Protocol".
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task]
---

# MCP Server Development Skill

## When This Skill Activates
- "Build an MCP server", "create MCP tools"
- "Model Context Protocol", "MCP integration"
- "Add tools to Claude", "extend Claude capabilities"
- "Connect Claude to [service]"

## Four-Phase Development Process

### Phase 1: Research & Planning

**Before writing code:**
1. Study the target API/service documentation
2. Identify core use cases (what will users actually do?)
3. Balance coverage vs specialization
4. Design tool naming conventions

**Stack recommendation:**
- **TypeScript** with Streamable HTTP transport (recommended)
- Python with FastMCP for rapid prototyping

**Tool design principles:**
```
✓ Action-oriented names: "create_issue", "search_files"
✗ Vague names: "process", "handle", "do_thing"

✓ Focused data returns (what LLM needs)
✗ Raw API dumps (overwhelming, token-heavy)

✓ Actionable error messages: "Repository not found: check owner/repo format"
✗ Generic errors: "API error 404"
```

### Phase 2: Implementation

**Project structure:**
```
my-mcp-server/
├── src/
│   ├── index.ts          # Entry point
│   ├── server.ts         # MCP server setup
│   ├── tools/            # Tool implementations
│   │   ├── search.ts
│   │   └── create.ts
│   ├── auth/             # Authentication
│   └── utils/            # Helpers
├── package.json
├── tsconfig.json
└── README.md
```

**TypeScript MCP server template:**
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-service",
  version: "1.0.0",
});

// Define tool with Zod schema
server.tool(
  "search_items",
  "Search for items by query",
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().default(10).describe("Max results"),
  },
  async ({ query, limit }) => {
    // Implementation
    const results = await searchService(query, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }
);

// Tool annotations (important for LLM behavior)
server.tool(
  "delete_item",
  "Permanently delete an item",
  {
    id: z.string().describe("Item ID to delete"),
  },
  async ({ id }) => {
    await deleteItem(id);
    return { content: [{ type: "text", text: `Deleted ${id}` }] };
  },
  {
    annotations: {
      destructiveHint: true,    // Warns LLM this is destructive
      idempotentHint: false,    // Not safe to retry
      readOnlyHint: false,      // Modifies state
    },
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Python FastMCP template:**
```python
from fastmcp import FastMCP
from pydantic import Field

mcp = FastMCP("my-service")

@mcp.tool()
def search_items(
    query: str = Field(description="Search query"),
    limit: int = Field(default=10, description="Max results")
) -> list[dict]:
    """Search for items by query."""
    results = search_service(query, limit)
    return results

@mcp.tool(destructive=True)
def delete_item(id: str = Field(description="Item ID")) -> str:
    """Permanently delete an item."""
    delete_service(id)
    return f"Deleted {id}"

if __name__ == "__main__":
    mcp.run()
```

### Phase 3: Review & Test

**Quality checklist:**
```
[ ] All tools have clear, action-oriented names
[ ] Input schemas use Zod/Pydantic with descriptions
[ ] Errors are actionable (not just status codes)
[ ] Destructive operations marked with annotations
[ ] Read-only operations marked as such
[ ] Rate limiting handled gracefully
[ ] Authentication errors caught and explained
[ ] Response data is focused (not raw API dumps)
```

**Testing with MCP Inspector:**
```bash
npx @anthropics/mcp-inspector
# Opens browser UI to test tools interactively
```

### Phase 4: Evaluation

**Create test questions (10 minimum):**
```markdown
1. "Search for [specific item]" - Tests basic search
2. "Create a new [item] with [properties]" - Tests creation
3. "Find all [items] created last week" - Tests filtering
4. "Delete [item] and verify it's gone" - Tests destructive ops
5. "What happens if I search for something that doesn't exist?" - Tests error handling
...
```

## Tool Annotations Reference

| Annotation | Type | Purpose |
|------------|------|---------|
| `readOnlyHint` | boolean | Tool doesn't modify state |
| `destructiveHint` | boolean | Tool deletes/destroys data |
| `idempotentHint` | boolean | Safe to retry on failure |
| `openWorldHint` | boolean | Interacts with external world |

## Common Patterns

### Pagination
```typescript
server.tool(
  "list_items",
  "List items with pagination",
  {
    page: z.number().optional().default(1),
    per_page: z.number().optional().default(20).max(100),
  },
  async ({ page, per_page }) => {
    const { items, total, has_more } = await listItems(page, per_page);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          items,
          pagination: { page, per_page, total, has_more }
        }, null, 2)
      }]
    };
  }
);
```

### Bulk Operations
```typescript
server.tool(
  "bulk_update",
  "Update multiple items at once",
  {
    updates: z.array(z.object({
      id: z.string(),
      changes: z.record(z.unknown())
    }))
  },
  async ({ updates }) => {
    const results = await Promise.allSettled(
      updates.map(u => updateItem(u.id, u.changes))
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          successful: results.filter(r => r.status === 'fulfilled').length,
          failed: results.filter(r => r.status === 'rejected').length,
        })
      }]
    };
  }
);
```

## Deployment

**Claude Desktop config:**
```json
{
  "mcpServers": {
    "my-service": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

**Docker deployment:**
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

## Output Format

```markdown
## MCP Server: [Service Name]

### Tools Implemented
| Tool | Description | Annotations |
|------|-------------|-------------|
| search_items | Search by query | readOnly |
| create_item | Create new item | - |
| delete_item | Delete item | destructive |

### Configuration
[Claude Desktop JSON config]

### Testing
[Test questions and expected results]

### Next Steps
[Any pending work]
```
