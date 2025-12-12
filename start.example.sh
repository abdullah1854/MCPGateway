#!/bin/bash
# MCP Gateway Launcher
# Run this script to start the MCP Gateway server

# Change to the script's directory (works regardless of where it's called from)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Auto-restart on crash or manual restart from dashboard
while true; do
    echo "Starting MCP Gateway..."
    node dist/index.js
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        echo "Server exited cleanly, restarting..."
        sleep 1
    else
        echo "Server crashed with code $EXIT_CODE, restarting in 3 seconds..."
        sleep 3
    fi
done






































