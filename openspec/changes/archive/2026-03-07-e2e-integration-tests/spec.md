# Spec: Integration Test Suites

**Change ID:** e2e-integration-tests
**Status:** draft
**Created:** 2026-03-07

## Requirements

### R1: Webhook -> Review Dispatch Integration

Test the full HTTP flow from webhook receipt through Inngest event dispatch.

**Scenarios:**
- **S1.1**: Valid PR webhook (`pull_request.opened`) with valid signature triggers `inngest.send()` with correct event name and data shape (installationId, repoFullName, prNumber, headSha, settings).
- **S1.2**: Invalid signature returns 401 and does NOT dispatch to Inngest.
- **S1.3**: Non-PR event types (e.g., `star`, `push`) are acknowledged with 200 but do NOT dispatch.
- **S1.4**: Comment trigger (`issue_comment` with "ghagga review" keyword from authorized user on a PR) dispatches review with `triggerCommentId` set.
- **S1.5**: Comment trigger from unauthorized association (NONE) does NOT dispatch.

**Mocked dependencies:**
- `ghagga-db`: `getRepoByGithubId`, `getEffectiveRepoSettings`
- `../inngest/client.js`: `inngest.send()`
- `../github/client.js`: `verifyWebhookSignature` (use real implementation with test secret), `getInstallationToken`, `fetchPRDetails`, `addCommentReaction`

### R2: API Endpoints with Auth Integration

Test API routes are properly gated by auth middleware and return correct data.

**Scenarios:**
- **S2.1**: Authenticated request to `GET /api/repositories` returns repo list from user's installations.
- **S2.2**: Authenticated request to `GET /api/stats?repo=owner/repo` returns mapped stats data.
- **S2.3**: Request without Authorization header returns 401.
- **S2.4**: Request with invalid/expired token returns 401.
- **S2.5**: Authenticated user accessing repo from different installation returns 403.

**Mocked dependencies:**
- `ghagga-db`: all DB query functions
- Global `fetch`: to mock `https://api.github.com/user` call in auth middleware

### R3: Core Review Pipeline Integration

Test the pipeline orchestrator produces correct output with mocked providers.

**Scenarios:**
- **S3.1**: Pipeline in `simple` mode with mocked AI provider produces a `ReviewResult` with status, summary, findings, and metadata.
- **S3.2**: Pipeline with memory enabled calls memory search and persist.
- **S3.3**: Pipeline degrades gracefully when static analysis tool throws — returns result with AI findings and error-state tools.
- **S3.4**: Pipeline with all files filtered by ignore patterns returns SKIPPED status.

**Mocked dependencies:**
- `./agents/simple.js`: `runSimpleReview`
- `./tools/runner.js`: `runStaticAnalysis`, `formatStaticAnalysisContext`
- `./memory/search.js`: `searchMemoryForContext`
- `./memory/persist.js`: `persistReviewObservations`

## Non-functional Requirements

- **NF1**: All integration tests complete in < 5 seconds total.
- **NF2**: No real network calls (all external HTTP mocked).
- **NF3**: Tests are filterable via `describe('integration:')` naming.
- **NF4**: Zero impact on existing test suite (no modified production code).
