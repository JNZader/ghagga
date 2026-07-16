#!/bin/bash
# bash (not /bin/sh) because the worker branch uses `wait -n`, which is a bash
# builtin not available in POSIX sh / dash. node:20-slim (Debian) ships bash.
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
  node apps/server/dist/workers/review.js &
  REVIEW_PID=$!

  echo "🚀 Starting GHAGGA Issue-Analysis Worker..."
  node apps/server/dist/workers/issue-analysis.js &
  ISSUE_PID=$!

  # ── Graceful shutdown ──────────────────────────────────────────────────────
  # On SIGTERM/SIGINT (docker stop / k8s pod termination) FORWARD the signal to
  # BOTH workers so their own graceful-drain handlers (worker.close()) fire, then
  # WAIT for them to finish draining before this bash parent exits. Without this
  # trap the parent dies immediately on the signal and the node workers are
  # ORPHANED — their drain handlers never run and in-flight jobs are lost.
  # `|| true` on the drain wait guards `set -e` if a worker exits non-zero while
  # draining; we still exit 0 because this was an intentional shutdown.
  shutdown() {
    echo "🛑 Signal received — forwarding SIGTERM to workers and waiting for drain..."
    kill -TERM "$REVIEW_PID" "$ISSUE_PID" 2>/dev/null || true
    wait "$REVIEW_PID" "$ISSUE_PID" || true
    exit 0
  }
  trap shutdown TERM INT

  # If EITHER worker exits ON ITS OWN, tear the container down so the orchestrator
  # restarts it (a half-dead worker pair must not look healthy). `wait -n` returns
  # on the first child to exit; a trapped SIGTERM instead interrupts this `wait`
  # and runs `shutdown` (the graceful path above). On an unexpected early exit,
  # kill the survivor before exiting with the dead worker's status.
  # `wait -n || EXIT_CODE=$?` so a non-zero worker exit doesn't trip `set -e`
  # before the explicit survivor-kill + exit below.
  EXIT_CODE=0
  wait -n || EXIT_CODE=$?
  echo "⚠️  A worker process exited (code ${EXIT_CODE}) — shutting down the worker container"
  kill "$REVIEW_PID" "$ISSUE_PID" 2>/dev/null || true
  exit "$EXIT_CODE"
else
  echo "🔄 Running database migrations..."
  cd /app/packages/db && npx tsx src/migrate.ts
  cd /app
  
  echo "🚀 Starting GHAGGA API Server..."
  node apps/server/dist/index.js
fi
