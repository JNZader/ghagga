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
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config for dependency layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/

# Install all dependencies (including dev for building)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/db/ ./packages/db/
COPY packages/core/ ./packages/core/
COPY apps/server/ ./apps/server/

# Build all packages in dependency order
RUN pnpm --filter ghagga-db build && \
    pnpm --filter ghagga-core build && \
    pnpm --filter @ghagga/server build

# Prune dev dependencies for production image
RUN pnpm prune --prod

# ── Stage 2: Production Runtime ────────────────────────────────
FROM node:20-slim AS runner

# Minimal system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Install CLI tools for cli-bridge provider (uses subscriptions, not API tokens)
# Gemini CLI: free tier 1M tokens/day — set GEMINI_API_KEY env var
# Copilot CLI: @github/copilot — set COPILOT_GITHUB_TOKEN env var
RUN npm install -g @google/gemini-cli @github/copilot 2>/dev/null || true

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

# Server package (dist only)
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules

ENV NODE_ENV=production

# Startup: run migrations then start server (or worker based on SERVICE_TYPE)
COPY apps/server/start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["./start.sh"]
