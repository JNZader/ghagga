# Proposal: Docker Digest Pinning

**Change ID**: docker-digest-pinning
**Status**: proposed
**Created**: 2026-03-07
**Audit ref**: R2-#10

## Intent

Pin all Docker base images to their SHA256 digest to ensure reproducible, tamper-proof builds. This mirrors the approach already taken for GitHub Actions (pinned to commit SHAs in Batch 5) and closes the remaining supply-chain gap identified in audit R2 item #10.

## Scope

### In scope

- `apps/action/Dockerfile` — two `FROM node:22-slim` statements (builder + runtime stages)
- `apps/server/Dockerfile` — two `FROM node:22-slim` statements (builder + runner stages)
- `docker-compose.yml` — one `image: postgres:16-alpine` statement
- Remove the existing `TODO(R2-#10)` comments from both Dockerfiles

### Out of scope

- `node_modules/.pnpm/sql.js@1.14.1/.../.devcontainer/Dockerfile` — third-party vendored file, not our code
- `ghagga-runner-template` repo — contains no Dockerfiles (only GitHub Actions workflow YAML)
- CI workflow files (`.github/workflows/*.yml`) — no Docker image references; GitHub Actions already SHA-pinned
- Upgrading image tags (e.g., `node:22-slim` → `node:24-slim`) — separate concern

## Approach

1. Use the multi-architecture manifest digest (not platform-specific) so builds work on both amd64 and arm64 (developer laptops, CI runners, deployment targets)
2. Keep the human-readable tag alongside the digest for maintainability: `FROM node:22-slim@sha256:...`
3. Add an inline comment on each `FROM`/`image:` line noting the pin date for future rotation awareness

## Current digests (as of 2026-03-07)

| Image                | Multi-arch manifest digest                                                |
| -------------------- | ------------------------------------------------------------------------- |
| `node:22-slim`       | `sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9` |
| `postgres:16-alpine` | `sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416` |

## Risks

| Risk                                            | Likelihood | Mitigation                                                                                                       |
| ----------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Digest becomes stale (missing security patches) | Medium     | Document pin date in comments. Schedule periodic digest rotation (quarterly or on CVE alerts).                   |
| Digest points to a removed manifest             | Low        | Docker Hub retains tagged manifests for years. If a manifest is removed, CI will fail loudly on `docker build`.  |
| Developer confusion about digest syntax         | Low        | The `tag@sha256:...` format is standard Docker syntax. Add a comment explaining the pattern on first occurrence. |

## Acceptance criteria

- [ ] All `FROM` statements in project Dockerfiles use `tag@sha256:digest` format
- [ ] The `image:` statement in `docker-compose.yml` uses `tag@sha256:digest` format
- [ ] All `TODO(R2-#10)` comments are removed from Dockerfiles
- [ ] `docker build -f apps/action/Dockerfile .` succeeds (if Docker is available)
- [ ] `docker build -f apps/server/Dockerfile .` succeeds (if Docker is available)
- [ ] `docker compose config` parses successfully with the pinned image
