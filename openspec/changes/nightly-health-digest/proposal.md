# Proposal: Nightly Health Digest

## Intent

Health signals already accumulate server-side (`reviews.findings` jsonb per review), but nobody sees them unless they run `ghagga health` manually in the CLI. Add an opt-in nightly per-repo digest: a scheduled, token-free aggregation of stored findings, risk-ranked, published and maintained as ONE digest issue per repo on GitHub.

## Scope Decision

**Selective.** Ship scheduling + DB aggregation + single-issue publication as one evaluable closed loop. LLM narratives, dashboard surfaces, GitLab, and per-repo schedule configuration would each add surface before the core question — does scheduled visibility change behavior? — can be answered.

## Scope

### In Scope

- Per-repo opt-in digest, **off by default** (optional-boolean-off precedent: `explanationsEnabled`, `schema.ts:38`), resolved through the existing RepoSettings global/per-repo flow.
- Fixed default schedule `0 3 * * *` UTC in v1; per-repo cron override deferred to RepoSettings later.
- **DB-only aggregation**: `reviews.findings` jsonb since the last digest — no LLM calls, no review-pipeline runs, zero tokens.
- Health module extended to accept stored findings (today it only sees live tool runs); per-file risk ranking from findings + `metadata` blast-radius counts.
- Publication: issue-CREATE on first run, marker-based UPDATE-in-place after (issue-draft marker pattern); ONE open digest issue per repo, enforced by a DB invariant.
- Skip-and-record when no new findings since the last digest.

### Out of Scope (Non-goals)

LLM summaries (phase 2 if demanded) · digest-state dashboard UI (logs + DB only in v1) · GitLab (port exposes MR notes only) · per-repo timezone config · new `file_risk` rollup tables.

## Capabilities

### New Capabilities

None — scheduling lands as a server requirement; no new spec directory.

### Modified Capabilities

- `core-engine`: health module accepts DB-sourced findings; aggregation across reviews; per-file risk ranking input to formatting.
- `server`: digest queue + repeatable registration + worker; settings toggle plumbing; skip/failure recording.
- `settings`: per-repo digest-enabled flag (default off) within RepoSettings resolution rules.
- `review-formatting`: digest issue body format (summary counts, trend, ranked files) from health outputs.
- `distribution`: nightly posting is **SaaS/App-only** (CLI already has `ghagga health`; Action path unaffected) — parity note.

## Approach

**Approach B — BullMQ repeatable per-repo jobs into a dedicated `digest` queue** (jobId `digest:{repositoryId}`, cron from settings, default `0 3 * * *` UTC), re-registered idempotently on startup/settings change.

**Reconciling the documented single-box decision** (`workers/issue-analysis.ts:40-43`): that comment rejected a BullMQ repeatable for the issue-draft *reaper* — a 5-minute recovery sweep whose whole point is cheap in-process crash cleanup, where per-repo cron fidelity and durable missed-run semantics would be overhead. A nightly per-repo digest is a different workload: it needs cron fidelity, per-repo identity, and durable behavior across restarts, which `setInterval` (Approach A) cannot give without re-implementing them. The deployment assumption behind the comment — one server instance — remains true today; repeatable jobs on a single scheduler instance do not fork that reality, they formalize it. We are not converting the reaper.

**Working decisions (vetable at spec review):** B over A/C; DB-only zero-token source; create-once/update-in-place; opt-in off + fixed default cron; skip-when-empty.

### Slices

- **S1 — core health, DB-sourced** (~250 lines incl. tests): ingestion seam for stored `ReviewFinding[]`, multi-review aggregation, per-file ranking (count × severity × recency; blast-radius from `metadata`), tolerant of malformed jsonb rows.
- **S2 — forge write verbs** (~180 lines): `createDigestIssue`/`updateDigestIssue` on `ports/forge-adapter.ts`, GitHub adapter + client (`POST /repos/{o}/{r}/issues`, issue edit); GitLab verbs throw unsupported.
- **S3 — digest queue/worker + settings + invariant** (~350 lines): `digest` queue + repeatable registration/reconcile, worker (modest concurrency), `digestsEnabled?: boolean` on RepoSettings + route coalescing, DB digest-state row with one-open-per-repo lookup/invariant, last-digested watermark, skip-and-record.
- **S4 — formatting + changeset** (~150 lines): digest body formatter (review-formatting conventions, marker header), docs + changeset.

## Affected Areas

| Area             | Impact     | Description                                              |
| ---------------- | ---------- | -------------------------------------------------------- |
| `packages/core`  | Modified   | Health ingestion/aggregation/ranking, headless of forge  |
| `packages/forge` | Modified   | Digest issue create/update verbs (GitHub-only)           |
| `apps/server`    | Modified   | Digest queue, repeatable registration, worker, routes    |
| `packages/db`    | Modified   | Digest state row, watermark, findings aggregation query  |

## Risks

| Risk                     | Mitigation                                                                    |
| ------------------------ | ----------------------------------------------------------------------------- |
| Spam / duplicate digests | jobId-keyed repeatable (idempotent re-registration), one-open DB invariant, issue marker |
| Permission drift         | Older self-hosted Apps may lack Issues:write; record failure state on the digest row, never silently skip |
| Fan-out jitter           | Thousands of repos at one cron minute; v1 accepts it (low volume), hash-spread documented as follow-up |
| Findings shape drift     | jsonb is `unknown[]`; aggregation must skip/flag malformed rows, never throw  |
| Stale/empty noise        | Skip-and-record when no findings since watermark; no forge call              |

## Rollback Plan

Set `digestsEnabled` off (default) everywhere — registration reconciler removes repeatables; retire the `digest` queue/worker. Stored digest rows remain for audit; review queue, triage flow, and CLI health are untouched throughout.

## Dependencies

- Existing BullMQ (`^6.7.0`, native repeatable support), Redis, DB, GitHub App with Issues read/write (already in the manifest). No new libraries.

## Success Criteria

- [ ] Two consecutive digest runs for one repo produce ONE issue; the second updates in place (marker idempotency, offline forge double-call test).
- [ ] A second open digest row per repo is impossible (DB invariant test).
- [ ] No new findings since watermark → run records `skipped`, issues zero forge calls.
- [ ] Server restart re-registers the identical repeatable (same jobId + cron) without duplicating schedules or firing twice.
- [ ] Health scoring over stored findings equals the pure-function result for the same findings live (equivalence test).
- [ ] Malformed/legacy findings rows are tolerated (skipped or counted unknown; no throw).
- [ ] Opting out removes the repeatable and stops publication; review behavior unchanged.

## Open Design Questions

1. Should each digest also persist a DB health-history row (making CLI-local `health-history.json` server-obsolete) or stay write-only to the forge?
2. Risk-ranking weights: findings count × severity × recency × blast-radius — agreed defaults?
3. Fan-out: accept shared 03:00 UTC in v1, or hash-spread repos across the hour from day one?
4. Missed-run policy when the server is down at cron time: catch-up on restart vs skip to next night?
5. Is logs + digest-row state sufficient failure visibility for permission drift, or does the dashboard need a readable status?
6. Issue title/marker convention: how stable must it be for rename-safe lookup after manual user edits?
