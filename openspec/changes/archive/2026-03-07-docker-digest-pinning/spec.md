# Spec: Docker Digest Pinning

**Change ID**: docker-digest-pinning
**Status**: specified
**Created**: 2026-03-07

## Requirements

### REQ-1: All Docker FROM statements must include a digest

Every `FROM` instruction in project-owned Dockerfiles MUST use the format:

```dockerfile
FROM <image>:<tag>@sha256:<digest>
```

This ensures the exact image layer set is locked regardless of tag mutations on Docker Hub.

### REQ-2: Docker Compose image references must include a digest

Every `image:` field in `docker-compose.yml` MUST use the format:

```yaml
image: <image>:<tag>@sha256:<digest>
```

### REQ-3: Multi-architecture manifest digests must be used

The digest MUST be the multi-architecture manifest digest (not a platform-specific digest) so that builds work on amd64, arm64, and other supported platforms without modification.

### REQ-4: Human-readable tags must be preserved

The human-readable tag (e.g., `22-slim`, `16-alpine`) MUST be kept alongside the digest for developer readability. The tag serves as documentation of the intended image version.

### REQ-5: TODO comments must be removed

All `TODO(R2-#10)` comments in Dockerfiles that reference this pinning work MUST be removed upon implementation.

## Scenarios

### Scenario 1: Action Dockerfile — Builder stage

- GIVEN `apps/action/Dockerfile` line 20
- WHEN the image is pinned
- THEN the line MUST read:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9 AS builder
  ```
- AND the `TODO(R2-#10)` comment on line 19 MUST be removed

### Scenario 2: Action Dockerfile — Runtime stage

- GIVEN `apps/action/Dockerfile` line 49
- WHEN the image is pinned
- THEN the line MUST read:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9
  ```
- AND the `TODO(R2-#10)` comment on line 48 MUST be removed

### Scenario 3: Server Dockerfile — Builder stage

- GIVEN `apps/server/Dockerfile` line 13
- WHEN the image is pinned
- THEN the line MUST read:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9 AS builder
  ```
- AND the `TODO(R2-#10)` comment on line 12 MUST be removed

### Scenario 4: Server Dockerfile — Runner stage

- GIVEN `apps/server/Dockerfile` line 43
- WHEN the image is pinned
- THEN the line MUST read:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9 AS runner
  ```
- AND the `TODO(R2-#10)` comment on line 42 MUST be removed

### Scenario 5: Docker Compose — PostgreSQL image

- GIVEN `docker-compose.yml` line 11
- WHEN the image is pinned
- THEN the line MUST read:

  ```
  image: postgres:16-alpine@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416
  ```

## Edge cases

### No Docker image references in CI workflows

The CI workflow files (`.github/workflows/*.yml`) do not contain any `image:` fields for Docker containers — they only use `runs-on: ubuntu-latest` (GitHub-hosted runners). No changes needed.

### Runner template has no Dockerfiles

The `ghagga-runner-template` repository contains only a GitHub Actions workflow YAML file and a README. No Docker images to pin.

### Third-party Dockerfiles in node_modules

The file `node_modules/.pnpm/sql.js@1.14.1/.../.devcontainer/Dockerfile` is a vendored third-party file and MUST NOT be modified.
