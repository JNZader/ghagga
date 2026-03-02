# ============================================
# GHAGGA Server — Production Dockerfile
# ============================================
# Multi-stage build for Render deployment.
# Builds the full monorepo, prunes dev deps, and
# runs the Hono server on the specified PORT.
#
# Build context must be the monorepo root:
#   docker build -f apps/server/Dockerfile .

# ── Stage 1: Install + Build ───────────────────────────────────
FROM node:22-slim AS builder

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
FROM node:22-slim AS runner

# Install system deps for static analysis tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    default-jre-headless \
    curl \
    unzip \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Semgrep
RUN pip3 install --no-cache-dir --break-system-packages semgrep

# Install Trivy
RUN curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Install PMD (for CPD — copy/paste detection)
ENV PMD_VERSION=7.8.0
RUN curl -sL "https://github.com/pmd/pmd/releases/download/pmd_releases%2F${PMD_VERSION}/pmd-dist-${PMD_VERSION}-bin.zip" \
    -o /tmp/pmd.zip && \
    unzip -q /tmp/pmd.zip -d /opt && \
    mv /opt/pmd-bin-${PMD_VERSION} /opt/pmd && \
    ln -s /opt/pmd/bin/pmd /usr/local/bin/pmd && \
    rm /tmp/pmd.zip

RUN corepack enable && corepack prepare pnpm@9 --activate

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

# Copy Semgrep rules for static analysis
COPY --from=builder /app/packages/core/src/tools/semgrep-rules.yml ./packages/core/src/tools/

ENV NODE_ENV=production

# Startup: run migrations then start server
COPY apps/server/start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 3000

CMD ["./start.sh"]
