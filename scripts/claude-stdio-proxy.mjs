#!/usr/bin/env node
/**
 * STDIO to HTTP Proxy for Claude Desktop
 * This script allows Claude Desktop to connect to the MCP Gateway via STDIO
 */

import { createInterface } from 'readline';

const GATEWAY_URL = process.env.MCP_GATEWAY_URL || 'http://localhost:3010/mcp';
let sessionId = null;

const rl = createInterface({
  input: process.stdin,
  terminal: false,
});

async function sendToGateway(message) {
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const response = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });

    // Store session ID
    const newSessionId = response.headers.get('Mcp-Session-Id');
    if (newSessionId) {
      sessionId = newSessionId;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: {
        code: -32603,
        message: error.message,
      },
    };
  }
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line);
    const response = await sendToGateway(message);
    
    // Only send response if it's a request (has id)
    if (response && message.id !== undefined) {
      console.log(JSON.stringify(response));
    }
  } catch (error) {
    console.error(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error: ' + error.message,
      },
    }));
  }
});

rl.on('close', () => {
  process.exit(0);
});

// Handle SIGINT
process.on('SIGINT', () => {
  process.exit(0);
});


