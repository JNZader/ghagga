# Spec: CI Hardening

**Change ID**: ci-hardening
**Status**: approved
**Created**: 2026-03-07

## Requirements

### REQ-1: Security Scanning Job

- **R1.1**: CI must include a `security` job that runs on every push and PR to main
- **R1.2**: Job runs `pnpm audit --prod --audit-level=high` to flag high/critical vulnerabilities
- **R1.3**: Job uses `continue-on-error: true` — it warns but does not block CI
- **R1.4**: Job runs in parallel with existing `check` and `lint` jobs (no dependencies)

### REQ-2: Coverage Reporting

- **R2.1**: The existing `test` job must run `pnpm exec turbo test:coverage` instead of `pnpm exec turbo test`
- **R2.2**: All workspace packages already define `test:coverage` scripts — no package.json changes needed
- **R2.3**: Coverage output directories must be uploaded as CI artifacts with 7-day retention
- **R2.4**: No external coverage services required (no Codecov, no SonarCloud)

### REQ-3: Mutation Testing Job

- **R3.1**: CI must include a `mutation` job that runs **only** on pushes to main (`github.event_name == 'push'`)
- **R3.2**: Job runs after tests pass: `needs: [test]`
- **R3.3**: Job runs Stryker only on `packages/core` (most critical code)
- **R3.4**: Job has a 30-minute `timeout-minutes` limit
- **R3.5**: Job uses `continue-on-error: true` — mutation score is informational
- **R3.6**: Mutation report is uploaded as a CI artifact

## Scenarios

### Scenario 1: PR triggers CI

- `security` job runs, may warn about advisories
- `check` and `lint` jobs run in parallel
- `test` job runs with coverage after check+lint pass
- Coverage artifacts are uploaded
- `mutation` job does NOT run (PR, not push to main)

### Scenario 2: Push to main triggers CI

- All of Scenario 1, plus:
- `mutation` job runs after `test` completes
- Stryker runs on `packages/core` with 30-min timeout
- Mutation report artifact is uploaded

### Scenario 3: pnpm audit finds high vulnerability

- `security` job reports the vulnerability in logs
- CI continues (does not fail) due to `continue-on-error: true`

## Edge Cases

- **Stryker exceeds timeout**: Job is killed at 30 minutes, CI continues
- **No coverage data generated**: Artifact upload uses `if-no-files-found: ignore`
- **pnpm audit network error**: `continue-on-error` prevents CI failure
