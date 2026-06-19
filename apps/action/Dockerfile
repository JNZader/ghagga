# ============================================
# GHAGGA GitHub Action — Docker distribution
# ============================================
# This Dockerfile is used when the action.yml specifies `using: docker`
# instead of `using: node20`. The Docker variant includes Semgrep,
# Trivy, and PMD/CPD pre-installed so static analysis runs without
# requiring the user to install anything.
#
# Usage in action.yml:
#   runs:
#     using: docker
#     image: Dockerfile
#
# Note: Docker actions are slower to start (~30-60s image pull)
# compared to node20 actions (~2s). Use the node20 variant for
# fastest startup, or this Docker variant for full static analysis.

# ── Stage 1: Build ──────────────────────────────────────────
# node:22-slim — pinned 2026-03-07
FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9 AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY apps/action/package.json apps/action/tsconfig.json ./apps/action/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/ ./packages/
COPY apps/action/ ./apps/action/

# Build packages (action depends on core, core depends on db types)
RUN pnpm --filter ghagga-db build && \
    pnpm --filter ghagga-core build && \
    pnpm --filter @ghagga/action build

# Prune dev dependencies
RUN pnpm prune --prod

# ── Stage 2: Runtime ────────────────────────────────────────
# node:22-slim — pinned 2026-03-07
FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9

# Install system dependencies for static analysis tools
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

# Install Trivy (direct binary — avoid install.sh from main, compromised in supply chain attack)
ENV TRIVY_VERSION=0.69.3
RUN curl -sL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" -o /tmp/trivy.tar.gz \
    && tar -xzf /tmp/trivy.tar.gz -C /tmp \
    && mv /tmp/trivy /usr/local/bin/trivy \
    && chmod +x /usr/local/bin/trivy \
    && rm -f /tmp/trivy.tar.gz /tmp/LICENSE /tmp/README.md

# Install PMD (for CPD)
ENV PMD_VERSION=7.8.0
RUN curl -sL "https://github.com/pmd/pmd/releases/download/pmd_releases%2F${PMD_VERSION}/pmd-dist-${PMD_VERSION}-bin.zip" \
    -o /tmp/pmd.zip && \
    unzip -q /tmp/pmd.zip -d /opt && \
    mv /opt/pmd-bin-${PMD_VERSION} /opt/pmd && \
    ln -s /opt/pmd/bin/pmd /usr/local/bin/pmd && \
    rm /tmp/pmd.zip

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/apps/action/dist ./apps/action/dist
COPY --from=builder /app/apps/action/package.json ./apps/action/
COPY --from=builder /app/apps/action/node_modules ./apps/action/node_modules
COPY --from=builder /app/package.json ./

# Copy Semgrep rules
COPY packages/core/src/tools/semgrep-rules.yml ./packages/core/src/tools/

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/apps/action/dist/index.js"]
