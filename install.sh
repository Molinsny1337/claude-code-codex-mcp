#!/usr/bin/env bash
set -e

echo "=============================================="
echo " Installing Claude Code Codex MCP (Unix) "
echo "=============================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[1/3] Installing dependencies..."
npm install

echo "[2/3] Verifying MCP server..."
node test/test.mjs

echo "[3/3] Registering with Claude Code (user scope)..."
INDEX_PATH="$SCRIPT_DIR/src/index.mjs"

if command -v claude &> /dev/null; then
    claude mcp add -s user codex node "$INDEX_PATH"
    echo ""
    echo "[SUCCESS] Successfully added 'codex' MCP server to Claude Code!"
    echo "Run 'claude mcp list' to check server status."
else
    echo ""
    echo "[NOTICE] 'claude' CLI not found in PATH."
    echo "Register manually after installing Claude Code:"
    echo "  claude mcp add -s user codex node \"$INDEX_PATH\""
fi
