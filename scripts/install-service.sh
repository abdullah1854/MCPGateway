#!/bin/bash
# MCP Gateway - Install macOS Service
# This script installs the MCP Gateway as a launchd service that starts automatically

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.mcp-gateway.plist"
PLIST_SOURCE="$PROJECT_DIR/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           MCP Gateway - Service Installation                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js first."
    exit 1
fi

NODE_PATH=$(which node)
echo "✅ Found Node.js at: $NODE_PATH"

# Build the project
echo ""
echo "📦 Building MCP Gateway..."
cd "$PROJECT_DIR"
npm run build

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"
echo "✅ Created logs directory"

# Update plist with correct node path
sed -i '' "s|/usr/local/bin/node|$NODE_PATH|g" "$PLIST_SOURCE"
echo "✅ Updated plist with node path"

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$HOME/Library/LaunchAgents"

# Stop existing service if running
if launchctl list | grep -q "com.mcp-gateway"; then
    echo "🔄 Stopping existing service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# Copy plist to LaunchAgents
cp "$PLIST_SOURCE" "$PLIST_DEST"
echo "✅ Copied plist to LaunchAgents"

# Load the service
launchctl load "$PLIST_DEST"
echo "✅ Service loaded"

# Wait for startup
sleep 2

# Check if running
if launchctl list | grep -q "com.mcp-gateway"; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║           ✅ MCP Gateway Service Installed!                  ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║                                                              ║"
    echo "║  Dashboard:   http://localhost:3010/dashboard                ║"
    echo "║  MCP HTTP:    http://localhost:3010/mcp                      ║"
    echo "║  Health:      http://localhost:3010/health                   ║"
    echo "║                                                              ║"
    echo "║  Logs:        $PROJECT_DIR/logs/                 ║"
    echo "║                                                              ║"
    echo "║  Commands:                                                   ║"
    echo "║    Stop:      launchctl unload ~/Library/LaunchAgents/$PLIST_NAME"
    echo "║    Start:     launchctl load ~/Library/LaunchAgents/$PLIST_NAME"
    echo "║    Uninstall: ./scripts/uninstall-service.sh                 ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
else
    echo "❌ Service failed to start. Check logs at: $PROJECT_DIR/logs/"
    exit 1
fi










