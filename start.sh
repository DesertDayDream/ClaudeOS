#!/bin/sh
# Starts ClaudeOS and opens it in your browser (macOS / Linux).
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "ClaudeOS needs Node.js 18 or newer: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
exec node server.mjs --open
