#!/bin/bash
# MCP Gateway - Uninstall macOS Service

set -e

PLIST_NAME="com.mcp-gateway.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           MCP Gateway - Service Uninstallation               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Stop the service if running
if launchctl list | grep -q "com.mcp-gateway"; then
    echo "🔄 Stopping MCP Gateway service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    echo "✅ Service stopped"
fi

# Remove the plist
if [ -f "$PLIST_DEST" ]; then
    rm "$PLIST_DEST"
    echo "✅ Removed plist from LaunchAgents"
fi

echo ""
echo "✅ MCP Gateway service uninstalled successfully!"
echo ""
echo "To reinstall, run: ./scripts/install-service.sh"



















































