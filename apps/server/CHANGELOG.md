# @ghagga/server

## 3.1.1

### Patch Changes

- Updated dependencies
  - ghagga-core@3.5.0
  - ghagga-db@3.5.0
  - ghagga-forge@3.5.0
  - @ghagga/types@3.0.5

## 3.1.0

### Minor Changes

- 1f62ef2: Add a reaper that recovers issue-triage drafts stuck in `APPROVED` after a poster process crashed between posting the GitHub comment and recording it. A per-draft HTML marker (`<!-- ghagga-issue-draft:{id} -->`) is embedded in the posted comment so the reaper can correlate exactly; on each tick it lists the issue's comments and, if the draft's marker is found on an app-bot-authored comment, records it as `POSTED` (never re-posting), otherwise releases the claim back to `DRAFT` for a human to retry. Read failures skip (never act on an ambiguous read). Runs as a self-guarded `setInterval` in the issue-analysis worker; tunable via `ISSUE_DRAFT_REAPER_ENABLED` / `ISSUE_DRAFT_REAPER_INTERVAL_MS` / `ISSUE_DRAFT_REAPER_STALE_MS`, and `GITHUB_APP_SLUG` for exact bot-author verification.

### Patch Changes

- Updated dependencies [fefa99e]
- Updated dependencies [56dca64]
- Updated dependencies [8411136]
- Updated dependencies [a1239d3]
- Updated dependencies [fdfacff]
- Updated dependencies [089a5b6]
- Updated dependencies [91930f4]
- Updated dependencies [8f11441]
- Updated dependencies [bbdd7a4]
- Updated dependencies [a86a886]
- Updated dependencies [3a25d6f]
  - ghagga-core@3.4.0
  - ghagga-db@3.4.0
  - ghagga-forge@3.4.0
  - @ghagga/types@3.0.4

## 3.0.3

### Patch Changes

- Updated dependencies
- Updated dependencies [8989e0d]
  - ghagga-core@3.3.0
  - ghagga-forge@3.3.0
  - @ghagga/types@3.0.3
  - ghagga-db@3.3.0

## 3.0.2

### Patch Changes

- Updated dependencies [8cc5cdd]
  - ghagga-core@3.2.0
  - ghagga-db@3.2.0
  - ghagga-forge@3.2.0
  - @ghagga/types@3.0.2

## 3.0.1

### Patch Changes

- Updated dependencies [a2a537e]
  - ghagga-forge@3.1.0
  - ghagga-core@3.1.0
  - @ghagga/types@3.0.1
  - ghagga-db@3.1.0

## 2.8.2

### Patch Changes

- Updated dependencies [2c4480b]
- Updated dependencies [e1fbfad]
- Updated dependencies
  - ghagga-core@3.0.0
  - ghagga-db@3.0.0
  - @ghagga/types@2.8.2
