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

# Base image pinned by digest for supply-chain reproducibility (SEC-005), shared by
# both the builder and runner stages so they can never drift apart.
#
# Digest resolved 2026-07-10 via `docker buildx imagetools inspect node:22-slim`
# (multi-arch index digest for the `node:22-slim` tag at pin time). Re-resolve
# periodically to pick up base-image security patches, e.g.:
#   docker buildx imagetools inspect node:22-slim --format '{{json .Manifest}}'
# or `crane digest node:22-slim` / `regctl image digest node:22-slim`.
ARG NODE_BASE_IMAGE=node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

# ── Stage 1: Install + Build ───────────────────────────────────
FROM ${NODE_BASE_IMAGE} AS builder

# Pin pnpm to an exact version (not a floating major) so `corepack prepare` is reproducible.
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config for dependency layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/types/package.json packages/types/tsconfig.json ./packages/types/
COPY packages/forge/package.json packages/forge/tsconfig.json ./packages/forge/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/

# Install all dependencies (including dev for building)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/db/ ./packages/db/
COPY packages/core/ ./packages/core/
COPY packages/types/ ./packages/types/
COPY packages/forge/ ./packages/forge/
COPY apps/server/ ./apps/server/
COPY templates/ ./templates/

# Build all packages in dependency order (types re-exports from core; forge imports
# core in type-position only; server uses types + forge).
RUN pnpm --filter ghagga-db build && \
    pnpm --filter ghagga-core build && \
    pnpm --filter @ghagga/types build && \
    pnpm --filter ghagga-forge build && \
    pnpm --filter @ghagga/server build

# Prune dev dependencies for production image
RUN pnpm prune --prod

# ── Stage 2: Production Runtime ────────────────────────────────
FROM ${NODE_BASE_IMAGE} AS runner

# Minimal system deps. Package versions come from the pinned base image's apt
# snapshot, so this is reproducible as long as NODE_BASE_IMAGE stays pinned by digest.
# - redis-tools: `redis-cli` used by the worker-mode HEALTHCHECK (PRODOPS-004; the
#   worker has no HTTP server, so it can't reuse the server's /health probe).
# - procps: `pgrep` used by the same worker-mode HEALTHCHECK to confirm the worker
#   process itself is alive, not just that Redis is reachable.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    redis-tools \
    procps \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Install CLI tools for cli-bridge provider
# Bump CLI_TOOLS_VERSION to force Docker cache invalidation when tools change
ARG CLI_TOOLS_VERSION=4
# OpenCode: download binary directly (install script fails silently in slim containers)
# Bump OPENCODE_VERSION when upgrading — repo: https://github.com/anomalyco/opencode
ARG OPENCODE_VERSION=1.2.27
# SHA256 of opencode-linux-x64.tar.gz for the pinned OPENCODE_VERSION above. Upstream
# does not publish a checksum/signature file for this asset (only desktop-app artifacts
# are `.sig`-signed), so this value was computed by downloading and hashing the release
# asset directly (`curl -fsSL <url> | sha256sum`) at pin time (2026-07-10). Recompute and
# update BOTH values together whenever OPENCODE_VERSION is bumped — a stale hash here
# will correctly fail the build (SEC-005: verify downloads, don't trust-on-first-use).
ARG OPENCODE_SHA256=6fe3820b145857f7ff507d2826058b7acf1fce8258def1498468dd43809e69e8
RUN curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" && \
    echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin && \
    chmod +x /usr/local/bin/opencode && \
    rm -f /tmp/opencode.tar.gz && \
    echo "OpenCode installed: $(opencode --version)"
# Gemini CLI + Copilot CLI via npm — OPTIONAL *providers at runtime* (the app degrades
# gracefully if unconfigured), but NOT optional at build time: pin exact versions and let
# install failures fail the build loudly (SEC-005). Versions verified against the npm
# registry at pin time (2026-07-10); bump deliberately, not via a floating range.
ARG GEMINI_CLI_VERSION=0.50.0
ARG COPILOT_CLI_VERSION=1.0.70
RUN npm install -g "@google/gemini-cli@${GEMINI_CLI_VERSION}" "@github/copilot@${COPILOT_CLI_VERSION}" --loglevel=error && \
    which opencode && opencode --version && \
    which gemini && \
    which copilot

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

# Forge package (dist + package.json — server imports ghagga-forge at runtime;
# the exports map resolves to ./dist, so the built dist MUST ship. node_modules
# carries forge's own deps for the symlink.)
COPY --from=builder /app/packages/forge/dist ./packages/forge/dist
COPY --from=builder /app/packages/forge/package.json ./packages/forge/
COPY --from=builder /app/packages/forge/node_modules ./packages/forge/node_modules

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

# ── Non-root runtime user (SEC-005) ─────────────────────────────
# `node:*-slim` images ship an unprivileged `node` user/group (uid/gid 1000)
# out of the box — reuse it instead of minting a new one.
#
# The tool-plugin system (packages/core/src/tools/plugins/*) lazily installs
# static-analysis binaries (semgrep, trivy, gitleaks, hadolint, golangci-lint,
# zizmor, shellcheck, PMD/CPD) into /usr/local/bin and /opt/pmd on first use, at
# *runtime*, not at build time. Running fully read-only/root-owned would silently
# break that feature under a non-root user, so those two directories are
# group-owned and group-writable by `node` — everything else stays root-owned.
# `/tmp` is left as-is (world-writable + sticky bit by default), which already
# covers the mkdtemp()-based scratch dirs (e.g. semgrep, cli-bridge prompts).
RUN mkdir -p /opt/pmd && \
    chown -R root:node /app /usr/local/bin /opt/pmd && \
    chmod -R g+rwX /app /usr/local/bin /opt/pmd

USER node

EXPOSE 3000

# Worker-aware healthcheck (PRODOPS-004): the API server serves HTTP and can be
# probed at /health, but the worker (SERVICE_TYPE=worker) only runs a BullMQ
# consumer — hitting localhost:3000/health there always fails and marks a
# perfectly healthy worker as unhealthy forever. Branch on SERVICE_TYPE instead:
#   - server: original HTTP /health probe.
#   - worker: the worker process must be alive (pgrep) AND Redis must be
#     reachable (redis-cli PING), preferring REDIS_URL when set, falling back to
#     REDIS_HOST/REDIS_PORT to match apps/server/src/lib/redis.ts's own fallback.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD sh -c '\
    if [ "$SERVICE_TYPE" = "worker" ]; then \
      pgrep -f "workers/review.js" >/dev/null || exit 1; \
      if [ -n "$REDIS_URL" ]; then \
        redis-cli -u "$REDIS_URL" ping 2>/dev/null | grep -q PONG || exit 1; \
      else \
        redis-cli -h "${REDIS_HOST:-redis}" -p "${REDIS_PORT:-6379}" ping 2>/dev/null | grep -q PONG || exit 1; \
      fi; \
    else \
      node -e "fetch(\"http://localhost:3000/health\").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || exit 1; \
    fi'

CMD ["./start.sh"]
