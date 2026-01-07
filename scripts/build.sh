#!/bin/bash
# Atomic build script - prevents crashes during TypeScript compilation
# The dist/ folder is never in an incomplete state

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMP_DIR="$PROJECT_DIR/.dist-build"
DIST_DIR="$PROJECT_DIR/dist"

cd "$PROJECT_DIR"

# Clean temp directory
rm -rf "$TEMP_DIR"

# Build to temp directory
echo "Building to temporary directory..."
npx tsc --outDir "$TEMP_DIR"

# Atomic swap: only replace dist if build succeeded
if [ -f "$TEMP_DIR/index.js" ]; then
    echo "Build successful, swapping directories..."
    
    # Remove old dist and rename temp to dist (atomic on same filesystem)
    rm -rf "$DIST_DIR"
    mv "$TEMP_DIR" "$DIST_DIR"
    
    echo "Build complete!"
else
    echo "Build failed - dist/index.js not found in temp directory"
    rm -rf "$TEMP_DIR"
    exit 1
fi



