# Claude Desktop / Claude Code Configuration

Claude Desktop and Claude Code support remote MCP servers through the **Connectors** feature.

## Adding the Gateway to Claude

### Step 1: Open Settings

- **Claude Desktop**: Click the menu icon → Settings → Connectors
- **Claude Code**: Open settings panel → Connectors

### Step 2: Add Remote MCP Server

1. Click **"Add remote MCP server"**
2. Enter your gateway URL:

```
http://localhost:3000/mcp
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

## Important Notes

1. **Remote servers require UI configuration** - Claude doesn't support adding remote MCP servers in local config files
2. **SSE is supported** but may be phased out - use HTTP Streamable (`/mcp`) for future compatibility
3. **HTTPS recommended** for production - use a reverse proxy like nginx or Caddy

## Troubleshooting

### Connection Failed

- Verify the gateway is running: `curl http://localhost:3000/health`
- Check CORS settings in the gateway
- Ensure the URL is accessible from your machine

### No Tools Appearing

- Check the gateway health endpoint for backend status
- Verify backend servers are enabled in `config/servers.json`
- Check gateway logs for connection errors

### Authentication Errors

- Verify the API key is correct
- Check the `AUTH_MODE` environment variable
- Ensure the key is in the `API_KEYS` list

