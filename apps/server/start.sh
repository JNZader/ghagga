#!/bin/sh
set -e

# GHAGGA Start Script
# Supports both server (API) and worker (queue processor) modes
# 
# Environment:
#   SERVICE_TYPE=server|worker - Controls which service to start
#   Default: server

SERVICE_TYPE="${SERVICE_TYPE:-server}"

# Log available CLI tools for debugging
echo "🔍 CLI tools check:"
echo "  PATH=$PATH"
which opencode && echo "  ✅ opencode: $(opencode --version 2>&1)" || echo "  ❌ opencode: NOT FOUND"
which gemini && echo "  ✅ gemini: found" || echo "  ❌ gemini: NOT FOUND"
which copilot && echo "  ✅ copilot: found" || echo "  ❌ copilot: NOT FOUND"
ls -la /usr/local/bin/opencode 2>/dev/null || echo "  ℹ️  /usr/local/bin/opencode does not exist"

if [ "$SERVICE_TYPE" = "worker" ]; then
  echo "🚀 Starting GHAGGA Review Worker..."
  node apps/server/dist/workers/review.js
else
  echo "🔄 Running database migrations..."
  cd /app/packages/db && npx tsx src/migrate.ts
  cd /app
  
  echo "🚀 Starting GHAGGA API Server..."
  node apps/server/dist/index.js
fi
