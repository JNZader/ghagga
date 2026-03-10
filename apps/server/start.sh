#!/bin/sh
set -e

# GHAGGA Start Script
# Supports both server (API) and worker (queue processor) modes
# 
# Environment:
#   SERVICE_TYPE=server|worker - Controls which service to start
#   Default: server

SERVICE_TYPE="${SERVICE_TYPE:-server}"

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
