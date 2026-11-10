# Exploration: Nightly Health Digest (Scheduled Repo Health Reviews)

## Exploration Scope

Covers the scheduled-digest slice only: one nightly job type per repo that aggregates accumulated health signals, ranks riskiest files, and posts/updates ONE digest issue. Extends the existing core health module plus server scheduling/publication. Excludes: general bot platform, multiple job types, PR-triggered digests, dashboard-first publishing. All anchors cite `origin/main`.

## Current State

- **Health module:** `packages/core/src/health/index.ts:1-19` exports three pure functions. `computeHealthScore` (`score.ts:42`) derives a 0-100 score from a `ReviewFinding[]` via severity weights (`score.ts:8`); `generateRecommendations` (`recommendations.ts:63`) maps finding source→category (`:16-31`) to ranked templated advice; `computeTrend` (`trends.ts:94`) compares current score vs last history entry.
- **Health persistence is CLI-local:** `saveHistory`/`loadHistory` (`trends.ts:48/:31`) write a single `health-history.json` under the CLI configDir, max 10 entries/project (`trends.ts:24-25`); entries carry `{timestamp, score, findingCounts, toolsRun, projectPath}` (`trends.ts:9-15`). The server/dashboard/DB never touch health; the only consumer is `apps/cli/src/commands/health.ts:91-97`. Tests: `packages/core/src/health/__tests__/{score,trends,recommendations}.test.ts`.
- **Scheduling:** three BullMQ fire-per-event queues — `review` (`apps/server/src/queues/review.ts:330`, attempts 3; worker `:1102` concurrency 3), `issue-analysis` (`issue-analysis.ts:162`, worker `:727`), `explanation` (`explanation.ts:189-227`, concurrency 1, in-process in `apps/server/src/index.ts:59-62`). bullmq `^6.7.0` (`apps/server/package.json:22`) supports repeatable/cron jobs natively but none exist. The only cron-like precedents are `setInterval` loops: the issue-draft reaper (`issue-draft-reaper.ts:296-322`, wired `workers/issue-analysis.ts:40-88`, env-gated, 5-min default) and the Render keepalive self-ping (`index.ts:304-317`). `workers/issue-analysis.ts:40-43` explicitly documents the single-box decision "not a separate BullMQ repeatable job".
- **Issue creation does not exist.** Forge write surface: `upsertSummaryComment` (`github-forge-adapter.ts:466`), `publishInline` (`ports/forge-adapter.ts:227-230`), `createExplanationComment`/`updateExplanationComment` (`:298-299`). GitHub client (`apps/server/src/github/client.ts`) has `postComment:504`, `updateComment:909` — no `POST /issues`. The triage flow only COMMENTs on existing issues: worker persists a DRAFT (`issue_drafts`, lifecycle DRAFT→APPROVED→POSTED, one-open-draft partial unique, `schema.ts:193-214` region); a human approves via `routes/api/issue-drafts.ts:323-331` → `postIssueComment` (`forge-adapter-factory.ts:148-155`), with marker idempotency + CAS states + reaper recovery.
- **App permissions:** the GitHub App manifest already grants **Issues: Read and write** (`docs/self-hosted.md:52-64`, for triage) — no permission change needed on GitHub. GitLab port exposes MR notes only (`gitlab-client-port.ts:17-20`); no issues API. `action.yml` is the separate GitHub-Action path (`permissions: pull-requests: write`, `docs/github-action.md:43`).
- **Risk-ranking data:** `reviews` table (`schema.ts:155-185` main) holds `findings` jsonb (`ReviewFinding[]` with `file`/`severity`/`source`, core `types.ts:488`), `metadata` jsonb (model, blast-radius counts folded in from `prepare-graph.ts:45` via `review.ts:885-904`/`:967`), `tokensUsed`, indexed `(repositoryId, createdAt)`. No per-file risk table. `memoryObservations` (`schema.ts:273`) accumulates review observations. `getReviewsByDay` (`packages/db/src/queries.ts:772`, server spec `:362`) is the 30-day aggregation precedent.
- **Settings surface:** `RepoSettings` jsonb on `repositories`/`installation_settings` (`schema.ts:33-53`, `:97/:113`) with the optional-boolean-off precedent `explanationsEnabled` (`:38`) and `enableBlastRadius` (`:52`); runtime gate `explanation.ts:434`; API update via coalescing boolean `routes/api/installations.ts:362-365` and `PUT /api/settings` (`routes/api/settings.ts:159`).

## Affected Areas

- `packages/core/src/health/*` — headless ingestion (DB-sourced findings instead of live tool runs), multi-review aggregation, per-file risk ranking, digest formatting inputs; new tests.
- `apps/server/src/queues/` — new `digest` queue + repeatable registration (or a reaper-style sweeper); worker entrypoint wiring.
- `packages/forge/src/ports/forge-adapter.ts` + github/gitlab adapters — `createDigestIssue`/`updateDigestIssue` (new write verbs, GitHub-only first).
- `apps/server/src/github/client.ts` — `POST /repos/{o}/{r}/issues` and issue-edit calls.
- `packages/db/src/schema.ts` + `queries.ts` — digest state (open digest issue number per repo), findings aggregation query.
- `apps/server/src/routes/api/settings.ts`, `installations.ts`, `repositories.ts` — per-repo digest toggle/schedule.
- Specs: `openspec/specs/server/spec.md`, `core-engine/spec.md`, `settings/spec.md`, `review-formatting/spec.md`, `distribution/spec.md`.

## Approaches

| Approach | Pros | Cons | Effort |
| --- | --- | --- | --- |
| **A. Reaper-style `setInterval` sweep in a worker** (matches `issue-draft-reaper.ts:296`) | Zero new infra; single-box proven; trivially env-gated | No per-repo cron fidelity, no durable missed-run recovery, fan-out serialized in one loop, drifts on restart | Low |
| **B. BullMQ repeatable per-repo jobs + dedicated digest queue** | Native cron (`bullmq ^6.7.0`), durable, per-repo schedule/timezone, backpressure via worker concurrency, aligns with queue conventions | First repeatable usage in codebase (contra the documented single-box decision); needs dedup of scheduler restarts (repeatable job id = repo key) | Medium |
| **C. External cron hitting a new authenticated API route** | Operationally explicit; reuses HTTP auth/rate limiting | New attack surface + secret; deployment-platform-specific; duplicates BullMQ durability | Medium |

## Recommendation

**Approach B.** Register one repeatable job per opted-in repo (jobId = `digest:{repositoryId}`, cron from repo settings, default e.g. `0 3 * * *` UTC) feeding a dedicated `digest` queue with modest concurrency; update registration when settings change; keep the reaper-style sweep only as a bootstrap/reconcile pass. Build the digest from **DB history** (aggregate `reviews.findings` jsonb since the last digest) — no LLM tokens, no full review pipeline — and reuse the health module's pure scoring after extending it to accept stored findings. Publish with issue-CREATE on first run and marker-based update-in-place after (reuse the issue-draft marker pattern), one open digest issue per repo, enforced by a DB unique/lookup. GitHub-only first (Issues write already granted); GitLab deferred.

## Constraints and Coupling

- Core must stay forge-agnostic: digest body building in core, publication verb at the adapter port.
- Health trends currently require a CLI-local JSON file; server digests need a DB-backed history source or the digest row itself becomes the history.
- Repeatable jobs contradict the in-code single-box scheduling decision (`workers/issue-analysis.ts:40-43`) — reconcile in the proposal, don't silently fork the pattern.
- Digest must not ride the review queue: review jobs assume PR context (headSha, diff, postback marker `ghagga-review`).
- Settings resolution (global vs per-repo, `useGlobalSettings`) must apply to the digest toggle/schedule (settings spec 1.7/1.8).
- Distribution spec governs SaaS/Action/CLI parity (`distribution/spec.md:11/:30/:65`) — a server-posted issue is SaaS-only; CLI already has `ghagga health`.

## Risks

- **Spam/duplicate digests:** scheduler re-registration or worker duplicates could double-post; mitigate with jobId-keyed repeatables + one-open-digest DB invariant + issue marker.
- **Permission drift:** App Issues write is documented but self-hosted apps created earlier may lack it; posting fails nightly — needs surfaced failure state, not silent skip.
- **Cost misread:** if implemented as a full review-pipeline run per night, token cost multiplies (reviews carry `tokensUsed`); DB-only aggregation keeps it ~free but weaker narratives.
- **Stale/empty digests:** repos without recent reviews produce noise; skip-and-record rule needed.
- **Clock/timezone:** per-repo TZ vs server UTC; DST edges in cron.
- **Fan-out:** thousands of opted-in repos firing at one cron minute; stagger via per-repo jitter or hash-spread.
- **Findings shape drift:** findings jsonb is `unknown[]` in schema — aggregation must tolerate legacy/malformed rows.
- **GitLab parity gap:** no issues API in the port; a cross-forge abstraction now would be speculative.

## Open Questions for Proposal

1. BullMQ repeatable (B) vs interval sweep (A) — is reversing the documented single-box scheduling decision acceptable now?
2. Digest content source: pure DB aggregation (no tokens) vs a light LLM summary per digest (bounded tokens) vs both (phased)?
3. Publication: always UPDATE one pinned open issue (marker) vs close-old/open-new weekly?
4. Schedule surface: fixed nightly UTC vs per-repo cron + timezone in RepoSettings vs install-level default?
5. Default state: opt-in (off) per repo — confirmed? Any install-level enable?
6. Should the digest also persist a DB health-history row (making `health-history.json` server-obsolete) or stay write-only to the forge?
7. Risk ranking formula: findings count × severity × recency × blast-radius metadata — which weights, and is per-file ranking from jsonb enough vs a new `file_risk` rollup table?
8. Does the digest failure path need dashboard visibility (a status the UI can read) or logs only?
