# Design: Nightly Health Digest

## Technical Approach

Approach B per proposal: BullMQ **job schedulers** (the modern repeatable API, not the
deprecated `add({repeat})`) feed a dedicated `digest` queue. One scheduler per opted-in
repo, `jobSchedulerId = digest:{repositoryId}`, pattern `0 3 * * *` UTC. The worker is
in-process in the API server (explanation precedent, `index.ts:59-62`), aggregation is
DB-only (`reviews.findings`/`metadata` jsonb, zero tokens), publication is
create-once/update-in-place against ONE digest issue per repo, and every run appends a
`digests` row that doubles as the server-side health history.

## Architecture Decisions

| # | Decision | Choice and rationale (evidence) | Rejected alternative |
| --- | --- | --- | --- |
| 1 | DB history | One `digests` row **per run** (append-only history), columns: `id`, `repositoryId` FK cascade, `runAt`, `status` (`POSTED` \| `SKIPPED` \| `FAILED`), `issueNumber?`, `issueOpen` boolean, `watermark` (reviews.createdAt cutoff consumed), `findingsCount`, `score?` (health-score snapshot → the table IS the server-side history), `error?`, timestamps. One-open invariant follows the issue_drafts precedent (`schema.ts:246-248`): `uniqueIndex('uq_digests_open_issue').on(repositoryId).where(issueOpen = true)` + `check` on status (`schema.ts:252-255`). Watermark advances only on POSTED; SKIPPED/FAILED rows carry the previous watermark unchanged. CLI-local `health-history.json` (`trends.ts:48`) stays separate — different consumer, filesystem-bound, distribution parity. | `digest_issues` pointer table (second table, two sources of truth); making CLI JSON server-fed (couples CLI to DB). |
| 2 | Risk formula | `fileRisk = Σ \|SEVERITY_WEIGHTS[severity]\| × recency(review.createdAt)` per finding on the file, window = last 30 days (matches `getReviewsByDay`, `queries.ts:773-774`). Weights reuse `SEVERITY_WEIGHTS` (`score.ts:8`: critical 20, high 10, medium 3, low 1, info 0) — single source, no new constants. Recency tiers: review age ≤7d → ×1.0, else ×0.5 — two tiers, deterministic, no continuous decay (testability). Rank desc; tiebreak 1: max blast-radius dependents from `reviews.metadata` (folded at `review.ts:885-904`); tiebreak 2: path asc. Top 10 files. | New weight table (drift from score.ts); continuous exponential decay (harder to golden-test); `file_risk` rollup table (out of scope per proposal). |
| 3 | Fan-out | Shared `0 3 * * *` UTC in v1 (accepted per proposal — opt-in volume is low). Documented follow-up: per-repo minute spread `hash(repositoryId) % 60` → `m 3 * * *` pattern, pure config change inside the same reconciler. Worker concurrency **2** (light DB+1-forge-call jobs; explanation runs 1, review 3). | Hash-spread day one (unneeded complexity before volume); concurrency 3 (no PR-length work here). |
| 4 | Missed runs | Accept BullMQ scheduler defaults, precisely: the next delayed job is pre-created, so downtime at fire time → that job runs **late, once** on worker return; gaps where the scheduler never created a job (producer down longer) → skipped to next night. Late runs are harmless: watermark idempotency consumes each window once; the one-open index + update-in-place make a late double-fire a no-op. No catch-up loop in v1. | Catch-up sweep on restart (re-implements the scheduler; watermark already dedupes). |
| 5 | Failure visibility | Digest row `status='FAILED'` + `error` text + worker `failed` log (message-only logging, `workers/issue-analysis.ts:95-102` precedent). Enum: `POSTED` \| `SKIPPED` \| `FAILED` (uppercase house style, `schema.ts:163`/`:193`). SKIPPED covers both no-new-findings and disabled-at-fire-time (reason in `error`). Dashboard deferred (proposal non-goal). | New status per skip reason (enum churn); dashboard column (deferred). |
| 6 | Title/marker | Title `GHAGGA Health Digest`; body first line marker `<!-- ghagga-digest -->` (mirrors `<!-- ghagga-review -->`, `client.ts:555`). Lookup = **DB `issueNumber` only** (the `issueOpen` row). Marker is forensic/human identification, not lookup — client.ts has no issue-search function, and body is fully overwritten each update so an edited-away marker self-heals. Issue closed/404 on update → create new + rotate `issueOpen` in one transaction. Rename-safe: lookup is by number; title edits are irrelevant. | Marker-search fallback over issues API (no client function exists; pagination cost). |
| 7 | Registration lifecycle | Reconciler runs (a) at server startup in `index.ts` after digest worker creation; (b) on settings change — after upsert in `PUT /api/settings` (`settings.ts:159`) and the installations merge route (`installations.ts:362-374`). Exact API (verified in bullmq 6.7.0 `queue.d.ts:206`/`:279`): `digestQueue.upsertJobScheduler('digest:{repositoryId}', { pattern: '0 3 * * *' }, { name: 'run-digest', data: { repositoryId } })` — keyed upsert, idempotent on restart (success criterion); removal `removeJobScheduler(id)`. Startup pass: `getJobSchedulers()` diff vs DB opted-in repos (`getEffectiveRepoSettings`, `queries.ts:193`) — add missing, remove stale. Job data carries ONLY `repositoryId`; settings re-resolved at processing time (credentials-never-in-payload rule, `queues/issue-analysis.ts:176-183`). | Old `add({repeat})` API (deprecated in v6); cron string in Redis payload. |
| 8 | Queue/worker shape | `apps/server/src/queues/digest.ts` mirroring `review.ts:330-342`: `new Queue('digest', { connection, defaultJobOptions: { attempts: 3, backoff exponential 1s, removeOnComplete: 100, removeOnFail: 50 } })` + `createDigestWorker(concurrency = 2)` + `closeDigestQueue`. Worker IN-PROCESS in `index.ts` (explanation precedent `:59-62`) — nightly-light, no new worker entrypoint (`workers/` stays PR-flow). **No env gate**: the server already requires Redis unconditionally — `review.ts:330` constructs the Queue at module import, so a Redis-less server cannot boot today; feature gating is the `digestsEnabled` setting, not env. `digestsEnabled?: boolean` on `RepoSettings` (`schema.ts:38` optional-boolean-off precedent) coalesced in both settings routes (`installations.ts:358-365` pattern). | Separate worker entrypoint (overkill); `DIGEST_ENABLED` env (duplicates the settings gate). |

## Data Flow

```
startup / settings change (index.ts, settings.ts:159, installations.ts:362)
 │ reconciler: getJobSchedulers() ⇄ DB opted-in repos
 │   └─ upsertJobScheduler('digest:{repoId}', {pattern '0 3 * * *'}, {data:{repositoryId}})
 │      └─ removeJobScheduler(id) on opt-out
 ▼
digest queue ── nightly job {repositoryId} ──► in-process worker (concurrency 2, index.ts)
 │ 1. re-resolve effective settings → disabled? record SKIPPED, done
 │ 2. aggregate reviews.findings/metadata since watermark (30d window for ranking)
 │ 3. core: score + aggregate + rankFiles (pure, S1) ── malformed jsonb rows skipped
 │ 4. no new findings since watermark? record SKIPPED (watermark unchanged), done
 │ 5. find open digest row (issueOpen=true) ── update issue body (marker) or create issue
 │ 6. insert run row: POSTED, issueNumber, issueOpen=true, watermark=runAt, score
 │      └─ partial unique index rejects a second open row (double-schedule blast wall)
 ▼
GitHub issue "GHAGGA Health Digest" / <!-- ghagga-digest -->   [S2: forge verbs]
digests table = run history + watermark + score trend          [D1]
```

## Interfaces / Contracts

- `aggregateHealth(rows: ReviewRow[]): DigestInputs` — pure, tolerates malformed findings rows (skip + count, never throw). `ReviewRow = { findings: unknown; metadata: unknown; createdAt: Date }`.
- `rankFileRisk(digestInputs, now): FileRisk[]` — pure, formula D2, deterministic.
- `formatDigestBody(inputs, trend, fileRisks): string` — marker header first line; core, forge-agnostic.
- Forge port: `createDigestIssue(repo, title, body): Promise<{number}>`, `updateDigestIssue(repo, number, body): Promise<void>` — on `ForgeAdapter` as GitHub-only verbs; GitLab adapter throws unsupported (port keeps the seam, `forge-adapter.ts:130` surface).
- DB: `insertDigestRun`, `getOpenDigest(repositoryId)`, `rotateOpenDigest(tx, ...)` (flip old row `issueOpen=false` + insert new, one transaction).
- `enqueue/digest.ts`: `reconcileDigestSchedulers(db, queue)` + `scheduleDigestForRepo`/`unscheduleDigestForRepo`.

## Degradation

| Condition | Behavior | Visible as |
| --- | --- | --- |
| Repo opted out at fire time | No forge call, row SKIPPED | digest row + log |
| No findings since watermark | No forge call, row SKIPPED | digest row |
| Issues-write permission missing | Attempts exhaust, row FAILED | row `error` + worker failed log (never silent) |
| Malformed findings jsonb | Rows skipped, counted | `findingsCount` excludes them |
| Issue closed/404 on update | Create new issue, rotate `issueOpen` | New issue; invariant intact |
| Late run after downtime | Aggregates same window once | One POSTED row, no duplicate |

## File Changes

| Files | Action |
| --- | --- |
| `packages/core/src/health/digest.ts` (+tests) | S1: aggregate/rank pure functions, malformed tolerance |
| `packages/core/src/format-digest.ts` (+tests) | S4: body formatter with marker header |
| `packages/forge/src/ports/forge-adapter.ts`, adapters | S2: `createDigestIssue`/`updateDigestIssue`; GitLab throws |
| `apps/server/src/github/client.ts` | S2: `createIssue` (POST `/repos/{o}/{r}/issues`), `updateIssue` — following `postComment:504` (circuit breaker, API-version header, 10s timeout) |
| `packages/db/src/schema.ts`, `queries.ts` (+tests) | S3: `digests` table (D1), run/open-digest queries |
| `apps/server/src/queues/digest.ts` (+tests) | S3: queue, worker, reconciler, schedule hooks |
| `apps/server/src/index.ts` | S3: in-process worker + startup reconcile |
| `apps/server/src/routes/api/settings.ts`, `installations.ts` | S3: `digestsEnabled` coalescing + schedule hook |
| `.changeset/`, docs | S4 |

## Slices: Size and Risk

| Slice | Lines | Risk | Notes |
| --- | --- | --- | --- |
| S1 core aggregate/rank | ~250 | Low | Pure; equivalence test vs live findings; malformed-row tolerance |
| S2 forge verbs + client | ~180 | Medium | First issue-CREATE write verb; 404/closed handling |
| S3 queue/worker/DB/settings | ~350 | Medium-High | First repeatable usage; double-schedule blast wall = partial unique index; registration lifecycle |
| S4 formatter + changeset | ~150 | Low | Marker byte-stability |

## Testing Strategy

- **S1**: table-driven pure tests — aggregation equivalence (stored findings vs live `computeHealthScore`), recency tiers at 7d boundary, blast-radius/path tiebreaks, malformed jsonb vectors (`null`, `{}`, wrong shapes) skip-not-throw.
- **S2**: mocked client (POST/PATCH URL, payload, error mapping); adapter tests: GitLab verbs throw unsupported; create-then-update flow against fake forge.
- **S3**: table-definition test asserting the partial-unique WHERE + CHECK via `getTableConfig`/`PgDialect` (`packages/db/src/issue-drafts.test.ts:20-26` precedent — no live PG); queue tests with `vi.mock('ghagga-db')` and mocked forge (`issue-draft-reaper.test.ts:12-23` precedent); reconciler: upsert idempotency (same id+pattern twice → one scheduler), opt-out removal, stale cleanup; skip-path issues zero forge calls (spy); one-open invariant: double-flip insert rejected; cron config builder pure unit test. Fake timers where any interval is used; scheduler wiring tested at the function seam (injected queue), no live Redis in CI.
- **S4**: golden body bytes (marker first line, sections present/absent on empty inputs).

## Migration / Rollout

Additive: one new `digests` table + `RepoSettings.digestsEnabled?` (jsonb, optional — old rows read as off, `DEFAULT_REPO_SETTINGS` untouched semantics). No backfill. Rollback per proposal: toggles off → reconciler removes schedulers; rows remain as audit.

## Open Questions

None.
