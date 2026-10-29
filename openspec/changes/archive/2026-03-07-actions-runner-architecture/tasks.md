# Tasks: Migrate Static Analysis to GitHub Actions Runner Architecture

**Change**: actions-runner-architecture
**Artifacts**: [proposal](proposal.md) · [spec](spec.md) · [design](design.md)
**Estimated Total**: 26 tasks across 5 phases

---

## Phase 0: Google Cloud Cleanup & Revert Cloud Run Changes

Phase 0 removes all Cloud Run infrastructure — both GCP resources and repo artifacts. This is done first because these changes are pure deletions with no dependencies and reduce noise for subsequent phases.

### T01 — Delete GCP Cloud Run resources

- **Description**: Run the GCP cleanup commands from design §8.1 to delete the Cloud Run service, Artifact Registry images, Secret Manager secrets, and budget alert. This is a manual operations task (not code).
- **Commands to run**:

  ```
  gcloud run services delete ghagga --region us-central1 --quiet
  gcloud artifacts repositories delete ghagga-server --location us-central1 --quiet
  gcloud secrets delete GITHUB_APP_ID --quiet  (and remaining 6 secrets)
  gcloud billing budgets delete <BUDGET_ID> --billing-account=<ID>
  ```
- **Files affected**: None (infrastructure only)
- **Dependencies**: None
- **Effort**: S
- **Acceptance criteria**:
  - [ ] `gcloud run services list` shows no `ghagga` service
  - [ ] `gcloud artifacts repositories list` shows no `ghagga-server` repo
  - [ ] `gcloud secrets list` shows none of the 7 GHAGGA secrets
  - [ ] Budget alert is deleted

### T02 — Remove GCP files from repository

- **Description**: Delete the 4 Cloud Run–related files: `cloudbuild.yaml`, `scripts/deploy-cloudrun.sh`, `CLOUD-RUN-MIGRATION.md`, and `Dockerfile` (root). Verify no remaining references to Cloud Run in the codebase.
- **Files affected**:
  - `cloudbuild.yaml` → **DELETE**
  - `scripts/deploy-cloudrun.sh` → **DELETE**
  - `CLOUD-RUN-MIGRATION.md` → **DELETE**
  - `Dockerfile` (root, `/home/javier/ghagga/Dockerfile`) → **DELETE**
- **Dependencies**: None (can be done in parallel with T01)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] All 4 files are deleted from the repository
  - [ ] `git grep -i "cloud.run"` returns no results (or only historical references in openspec/)
  - [ ] `git grep "cloudbuild"` returns no results
  - [ ] `apps/action/Dockerfile` is untouched

### T03 — Revert Dockerfile: remove static analysis tool installations

- **Description**: Strip the production `apps/server/Dockerfile` Stage 2 of all static analysis tool installations. Remove: `python3`, `python3-pip`, `python3-venv`, `default-jre-headless`, `curl`, `unzip` (keep `ca-certificates` and `git`), Semgrep venv creation, Trivy install, PMD install, and the `semgrep --version && trivy --version && pmd --version` verification. Also remove the Semgrep rules COPY lines (`packages/core/src/tools/semgrep-rules.yml` and `packages/core/dist/tools/semgrep-rules.yml`). Keep the builder stage, the pnpm/Node setup, and the application COPY lines.
- **Files affected**:
  - `apps/server/Dockerfile` — **MODIFY** (remove lines 43–74 and lines 103–105)
- **Dependencies**: T02 (root Dockerfile must be removed first to avoid confusion)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] Dockerfile Stage 2 (`runner`) has no `python3`, `java`, `semgrep`, `trivy`, `pmd` references
  - [ ] `docker build -f apps/server/Dockerfile .` succeeds from monorepo root
  - [ ] Resulting image is < 300MB (verify with `docker images`)
  - [ ] Builder stage and application COPY lines are unchanged

### T04 — Revert server code changes made for Cloud Run

- **Description**: Remove Cloud Run–specific adaptations from the server codebase:
  1. **`apps/server/src/index.ts`**: Remove the `K_SERVICE` check on line 146 (`&& !process.env.K_SERVICE`). The keepalive should run on Render regardless. Also remove or simplify the `/health/tools` endpoint (lines 81–112) — with tools no longer on the server, this endpoint returns misleading info. Replace it with a simple message saying "Tools run in GitHub Actions runner" or remove it entirely.
  2. **`packages/core/src/tools/semgrep.ts`**: Remove the `resolveSemgrepBinary()` function that uses absolute path `/opt/semgrep-venv/bin/semgrep` (line 25–27). Revert to using just `'semgrep'` (PATH lookup) or keep `SEMGREP_PATH` env var for local dev. The function was added for Cloud Run.
  3. **`packages/core/src/tools/trivy.ts`**: Remove the `resolveTrivyBinary()` function that uses `/usr/local/bin/trivy` (line 13–15). Revert to `'trivy'` (PATH lookup).
  4. **`packages/core/src/tools/cpd.ts`**: The `findCpdBinary()` already tries multiple paths including `/opt/pmd/bin/pmd` (lines 80). This is fine for local/Action/CLI use — no revert needed. Leave as-is.
- **Files affected**:
  - `apps/server/src/index.ts` — **MODIFY** (remove `K_SERVICE` check, simplify `/health/tools`)
  - `packages/core/src/tools/semgrep.ts` — **MODIFY** (simplify binary resolution)
  - `packages/core/src/tools/trivy.ts` — **MODIFY** (simplify binary resolution)
- **Dependencies**: T03 (Dockerfile changes should land first since the absolute paths only made sense with the tool installations)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] No references to `K_SERVICE` in the codebase
  - [ ] `/health/tools` either removed or returns a message about runner architecture
  - [ ] `semgrep.ts` resolves binary via `SEMGREP_PATH` env var or `'semgrep'` (no hardcoded `/opt/` path as default)
  - [ ] `trivy.ts` resolves binary via `TRIVY_PATH` env var or `'trivy'` (no hardcoded `/usr/local/bin/` path as default)
  - [ ] CLI and Action modes still work (tools resolve from PATH)

---

## Phase 1: Foundation (types, pipeline, core infrastructure)

Phase 1 adds the foundational types and pipeline changes that all other phases depend on. These changes are backward-compatible — existing behavior is unchanged until the dispatch logic is wired up in Phase 2.

### T05 — Add `precomputedStaticAnalysis` to `ReviewInput` type

- **Description**: Add an optional `precomputedStaticAnalysis?: StaticAnalysisResult` field to the `ReviewInput` interface in `packages/core/src/types.ts`. Place it after the `onProgress` field (line 101) with a JSDoc comment explaining it's used in SaaS mode where tools run in a GitHub Actions runner.
- **Files affected**:
  - `packages/core/src/types.ts` — **MODIFY** (add 1 field to `ReviewInput`, ~8 lines with JSDoc)
- **Dependencies**: None
- **Effort**: S
- **Acceptance criteria**:
  - [ ] `ReviewInput.precomputedStaticAnalysis` is optional and typed as `StaticAnalysisResult`
  - [ ] TypeScript compiles without errors across all packages (`pnpm build`)
  - [ ] JSDoc comment explains purpose and when it's used vs. undefined

### T06 — Add precomputed static analysis branch to `reviewPipeline()`

- **Description**: Modify `packages/core/src/pipeline.ts` Step 5 (lines 128–132) to check `input.precomputedStaticAnalysis` before calling `runStaticAnalysisSafe()`. When provided, use the precomputed results directly via `Promise.resolve()` instead of running local tools. This is the one-line change described in design §4.4.
- **Files affected**:
  - `packages/core/src/pipeline.ts` — **MODIFY** (change line 130 to conditional)
- **Dependencies**: T05 (the type must exist first)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] When `input.precomputedStaticAnalysis` is set, `runStaticAnalysis` is NOT called
  - [ ] When `input.precomputedStaticAnalysis` is undefined, existing local tool execution is unchanged
  - [ ] All existing tests pass (`pnpm test` in `packages/core/`)
  - [ ] Memory search still runs in parallel regardless of precomputed results

### T07 — Create runner workflow YAML template

- **Description**: Create `templates/runner-workflow.yml` containing the canonical GitHub Actions workflow from design §3.3. This file is the source of truth — the server embeds its content and computes its SHA-256 hash. The workflow handles: masking, cloning, caching, tool installation, tool execution (Semgrep/Trivy/CPD), result assembly, callback POST, log deletion, and cleanup.
- **Files affected**:
  - `templates/runner-workflow.yml` — **CREATE** (new file, ~280 lines of YAML)
- **Dependencies**: None (standalone template)
- **Effort**: M
- **Acceptance criteria**:
  - [ ] File exists at `templates/runner-workflow.yml`
  - [ ] Contains all steps from design §3.3 (mask, clone, cache, install, run, POST, delete logs, cleanup)
  - [ ] `::add-mask::` patterns cover repo name, token, clone path
  - [ ] All tool stdout/stderr redirected to `/dev/null`
  - [ ] Error handling for clone failure sends error callback
  - [ ] `jq` transforms for Semgrep and Trivy match the `StaticAnalysisResult` type
  - [ ] Python CPD XML parser matches the `ReviewFinding` type
  - [ ] Log deletion step runs `if: always()`

### T08 — Create `runner.ts` module (GitHub API functions for runner management)

- **Description**: Create `apps/server/src/github/runner.ts` with the full runner repo lifecycle as designed in §4.1. Public functions: `ensureRunnerRepo()`, `dispatchAnalysis()`, `deleteRunnerRepo()`. Internal helpers: `repoExists()`, `createRepo()`, `commitWorkflowFile()`, `verifyWorkflowIntegrity()`, `setRepoSecret()`. The module reads the canonical workflow YAML from `templates/runner-workflow.yml` (import as string) and computes its SHA-256 hash at module load time. Follow the existing fetch-based pattern from `github/client.ts` (native `fetch`, no Octokit).
- **Dependencies**:
  - Add `libsodium-wrappers` dependency to `apps/server/package.json` for sealed box encryption of GitHub secrets.
  - Import `getInstallationToken` from `./client.js`.
  - Import the workflow template content (use `node:fs/readFileSync` on the bundled template, or embed as a string constant).
- **Files affected**:
  - `apps/server/src/github/runner.ts` — **CREATE** (new file, ~300 lines)
  - `apps/server/package.json` — **MODIFY** (add `libsodium-wrappers` and `@types/libsodium-wrappers`)
- **Dependencies**: T07 (workflow template must exist for hash computation)
- **Effort**: L
- **Acceptance criteria**:
  - [ ] `ensureRunnerRepo(owner, installationId, appId, privateKey)` creates repo + commits workflow if missing, re-commits if tampered, no-ops if valid
  - [ ] `dispatchAnalysis(...)` returns `{ dispatched: true, callbackId, callbackSecret }` on success, `{ dispatched: false, reason }` on failure
  - [ ] `deleteRunnerRepo(...)` deletes the runner repo (best-effort, no throw on failure)
  - [ ] `setRepoSecret()` encrypts with libsodium sealed box, PUTs to GitHub Secrets API
  - [ ] `verifyWorkflowIntegrity()` compares SHA-256 of remote file content with `CANONICAL_WORKFLOW_HASH`
  - [ ] HMAC signature uses `GITHUB_WEBHOOK_SECRET` as key and `callbackId` as message
  - [ ] All GitHub API calls include proper headers (`Authorization`, `Accept`, `X-GitHub-Api-Version`)
  - [ ] TypeScript compiles without errors

---

## Phase 2: Server Integration (Inngest, routes, webhook)

Phase 2 wires the runner infrastructure into the server's request flow. This is the core integration work that changes the review lifecycle from synchronous tool execution to asynchronous dispatch-and-wait.

### T09 — Add `ghagga/runner.completed` event schema to Inngest client

- **Description**: Modify `apps/server/src/inngest/client.ts` to:
  1. Import `StaticAnalysisResult` type from `ghagga-core`.
  2. Add the `ghagga/runner.completed` event to the `Events` type (lines 70–74) with `data: { callbackId: string; staticAnalysis: StaticAnalysisResult }`.
  3. Add `headSha?: string` and `baseBranch?: string` to `ReviewRequestedData` (needed by the dispatch step).
- **Files affected**:
  - `apps/server/src/inngest/client.ts` — **MODIFY** (add event type, add 2 fields to `ReviewRequestedData`)
- **Dependencies**: T05 (StaticAnalysisResult type used in event schema)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] `Events` record includes `'ghagga/runner.completed'` with correct `data` shape
  - [ ] `ReviewRequestedData` has `headSha?: string` and `baseBranch?: string`
  - [ ] TypeScript compiles without errors

### T10 — Create runner-callback route

- **Description**: Create `apps/server/src/routes/runner-callback.ts` with `POST /api/runner-callback` as designed in §4.2. The route: (1) extracts `X-Ghagga-Signature` header, (2) parses body as `CallbackBody`, (3) verifies HMAC-SHA256 using `GITHUB_WEBHOOK_SECRET` as key and `body.callbackId` as message, (4) emits `ghagga/runner.completed` Inngest event, (5) returns 200. Reject with 401 if signature missing/invalid, 400 if body malformed.
- **Files affected**:
  - `apps/server/src/routes/runner-callback.ts` — **CREATE** (new file, ~80 lines)
- **Dependencies**: T09 (Inngest event schema must be defined to emit the event)
- **Effort**: M
- **Acceptance criteria**:
  - [ ] Valid callback with correct HMAC returns `200 { status: "accepted" }`
  - [ ] Missing `X-Ghagga-Signature` header returns 401
  - [ ] Invalid HMAC returns 401 with warning logged
  - [ ] Malformed JSON body returns 400
  - [ ] Missing `callbackId` or `staticAnalysis` returns 400
  - [ ] Successfully emits `ghagga/runner.completed` Inngest event with `callbackId` and `staticAnalysis`
  - [ ] Uses `timingSafeEqual` for constant-time HMAC comparison

### T11 — Mount runner-callback route in server

- **Description**: Import and mount the runner callback route in `apps/server/src/index.ts`. The callback route must be mounted BEFORE the auth middleware (`app.use('/api/*', authMiddleware(db))`) because it uses HMAC authentication, not user sessions. Mount it after the webhook and OAuth routes, before the Inngest serve endpoint.
- **Files affected**:
  - `apps/server/src/index.ts` — **MODIFY** (add import + route mount, ~3 lines)
- **Dependencies**: T10 (the route module must exist), T04 (index.ts cleanup should be done first to avoid merge conflicts)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] `POST /api/runner-callback` is reachable without authentication
  - [ ] Dashboard API routes (`/api/*`) still require auth
  - [ ] Inngest endpoint still works
  - [ ] Server starts without errors

### T12 — Modify Inngest review function: add dispatch and wait-for-runner steps

- **Description**: Refactor `apps/server/src/inngest/review.ts` from 5 steps to 7 steps as designed in §4.3. Insert two new steps between `fetch-context` and `run-review`:
  1. **`dispatch-runner`** (new step): Import `dispatchAnalysis` from `../github/runner.js`. Generate the callback URL from `SERVER_URL` env var. Call `dispatchAnalysis()` with owner, installationId, PR context, and tool settings. Wrap in try/catch — on error, return `{ dispatched: false }`. Use `headSha` and `baseBranch` from `event.data` (added in T09).
  2. **`wait-for-runner`** (new step): If `dispatchResult.dispatched`, call `step.waitForEvent('wait-for-runner', { event: 'ghagga/runner.completed', match: 'data.callbackId', timeout: '10m' })`. If event received, extract `staticAnalysis`. If timeout (null), construct all-skipped `StaticAnalysisResult` with `error: "Runner timeout (10 min)"`.
  3. **`run-review`** (modified): Add `precomputedStaticAnalysis` to the `ReviewInput` object (pass the result from step 2).
- **Files affected**:
  - `apps/server/src/inngest/review.ts` — **MODIFY** (add ~50 lines for 2 new steps, modify input construction)
- **Dependencies**: T08 (runner.ts module), T09 (event schema + headSha/baseBranch), T06 (pipeline accepts precomputed results)
- **Effort**: L
- **Acceptance criteria**:
  - [x] Steps execute in order: `fetch-context` → `dispatch-runner` → `wait-for-runner` → `run-review` → `save-review` → `post-comment` → `react-to-trigger`
  - [x] If dispatch fails, wait-for-runner is skipped and run-review proceeds with undefined precomputedStaticAnalysis (local tools run)
  - [x] If dispatch succeeds but callback times out (10 min), run-review receives all-skipped `StaticAnalysisResult`
  - [x] If callback received within timeout, `staticAnalysis` is passed to pipeline
  - [x] Existing steps (save-review, post-comment, react-to-trigger) are unchanged
  - [x] TypeScript compiles without errors

### T13 — Modify webhook handler: add `headSha`/`baseBranch` to event data

- **Description**: In `apps/server/src/routes/webhook.ts`, add `headSha` and `baseBranch` to the Inngest event payload in both `handlePullRequest()` (line 239) and `handleIssueComment()` (line 346). The values come from `payload.pull_request.head.sha` and `payload.pull_request.base.ref` in `handlePullRequest()`. For `handleIssueComment()`, the PR info isn't in the comment payload — the headSha/baseBranch will be fetched in the Inngest function's `fetch-context` step instead, so just leave them as `undefined` here.
- **Files affected**:
  - `apps/server/src/routes/webhook.ts` — **MODIFY** (add 2 fields to inngest.send data in handlePullRequest)
- **Dependencies**: T09 (event schema must include headSha/baseBranch)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] `ghagga/review.requested` event from `handlePullRequest` includes `headSha` and `baseBranch`
  - [ ] `handleIssueComment` is unchanged (or has undefined headSha/baseBranch — fine for now)
  - [ ] TypeScript compiles without errors

### T14 — Modify webhook handler: create runner repo on installation

- **Description**: In `apps/server/src/routes/webhook.ts`, modify `handleInstallation()` to:
  1. On `action === 'created'`: After the existing `upsertInstallation` + `upsertRepository` logic (line 411), call `ensureRunnerRepo()` fire-and-forget (non-blocking, with `.catch()` for error logging). Import from `../github/runner.js`.
  2. On `action === 'deleted'`: After `deactivateInstallation()` (line 421), call `deleteRunnerRepo()` fire-and-forget.
- **Files affected**:
  - `apps/server/src/routes/webhook.ts` — **MODIFY** (add import, ~15 lines in handleInstallation)
- **Dependencies**: T08 (runner.ts module must exist)
- **Effort**: S
- **Acceptance criteria**:
  - [ ] On `installation.created`, `ensureRunnerRepo()` is called asynchronously
  - [ ] Runner repo creation failure does NOT fail the webhook response (fire-and-forget with `.catch()` logging)
  - [ ] On `installation.deleted`, `deleteRunnerRepo()` is called asynchronously
  - [ ] Webhook still returns 200 immediately
  - [ ] TypeScript compiles without errors

---

## Phase 3: Security Hardening

Phase 3 implements the security layers that protect private source code from leaking through the public runner repo. Most of these are already embedded in the workflow template (T07) and runner module (T08), but this phase verifies and hardens them.

### T15 — Implement workflow integrity verification (SHA-256 hash check)

- **Description**: Verify that `runner.ts` (T08) correctly implements the workflow integrity check before every dispatch. The `verifyWorkflowIntegrity()` function must: (1) GET the workflow file content from GitHub Contents API, (2) decode from base64, (3) compute SHA-256 hash, (4) compare with `CANONICAL_WORKFLOW_HASH` constant. If mismatch: log security warning, re-commit canonical version, re-verify, and if still mismatched → refuse dispatch. This task is a verification/hardening pass on T08's implementation.
- **Files affected**:
  - `apps/server/src/github/runner.ts` — **VERIFY/MODIFY** (ensure integrity check is robust)
- **Dependencies**: T08 (the initial implementation)
- **Effort**: S
- **Acceptance criteria**:
  - [x] Hash comparison uses exact string equality (not timing-safe needed here, it's not a secret)
  - [x] On mismatch: security warning logged with `owner` context
  - [x] On mismatch: canonical workflow re-committed via PUT Contents API
  - [x] After re-commit: hash re-verified before proceeding
  - [x] If re-commit fails → function returns `{ dispatched: false, reason: "Workflow integrity check failed" }`
  - [x] Content is decoded from base64 correctly (GitHub Contents API returns base64-encoded content)

### T16 — Verify log deletion in workflow template

- **Description**: Verify that the workflow template (T07) correctly implements log deletion in the "Delete workflow logs" step. The step must: (1) run with `if: always()`, (2) wait 5 seconds for logs to finalize, (3) call `DELETE /repos/{owner}/ghagga-runner/actions/runs/{run_id}/logs` using `GHAGGA_TOKEN`, (4) not fail the workflow if deletion fails. Also verify the cleanup step removes `target-repo/`.
- **Files affected**:
  - `templates/runner-workflow.yml` — **VERIFY/MODIFY** (ensure log deletion step is correct)
- **Dependencies**: T07 (the initial template)
- **Effort**: S
- **Acceptance criteria**:
  - [x] Log deletion step has `if: always()`
  - [x] Uses `secrets.GHAGGA_TOKEN` for authentication
  - [x] Non-fatal: failure prints `::warning::` but doesn't fail the job
  - [x] Cleanup step removes `target-repo/` with `rm -rf`
  - [x] Cleanup step also has `if: always()`

### T17 — Verify `::add-mask::` patterns in workflow template

- **Description**: Verify that the workflow template (T07) masks all sensitive values at the start of execution: (1) `REPO_FULL_NAME` (e.g., `alice/my-private-project`), (2) `GHAGGA_TOKEN` (though GitHub auto-masks secrets), (3) the repo name alone (extracted with `cut`), (4) the clone directory path. These should be in the first step, before any other operation.
- **Files affected**:
  - `templates/runner-workflow.yml` — **VERIFY** (mask step)
- **Dependencies**: T07
- **Effort**: S
- **Acceptance criteria**:
  - [x] `::add-mask::` for repo full name, repo name, token, and clone path
  - [x] Mask step runs before the clone step
  - [x] All subsequent log output containing these strings will be replaced with `***`

### T18 — Verify HMAC signature generation and verification

- **Description**: Verify end-to-end HMAC flow: (1) In `runner.ts` `dispatchAnalysis()`, the `callbackSignature` is computed as `"sha256=" + HMAC-SHA256(GITHUB_WEBHOOK_SECRET, callbackId)`. (2) The signature is included in the dispatch payload. (3) In `runner-callback.ts`, the received signature is verified by recomputing the same HMAC and using `timingSafeEqual`. Write a unit test that generates a signature and verifies it through the callback route logic.
- **Files affected**:
  - `apps/server/src/github/runner.ts` — **VERIFY** (HMAC generation)
  - `apps/server/src/routes/runner-callback.ts` — **VERIFY** (HMAC verification)
- **Dependencies**: T08 (runner.ts), T10 (callback route)
- **Effort**: S
- **Acceptance criteria**:
  - [x] Signature format is `"sha256=" + hex(HMAC-SHA256(webhookSecret, callbackId))`
  - [x] Both generator and verifier use the same key (`GITHUB_WEBHOOK_SECRET`)
  - [x] `timingSafeEqual` is used for comparison
  - [x] Invalid signature correctly rejected
  - [x] Different callbackId produces different signature

### T19 — Set log retention to 1 day on runner repo creation

- **Description**: When `ensureRunnerRepo()` creates a new runner repo, it must also set the Actions log retention to the minimum (1 day) using `PUT /repos/{owner}/ghagga-runner/actions/permissions` or the appropriate API. This is a safety net for when explicit log deletion fails. Add this call to the `createRepo()` helper in `runner.ts`.
- **Files affected**:
  - `apps/server/src/github/runner.ts` — **MODIFY** (add retention API call after repo creation)
- **Dependencies**: T08
- **Effort**: S
- **Acceptance criteria**:
  - [x] After repo creation, `PUT /repos/{owner}/ghagga-runner/actions/permissions/artifact-and-log-retention` is called to set retention days to 1
  - [x] If the retention API call fails, repo creation still succeeds (non-fatal)
  - [x] Existing repos (already created) are not affected (only new repos)

### Manual: Create `JNZader/ghagga-runner-template` GitHub Repository

> **This is a manual step — not automatable in code.**
- [ ] Create a new **public** repository `JNZader/ghagga-runner-template` on GitHub
- [ ] In repo Settings → check **"Template repository"**
- [ ] Copy `templates/ghagga-analysis.yml` → `.github/workflows/ghagga-analysis.yml` in the template repo
- [ ] Copy `templates/ghagga-runner-README.md` → `README.md` in the template repo
- [ ] Verify the template can be used to create new repos via "Use this template" button
- [ ] Add the `GHAGGA_TOKEN` secret documentation in the template repo's README (already included)

---

## Phase 4: Testing & Verification

Phase 4 validates the entire system end-to-end and cleans up any remaining debug artifacts.

### T20 — Unit test: pipeline precomputed static analysis branch

- **Description**: Write a unit test in `packages/core/` that verifies: (1) When `ReviewInput.precomputedStaticAnalysis` is set with mock results, `runStaticAnalysis` is NOT called and the precomputed results appear in the output. (2) When `precomputedStaticAnalysis` is undefined, `runStaticAnalysis` IS called as before. Mock the LLM calls to avoid actual API usage.
- **Files affected**:
  - `packages/core/src/__tests__/pipeline.test.ts` (or similar) — **CREATE/MODIFY**
- **Dependencies**: T06
- **Effort**: M
- **Acceptance criteria**:
  - [x] Test passes with precomputed results → `runStaticAnalysis` not called
  - [x] Test passes without precomputed results → `runStaticAnalysis` called
  - [x] Precomputed findings appear in `result.findings`
  - [x] `metadata.toolsRun` and `metadata.toolsSkipped` are correct for precomputed results

### T21 — Unit test: runner-callback HMAC verification

- **Description**: Write unit tests for the callback route: (1) Valid HMAC → 200 + Inngest event emitted. (2) Missing header → 401. (3) Invalid HMAC → 401 + log warning. (4) Malformed JSON → 400. (5) Missing `callbackId` → 400. Mock `inngest.send()` and `process.env.GITHUB_WEBHOOK_SECRET`.
- **Files affected**:
  - `apps/server/src/routes/__tests__/runner-callback.test.ts` — **CREATE**
- **Dependencies**: T10
- **Effort**: M
- **Acceptance criteria**:
  - [x] All 5 scenarios tested and passing
  - [x] `inngest.send()` is mocked and verified to be called with correct event shape
  - [x] `timingSafeEqual` behavior is validated (invalid signature rejected)

### T22 — Unit test: runner.ts core functions

- **Description**: Write unit tests for `runner.ts` functions. Mock `fetch` globally. Test: (1) `ensureRunnerRepo` — repo doesn't exist → creates + commits workflow. (2) `ensureRunnerRepo` — repo exists, workflow valid → no-op. (3) `ensureRunnerRepo` — repo exists, workflow tampered → re-commits. (4) `dispatchAnalysis` — happy path returns `{ dispatched: true, callbackId, callbackSecret }`. (5) `dispatchAnalysis` — workflow tampered and re-commit fails → returns `{ dispatched: false }`. (6) `setRepoSecret` — encrypts with libsodium and PUTs correctly.
- **Files affected**:
  - `apps/server/src/github/__tests__/runner.test.ts` — **CREATE**
- **Dependencies**: T08
- **Effort**: L
- **Acceptance criteria**:
  - [x] All 6 scenarios tested and passing
  - [x] `fetch` is mocked for all GitHub API calls
  - [x] HMAC signature generation verified (signature matches expected format)
  - [x] SHA-256 workflow hash comparison verified
  - [x] libsodium encryption tested (or mocked if WASM problematic in tests)

### T23 — Integration test: dispatch → callback → resume flow

- **Description**: Write an integration test that validates the full Inngest dispatch-wait-resume cycle. Use Inngest's test utilities (or mock the step functions) to: (1) Simulate `dispatch-runner` returning `{ dispatched: true, callbackId: "test-123" }`. (2) Simulate `ghagga/runner.completed` event with matching `callbackId`. (3) Verify `run-review` receives the `precomputedStaticAnalysis`. (4) Also test the timeout path: no event received → `waitForEvent` returns null → all tools skipped.
- **Files affected**:
  - `apps/server/src/inngest/__tests__/review.test.ts` — **CREATE/MODIFY**
- **Dependencies**: T12
- **Effort**: L
- **Acceptance criteria**:
  - [x] Happy path: callback received → pipeline gets precomputed results
    - [x] Timeout path: no callback → pipeline gets all-skipped results with "Runner timeout" error
    - [x] Skip path: dispatch failed → pipeline runs with undefined precomputedStaticAnalysis (local tools)
    - [x] Tests run in CI without hitting real GitHub or Inngest APIs

### T24 — End-to-end test: install app → runner repo created → PR → review

- **Description**: Manual end-to-end validation on a test GitHub account:
  1. Install the GHAGGA App on a test account.
  2. Verify `{test-user}/ghagga-runner` repo was created with correct workflow file.
  3. Open a PR on a test repository.
  4. Verify the runner dispatch fires and Actions executes on `ghagga-runner`.
  5. Verify the callback is received and the review comment appears on the PR.
  6. Verify the review comment includes static analysis findings.
  7. Inspect the runner repo's Actions tab — verify logs are deleted (or empty).
  8. Check publicly visible workflow logs for any source code leaks.
- **Files affected**: None (manual testing)
- **Dependencies**: All previous tasks (T01–T23)
- **Effort**: L
- **Acceptance criteria**:
  - [ ] Runner repo auto-created on installation
  - [ ] Workflow file matches canonical template (SHA-256 check passes)
  - [ ] PR triggers review → dispatch → Actions run → callback → comment posted
  - [ ] Static analysis findings (Semgrep, Trivy, CPD) appear in the review comment
  - [ ] No source code, file paths, or private repo content visible in public runner logs
  - [ ] Workflow logs are deleted after run

### T25 — End-to-end test: fallback (runner timeout → LLM-only review)

- **Description**: Manual test of the fallback path:
  1. Temporarily break the runner workflow (e.g., make the callback URL point to a non-existent server).
  2. Trigger a review.
  3. Wait 10 minutes for the Inngest timeout.
  4. Verify an LLM-only review is posted with "Static analysis was skipped (runner timeout)" note.
  5. Verify `metadata.toolsSkipped` includes all 3 tools.
- **Files affected**: None (manual testing)
- **Dependencies**: T24 (happy path should work first)
- **Effort**: M
- **Acceptance criteria**:
  - [ ] After 10 minutes, LLM-only review is posted
  - [ ] Review comment notes that static analysis was skipped
  - [ ] All 3 tools listed in `toolsSkipped`
  - [ ] `toolsRun` is empty
  - [ ] AI findings are still present (LLM ran)

### T26 — Clean up debug logging and deploy to Render

- **Description**: Final cleanup pass:
  1. Remove any excessive `console.log`/`console.warn` debug statements added during Cloud Run work or development.
  2. Ensure all logging uses the structured `pino` logger (`logger` from `lib/logger.js`) instead of raw `console.*` in new server code (runner.ts, runner-callback.ts).
  3. Verify `render.yaml` still works with the slimmed Dockerfile (or update if switching to Node runtime).
  4. Deploy to Render and verify the server starts, handles webhooks, and runner dispatches work in production.
- **Files affected**:
  - `apps/server/src/github/runner.ts` — **MODIFY** (use pino logger)
  - `apps/server/src/routes/runner-callback.ts` — **VERIFY** (already uses pino)
  - `apps/server/src/inngest/review.ts` — **MODIFY** (replace console.warn with logger)
  - `render.yaml` — **VERIFY/MODIFY** (ensure Docker build works)
- **Dependencies**: T24, T25 (testing must pass before production deploy)
- **Effort**: M
- **Acceptance criteria**:
  - [ ] No raw `console.log` in new server files (use structured pino logger)
  - [ ] Server deploys successfully to Render
  - [ ] Server boots within 30 seconds
  - [ ] Health endpoint responds
  - [ ] First review dispatch works in production

---

## Implementation Order & Dependencies

```
T01 ─────────────────────────────────────────────┐
T02 ─────────────────────────────────────────────┤ Phase 0
T03 ← T02 ───────────────────────────────────────┤ (can run mostly in parallel)
T04 ← T03 ───────────────────────────────────────┘

T05 ─────────────────────────────────────────────┐
T06 ← T05 ───────────────────────────────────────┤ Phase 1
T07 ─────────────────────────────────────────────┤ (T05/T07 in parallel)
T08 ← T07 ───────────────────────────────────────┘

T09 ← T05 ───────────────────────────────────────┐
T10 ← T09 ───────────────────────────────────────┤
T11 ← T10, T04 ──────────────────────────────────┤ Phase 2
T12 ← T08, T09, T06 ─────────────────────────────┤
T13 ← T09 ───────────────────────────────────────┤
T14 ← T08 ───────────────────────────────────────┘

T15 ← T08 ───────────────────────────────────────┐
T16 ← T07 ───────────────────────────────────────┤ Phase 3
T17 ← T07 ───────────────────────────────────────┤ (mostly verification)
T18 ← T08, T10 ──────────────────────────────────┤
T19 ← T08 ───────────────────────────────────────┘

T20 ← T06 ───────────────────────────────────────┐
T21 ← T10 ───────────────────────────────────────┤
T22 ← T08 ───────────────────────────────────────┤ Phase 4
T23 ← T12 ───────────────────────────────────────┤
T24 ← all ───────────────────────────────────────┤
T25 ← T24 ───────────────────────────────────────┤
T26 ← T24, T25 ──────────────────────────────────┘
```

### Effort Summary

| Effort       | Count  | Tasks                                                                     |
| ------------ | ------ | ------------------------------------------------------------------------- |
| **S** (< 1h) | 15     | T01, T02, T03, T04, T05, T06, T09, T11, T13, T14, T15, T16, T17, T18, T19 |
| **M** (1-3h) | 7      | T07, T10, T20, T21, T25, T26                                              |
| **L** (3-6h) | 4      | T08, T12, T22, T23, T24                                                   |
| **Total**    | **26** |                                                                           |

### Critical Path

The longest dependency chain is:

```
T05 → T06 → T12 → T23 → T24 → T25 → T26
```

This is 7 tasks on the critical path. T08 (runner.ts) is the single largest task and blocks T12 (Inngest refactor) and all of Phase 3.

### Recommended Parallel Execution

- **Wave 1**: T01, T02, T05, T07 (all independent)
- **Wave 2**: T03, T06, T08, T09 (after their deps)
- **Wave 3**: T04, T10, T13, T14, T15–T19 (integration + hardening)
- **Wave 4**: T11, T12 (core wiring)
- **Wave 5**: T20–T23 (tests, can run in parallel)
- **Wave 6**: T24, T25, T26 (E2E + deploy)
