# ============================================
# GHAGGA Server — Production Dockerfile (Coolify Edition)
# ============================================
# Multi-stage build for self-hosted deployment with Coolify.
# Supports both server (API) and worker (queue processor) modes.
#
# Build context must be the monorepo root:
#   docker build -f apps/server/Dockerfile .
#
# Environment:
#   SERVICE_TYPE=server|worker - Controls startup mode

# ── Stage 1: Install + Build ───────────────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config for dependency layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/types/package.json packages/types/tsconfig.json ./packages/types/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/

# Install all dependencies (including dev for building)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/db/ ./packages/db/
COPY packages/core/ ./packages/core/
COPY packages/types/ ./packages/types/
COPY apps/server/ ./apps/server/
COPY templates/ ./templates/

# Build all packages in dependency order (types re-exports from core; server uses types)
RUN pnpm --filter ghagga-db build && \
    pnpm --filter ghagga-core build && \
    pnpm --filter @ghagga/types build && \
    pnpm --filter @ghagga/server build

# Prune dev dependencies for production image
RUN pnpm prune --prod

# ── Stage 2: Production Runtime ────────────────────────────────
FROM node:22-slim AS runner

# Minimal system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Install CLI tools for cli-bridge provider
# Bump CLI_TOOLS_VERSION to force Docker cache invalidation when tools change
ARG CLI_TOOLS_VERSION=4
# OpenCode: download binary directly (install script fails silently in slim containers)
# Bump OPENCODE_VERSION when upgrading — repo: https://github.com/anomalyco/opencode
ARG OPENCODE_VERSION=1.2.27
RUN curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin && \
    chmod +x /usr/local/bin/opencode && \
    rm -f /tmp/opencode.tar.gz && \
    echo "OpenCode installed: $(opencode --version)"
# Gemini CLI + Copilot CLI via npm — OPTIONAL providers.
# `--loglevel=error` surfaces real install failures in the build log (the root cause)
# while dropping benign npm warnings/notices. `|| true` keeps the build green: these are
# optional, and the presence checks below print a non-enforcing WARNING if a CLI is absent.
RUN npm install -g @google/gemini-cli @github/copilot --loglevel=error || true && \
    (which opencode && opencode --version || echo "WARNING: opencode not installed") && \
    (which gemini || echo "WARNING: gemini-cli not installed") && \
    (which copilot || echo "WARNING: copilot not installed")

WORKDIR /app

# Copy built application + production node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# DB package (dist + migrations + migrate script)
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=builder /app/packages/db/src/migrate.ts ./packages/db/src/migrate.ts

# Core package (dist only)
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules

# Types package (dist only — server imports it type-only; keeps the workspace symlink valid)
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/types/package.json ./packages/types/

# Server package (dist only)
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules

# Workflow templates (read at runtime by injectWorkflow())
COPY --from=builder /app/templates ./templates

ENV NODE_ENV=production

# Startup: run migrations then start server (or worker based on SERVICE_TYPE)
COPY apps/server/start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["./start.sh"]
