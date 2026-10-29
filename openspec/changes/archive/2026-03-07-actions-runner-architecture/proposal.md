# Proposal: Migrate Static Analysis to GitHub Actions Runner Architecture

## Intent

GHAGGA's static analysis tools (Semgrep ~400MB Python, PMD/CPD ~300MB JVM, Trivy ~100MB Go) cannot run within Render's 512MB free tier. The current `apps/server/Dockerfile` installs all three tools in the runtime image, but they OOM on Render. A Cloud Run migration was attempted (see `CLOUD-RUN-MIGRATION.md`, `cloudbuild.yaml`) but incurs build and runtime costs that are unacceptable for a free-tier SaaS.

The solution is to offload static analysis execution to GitHub Actions runners via a per-user `{user}/ghagga-runner` public repository, providing 7GB RAM and unlimited free Actions minutes on public repos. The server stays on Render handling webhooks, DB, LLM orchestration, and comment posting — the only workload it's sized for.

This also cleans up the abandoned Cloud Run infrastructure (GCP service, Artifact Registry, Secret Manager, and repo files).

## Scope

### In Scope

- **Runner repo lifecycle**: Auto-create `{user}/ghagga-runner` on GitHub App installation with workflow template
- **Dispatch mechanism**: Server sends `repository_dispatch` to runner repo with review context
- **Callback endpoint**: New `POST /api/runner-callback` receives structured `StaticAnalysisResult` JSON from Actions
- **Inngest split**: Refactor `reviewFunction` to dispatch → `waitForEvent` → resume with static results
- **Pipeline adaptation**: `reviewPipeline()` accepts pre-computed `StaticAnalysisResult` (skip local tool execution in SaaS mode)
- **Security hardening**: All tool output → `/dev/null`, `::add-mask::`, log deletion, retention=1day, workflow hash verification
- **Runner workflow template**: YAML file committed to runner repos that clones, scans, and POSTs results
- **Dockerfile cleanup**: Remove Semgrep/Trivy/PMD installation from `apps/server/Dockerfile`
- **Google Cloud cleanup**: Delete Cloud Run service, Artifact Registry, Secret Manager; remove `cloudbuild.yaml`, `scripts/deploy-cloudrun.sh`, `CLOUD-RUN-MIGRATION.md`
- **Graceful degradation**: If runner fails/times out (10 min), deliver LLM-only review without static analysis

### Out of Scope

- **`apps/action/` changes**: The existing self-hosted GitHub Action stays unchanged (it runs tools locally in the user's own workflow)
- **CLI mode**: CLI already runs tools locally, no changes needed
- **1-click deploy mode**: Uses its own Docker image with tools, unaffected
- **Private runner repos**: Keeping runner repos public for free Actions minutes (private repos consume paid minutes)
- **Custom Semgrep rules per user**: Deferred to a future change
- **Dashboard UI for runner status**: Deferred

## Approach

### Architecture: Option B — Actions = Static Analysis Only

The cleanest separation of concerns. The server keeps ALL secrets, DB access, LLM calls, and orchestration. The runner repo is a dumb executor: clone → scan → POST results → exit.

### Flow (8 steps)

```
PR opened → Webhook → Render Server
                        │
                        ├── 1. Verify webhook signature
                        ├── 2. Fetch settings from DB
                        ├── 3. Generate installation token
                        ├── 4. Set token as repo secret on {user}/ghagga-runner
                        ├── 5. Send repository_dispatch to {user}/ghagga-runner
                        │       payload: { callbackId, repoFullName, prNumber,
                        │                  headSha, baseBranch, toolSettings,
                        │                  callbackUrl, callbackSignature }
                        ├── 6. Inngest waitForEvent("ghagga/runner.completed",
                        │       match: callbackId, timeout: 10min)
                        │
                        │   ┌─── GitHub Actions (runner repo) ───┐
                        │   │ a. Clone target repo (secret token) │
                        │   │ b. Install/cache Semgrep,Trivy,PMD  │
                        │   │ c. Run tools (output → /dev/null)   │
                        │   │ d. POST JSON to callbackUrl          │
                        │   │ e. Delete workflow logs              │
                        │   └─────────────────────────────────────┘
                        │
                        ├── 7. Receive callback, verify HMAC → emit Inngest event
                        ├── 8. Resume: run LLM review with static results injected
                        └── 9. Post final review comment to PR
```

### Key Design Decisions

1. **Installation token via repo secret** (not dispatch payload) — prevents credential exposure in workflow logs or event payloads
2. **Inngest `waitForEvent`** correlates dispatch with callback using a unique `callbackId` (UUID)
3. **Callback HMAC**: Server generates a per-dispatch signing secret, sends the signature in the payload; callback route verifies it before accepting results
4. **Workflow file hash verification**: Before each dispatch, server reads the workflow file content via GitHub Contents API and verifies its SHA matches the expected template hash
5. **Fallback to LLM-only**: On timeout or callback error, the Inngest function continues with empty `StaticAnalysisResult` (all tools skipped)
6. **`StaticAnalysisResult` type reuse**: The exact same `StaticAnalysisResult` interface from `packages/core/src/types.ts` is serialized/deserialized between runner and server — no new types needed

### Security Layers (private code in public runner)

| Layer                | Mechanism                                                                     |
| -------------------- | ----------------------------------------------------------------------------- |
| 1. Silent execution  | All tool stdout/stderr → `/dev/null`; only structured JSON extracted          |
| 2. Error containment | Wrapper catches tool crashes, emits only generic "tool failed" messages       |
| 3. GitHub masking    | `::add-mask::` for repo names, file paths, and any content fragments          |
| 4. Log deletion      | Workflow run logs deleted via GitHub API after results are POSTed             |
| 5. Retention policy  | Repository log retention set to minimum (1 day) as safety net                 |
| 6. Integrity check   | Workflow file SHA verified before every dispatch — rejects tampered workflows |

## Affected Areas

| Area                                        | Impact            | Description                                                                                                                             |
| ------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/github/client.ts`          | Modified          | Add functions: `createRunnerRepo`, `setRepoSecret`, `dispatchRunner`, `verifyWorkflowIntegrity`, `deleteWorkflowLogs`, `getRepoContent` |
| `apps/server/src/github/runner.ts`          | **New**           | Runner repo management module: create repo, commit workflow, set secrets, dispatch, verify                                              |
| `apps/server/src/routes/runner-callback.ts` | **New**           | `POST /api/runner-callback` — HMAC verification, Inngest event emission                                                                 |
| `apps/server/src/routes/webhook.ts`         | Modified          | Add runner repo creation on `installation.created` event                                                                                |
| `apps/server/src/inngest/review.ts`         | Modified          | Split into: dispatch static analysis → `waitForEvent` → resume with results → LLM review                                                |
| `apps/server/src/inngest/client.ts`         | Modified          | Add `ghagga/runner.completed` event schema                                                                                              |
| `packages/core/src/pipeline.ts`             | Modified          | Accept optional pre-computed `StaticAnalysisResult`; skip local `runStaticAnalysis` when provided                                       |
| `packages/core/src/types.ts`                | Modified          | Add `precomputedStaticAnalysis?: StaticAnalysisResult` to `ReviewInput`                                                                 |
| `templates/runner-workflow.yml`             | **New**           | GitHub Actions workflow template for runner repos                                                                                       |
| `apps/server/Dockerfile`                    | Modified          | Remove Python, JVM, Semgrep, Trivy, PMD installation (~700MB saved)                                                                     |
| `apps/server/src/routes/api.ts`             | Modified          | Mount runner callback route                                                                                                             |
| `render.yaml`                               | Possibly modified | May switch from `docker` to `node` runtime if Dockerfile becomes trivial                                                                |
| `cloudbuild.yaml`                           | **Removed**       | No longer needed                                                                                                                        |
| `scripts/deploy-cloudrun.sh`                | **Removed**       | No longer needed                                                                                                                        |
| `CLOUD-RUN-MIGRATION.md`                    | **Removed**       | No longer needed                                                                                                                        |
| `Dockerfile` (root)                         | **Removed**       | Cloud Run Dockerfile, superseded                                                                                                        |
| `apps/action/`                              | **Unchanged**     | Self-hosted action continues running tools locally                                                                                      |
| `packages/core/src/tools/runner.ts`         | **Unchanged**     | Still used by CLI, Action, and 1-click deploy modes                                                                                     |

## Risks

| Risk                                                  | Likelihood | Impact   | Mitigation                                                                            |
| ----------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------- |
| **Private code leaks in public logs**                 | Low        | Critical | 4 security layers (silence, mask, delete, retention) + workflow integrity check       |
| **GitHub ToS violation** (compute abuse)              | Very Low   | High     | Same pattern used by CodeQL, Snyk, SonarCloud; runner does legitimate CI work         |
| **Latency increase** (+1-4 min Actions cold start)    | High       | Low      | Acceptable for async code review; tool caching reduces subsequent runs                |
| **Workflow tampering** (user modifies runner YAML)    | Medium     | High     | SHA verification before every dispatch; reject tampered workflows                     |
| **Installation token expiry** (1h lifetime)           | Low        | Medium   | Generate fresh token immediately before dispatch; runner clone happens within seconds |
| **Runner repo deletion by user**                      | Medium     | Low      | Check repo exists before dispatch; re-create if missing                               |
| **Inngest waitForEvent timeout** (Actions slow/stuck) | Medium     | Low      | 10 min timeout → fallback to LLM-only review (still useful)                           |
| **GitHub API rate limits** (many dispatches)          | Low        | Medium   | Installation tokens have 5000 req/h; typical usage is far below                       |
| **Callback replay attacks**                           | Low        | Medium   | HMAC with per-dispatch unique secret; callback ID used only once                      |

## Rollback Plan

This change is highly reversible because the static analysis tools remain in `packages/core/` and are still used by `apps/action/` and CLI:
1. **Revert Dockerfile**: Re-add Semgrep/Trivy/PMD installation to `apps/server/Dockerfile` (the old version is in git history)
2. **Revert pipeline**: Remove `precomputedStaticAnalysis` from `ReviewInput`; pipeline reverts to local execution
3. **Revert Inngest function**: Remove the `waitForEvent` split; go back to single-step `run-review`
4. **Keep runner repos**: They're inert without dispatches; can be deleted later
5. **Restore Cloud Run** (if needed): `cloudbuild.yaml` and deployment scripts are in git history

**Rollback time**: ~30 minutes (revert commits + deploy to Render)

**No data migration needed** — the `reviews` table schema is unchanged; `StaticAnalysisResult` is the same type regardless of where tools ran.

## Dependencies

- **GitHub App permissions**: The GHAGGA GitHub App needs these additional permissions:
  - `administration: write` — to create runner repos under user accounts (or use user OAuth token)
  - `actions: write` — to dispatch workflows and delete logs
  - `secrets: write` — to set repository secrets on runner repos
  - Note: Some of these may require user-level OAuth rather than installation tokens. Needs investigation during design phase.
- **Inngest `waitForEvent`**: Already available in current Inngest plan (used for event correlation)
- **GitHub Actions**: Free unlimited minutes for public repos (already confirmed)
- **No new npm dependencies**: All GitHub API calls use native `fetch` (existing pattern in `client.ts`)

## Success Criteria

- [ ] When GHAGGA App is installed, a public `{user}/ghagga-runner` repo is auto-created with the correct workflow file
- [ ] When "ghagga review" is triggered on a PR, static analysis runs in GitHub Actions runner (not on server)
- [ ] All 3 tools (Semgrep, Trivy, PMD/CPD) produce results that appear in the final PR review comment
- [ ] Private repo source code does NOT appear in runner repo's public workflow logs (verified by manual audit)
- [ ] If runner fails or times out (10 min), an LLM-only review is still delivered with tools marked as "skipped"
- [ ] Google Cloud Run service, Artifact Registry images, and Secret Manager secrets are deleted
- [ ] `cloudbuild.yaml`, `scripts/deploy-cloudrun.sh`, and `CLOUD-RUN-MIGRATION.md` are removed from repo
- [ ] Server `Dockerfile` no longer installs Python, JVM, Semgrep, Trivy, or PMD (image size < 300MB)
- [ ] Server runs comfortably within Render's 512MB free tier under normal load
- [ ] `apps/action/` (self-hosted Action) continues to work unchanged with local tool execution
- [ ] CLI mode continues to work unchanged with local tool execution
- [ ] All existing tests in `packages/core/` pass without modification (tools still work locally)

## Distribution Mode Impact

| Mode                     | Impact       | Notes                                          |
| ------------------------ | ------------ | ---------------------------------------------- |
| **SaaS** (webhook)       | Major change | Static analysis moves to runner repos          |
| **Action** (self-hosted) | No change    | Continues running tools in user's own workflow |
| **CLI**                  | No change    | Continues running tools locally                |
| **1-click deploy**       | No change    | Uses own Docker image with tools installed     |
