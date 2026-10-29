# Tasks: Docker Digest Pinning

**Change ID**: docker-digest-pinning
**Status**: done
**Created**: 2026-03-07

## Digest reference (pinned 2026-03-07)

| Image    | Tag       | Multi-arch manifest digest                                                |
| -------- | --------- | ------------------------------------------------------------------------- |
| node     | 22-slim   | `sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9` |
| postgres | 16-alpine | `sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416` |

## Phase 1: Pin Docker images (single commit)

All changes are config-only text replacements. No code logic changes.

### Task 1: Pin `apps/action/Dockerfile` builder stage [x]

- **File**: `apps/action/Dockerfile`
- **Line 19**: Remove `# TODO(R2-#10): Pin to digest for reproducibility (e.g. node:22-slim@sha256:...)`
- **Line 20**: Change `FROM node:22-slim AS builder` to:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9 AS builder
  ```

### Task 2: Pin `apps/action/Dockerfile` runtime stage [x]

- **File**: `apps/action/Dockerfile`
- **Line 48**: Remove `# TODO(R2-#10): Pin to digest for reproducibility (e.g. node:22-slim@sha256:...)`
- **Line 49**: Change `FROM node:22-slim` to:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9
  ```

### Task 3: Pin `apps/server/Dockerfile` builder stage [x]

- **File**: `apps/server/Dockerfile`
- **Line 12**: Remove `# TODO(R2-#10): Pin to digest for reproducibility (e.g. node:22-slim@sha256:...)`
- **Line 13**: Change `FROM node:22-slim AS builder` to:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9 AS builder
  ```

### Task 4: Pin `apps/server/Dockerfile` runner stage [x]

- **File**: `apps/server/Dockerfile`
- **Line 42**: Remove `# TODO(R2-#10): Pin to digest for reproducibility (e.g. node:22-slim@sha256:...)`
- **Line 43**: Change `FROM node:22-slim AS runner` to:

  ```
  FROM node:22-slim@sha256:9c2c405e3ff9b9afb2873232d24bb06367d649aa3e6259cbe314da59578e81e9 AS runner
  ```

### Task 5: Pin `docker-compose.yml` PostgreSQL image [x]

- **File**: `docker-compose.yml`
- **Line 11**: Change `image: postgres:16-alpine` to:

  ```
  image: postgres:16-alpine@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416
  ```

## Phase 2: Verification

### Task 6: Verify no unpinned Docker images remain [x]

- Run: `grep -rn 'FROM \|image:' apps/action/Dockerfile apps/server/Dockerfile docker-compose.yml`
- Confirm every match includes `@sha256:`
- Confirm no `TODO(R2-#10)` comments remain: `grep -rn 'TODO(R2-#10)' apps/ docker-compose.yml`

## Summary

| #   | File                           | Change                 | Image                |
| --- | ------------------------------ | ---------------------- | -------------------- |
| 1   | `apps/action/Dockerfile:19-20` | Remove TODO + pin FROM | `node:22-slim`       |
| 2   | `apps/action/Dockerfile:48-49` | Remove TODO + pin FROM | `node:22-slim`       |
| 3   | `apps/server/Dockerfile:12-13` | Remove TODO + pin FROM | `node:22-slim`       |
| 4   | `apps/server/Dockerfile:42-43` | Remove TODO + pin FROM | `node:22-slim`       |
| 5   | `docker-compose.yml:11`        | Pin image              | `postgres:16-alpine` |
| 6   | —                              | Verification grep      | —                    |

**Estimated effort**: 15 minutes (all text replacements, no logic)
