# Verify Report: nightly-health-digest

- **Merged**: PR #475 → squash commit `455967a` on `origin/main` (local main == origin/main, verified `git rev-parse`). Squash contains all 6 apply commits + 4R fix `15a4555` + port-shape test update + review-ledger docs commit.
- **Verified**: 2026-11-10, sdd-verify phase agent, READ-ONLY against main; offline validation battery re-run.
- **Verdict**: **PASS WITH NOTES** — all 13 tasks implemented as described, all 17 delta scenarios have satisfying tests, the 4R CRITICAL fix is on main with both regressions; notes are non-blocking observations only.

## Per-task verification

| Task | Status | Evidence on main (file:line) |
| --- | --- | --- |
| T1.1 digest.test.ts RED | VERIFIED | `packages/core/src/health/__tests__/digest.test.ts` — table-driven `it.each` window vectors (:44-93, R0 excluded via `since`), malformed vectors (:116-181), equivalence describe (:183-213) |
| T1.2 aggregateHealth | VERIFIED | `packages/core/src/health/digest.ts:105-141` (optional `since` watermark, decision 2); exported `health/index.ts:2-10` AND package `index.ts:444-464` (deviation 6); no providers/agents imports (imports: types.js, score.js only, :10-11) |
| T1.3 rankFileRisk | VERIFIED | `digest.ts:150-176` — `Σ \|SEVERITY_WEIGHTS\| × recency` reusing `score.js` weights (:11), 7d×1.0/31d-excluded boundary tests (digest.test.ts:240,:258), blast-radius + path-asc tiebreaks, top-10, determinism test :347 |
| T2.1 Port + GitLab throws | VERIFIED | `packages/forge/src/ports/forge-adapter.ts:315-326` `DigestPublicationCapable` (after ExplanationPublicationCapable); GitLab throws unsupported `gitlab-forge-adapter.ts:350-375` w/ regex-pinned tests `gitlab-forge-adapter.test.ts:428-435` |
| T2.2 GitHub client writes | VERIFIED | `apps/server/src/github/client.ts` — `createIssue`:551, `updateIssue`:647, `findOpenIssueByTitle`:598 (fix verb) |
| T2.3 GitHub adapter verbs | VERIFIED | `github-client-port.ts:199-227` optional port methods; `github-forge-adapter.ts:403-449` delegation w/ absent-port errors; create-then-update flow `github-forge-adapter.test.ts:657-666`, absent/throwing :676-715 |
| T3.1 digests table + 0007 | VERIFIED | `packages/db/src/schema.ts:472-508` (DIGEST_STATUSES, `uq_digests_open_issue` partial `issue_open = true`, CHECK); `drizzle/0007_digests.sql` (CREATE TABLE + partial unique + CHECK + FK cascade) chains 0006 (`meta/_journal.json:58`); offline `digests.test.ts:34-115` + Docker-gated `__integration__/digests.integration.test.ts:77-137` (5 tests) |
| T3.2 Queries + RepoSettings | VERIFIED | `queries.ts:400` `getReviewsSinceWatermark` (watermark AND 30d, `DIGEST_RANKING_WINDOW_DAYS`:388), `insertDigestRun`:423, `getOpenDigest`:447, `rotateOpenDigest`:468 (flip+insert one tx); `schema.ts:56` `digestsEnabled?`, effective coalesce `queries.ts:186-194`; tests `queries.test.ts:489,:504` |
| T3.3 Queue/worker/wiring | VERIFIED | `apps/server/src/queues/digest.ts` — queue 'digest' mirrors review.ts options (:76-88), `createDigestWorker(2)` (:467), disabled→SKIPPED (:317-331), empty window→SKIPPED zero forge calls (:345-359), update-in-place + 404-rotate (:395-415), POSTED via rotateOpenDigest (:419-428), FAILED via `failed` handler on exhausted attempts (:487-510); wired `index.ts:74` + shutdown Promise.all `index.ts:349`; NO env gate; tests `digest.test.ts:144-433` (21 tests) |
| T3.4 Reconciler + hooks | VERIFIED | `digest.ts:105-122` schedule/unschedule (`digest:{id}`, `0 3 * * *`), `reconcileDigestSchedulers`:145-186 (startup `index.ts:75`), per-repo hook (:192-200), per-installation hook (:207-217); double-schedule invariant test :445, opt-out removal :459/:511, stale cleanup :467, idempotent restart :492 |
| T3.5 Settings plumbing | VERIFIED | `routes/api/settings.ts:46,:124,:146,:192,:444-449` + lazy hook :483-497; `routes/api/installations.ts:102,:368-371` + hook :382-395; `routes/api/digest-settings.test.ts:115-269` covers default-off, global+override, toggle hooks, non-boolean reject |
| T4.1 Formatter | VERIFIED | `packages/core/src/format-digest.ts:19` marker first line, `formatDigestIssue`:51; `format-digest.test.ts` 10 tests incl. byte-determinism :47, ranked+counts :54, trend −7 worsening :77 / omitted first :83, sanitize :99, ±delta wording :115 |
| T4.2 Changeset | VERIFIED | `.changeset/nightly-health-digest.md` — minor bumps ghagga-core/db/forge, release notes carry opt-in default-off, 03:00 UTC, one-issue-updated-in-place, SKIPPED/FAILED, App-only parity |

## Scenario → test map (17 delta scenarios across 5 capabilities)

| Capability | Scenario | Satisfying test |
| --- | --- | --- |
| core-engine | Stored-findings scoring equivalence | digest.test.ts:183-213 (shared fixture through `computeHealthScore`/`generateRecommendations`) |
| core-engine | Aggregation window since watermark | digest.test.ts:43-93 (R0/R1/R2 + no-watermark rows) |
| core-engine | Per-file risk ranking is deterministic | digest.test.ts:215-395 (determinism :347) |
| core-engine | Malformed findings rows are tolerated | digest.test.ts:116-181 |
| distribution | Nightly digest is App-only parity | digest.test.ts:436-455 (queue name 'digest', data only repositoryId) + 0 files under apps/cli/action/dashboard in `455967a` + changeset parity text |
| distribution | CLI and Action health unaffected | diff-level: zero CLI/Action/dashboard files in 455967a; existing health tests green unchanged inside core's 4159 |
| review-formatting | Marker header and deterministic output | format-digest.test.ts:41,:47 |
| review-formatting | Ranked files and summary counts rendered | format-digest.test.ts:54 |
| review-formatting | Trend line present on update, absent on first digest | format-digest.test.ts:77,:83 |
| server | First run creates the digest issue | digest.test.ts:145 |
| server | Second run updates in place | digest.test.ts:176 |
| server | Server restart re-registers without duplicates | digest.test.ts:445,:467,:492 |
| server | Empty window skips without forge calls | digest.test.ts:208,:227 |
| server | Opting out removes the repeatable | digest.test.ts:459,:511 |
| server | Permission failure is recorded, not silent | digest.test.ts:349 |
| settings | digestsEnabled defaults to off | digest-settings.test.ts:116,:128; queries.test.ts:489 |
| settings | Global enable with per-repo override | digest-settings.test.ts:136; queries.test.ts:504 |

**Gaps: none.** All 17 scenarios map to at least one named passing test.

## Ledger fix verification (RISK-001/RES-001 on main)

- **Adopt-before-create on BOTH create paths**: `digest.ts:385-393` `createOrAdopt` (find → adopt/update → else create); invoked on the no-open-row path (:414) AND the 404-rotate path (:406). Forge verb `findOpenDigestIssue` exists end-to-end: port `forge-adapter.ts:326` → client `findOpenIssueByTitle` `client.ts:598` → adapter `github-forge-adapter.ts:434-449` → factory getter in worker seam `digest.ts:277`; GitLab throws (`gitlab-forge-adapter.ts:370-375`).
- **Regression 1 (first-run adopt)**: `digest.test.ts:293-314` — orphan #55 adopted, `createDigestIssue` NOT called, rotate receives issueNumber 55.
- **Regression 2 (404-path adopt)**: `digest.test.ts:316-347` — update 404 → adopt #77, create NOT called, rotate receives 77.
- **Port-shape test update**: `ports/forge-adapter.test.ts:56-95` now pins the THREE-method capability (incl. `findOpenDigestIssue` null/number branches, :72-75) — the stale two-verb assertion is fixed.
- Ledger info findings (RES-002/003, REL-001/002, REA-001-004) remain status `info` by contract — correctly NOT re-reviewed, tracked as fix-between-SDDs backlog (RES-002 still observable at `digest.ts:472` seam-before-guards).

## Offline validation (re-run on main, 2026-11-10)

| Command | Result |
| --- | --- |
| `pnpm --filter ghagga-core build` | exit 0 |
| `pnpm --filter ghagga-core test` | 162 files, **4159 passed / 1 skipped** (matches apply-progress) |
| `pnpm --filter ghagga-forge test` | **345 passed**, 0 type errors |
| `pnpm --filter ./apps/server exec vitest run src/queues/digest.test.ts` | 1 file, **21 passed** (matches ledger fix-round count) |
| `pnpm exec biome check .` | **0 errors**, 104 warnings + 3 infos (pre-existing baseline) |

## Notes (non-blocking)

1. Docker-gated PG integration (`digests.integration.test.ts`, 5 tests) was NOT run here — offline-only mandate; apply-progress records 61 integration tests passing with Docker up.
2. Known info-level follow-ups from the 4R ledger remain open as backlog (seam-before-guards ordering, fire-and-forget settings hooks, 30-day window dual-sourced, watermark clock-skew, reconciler NaN parse — the NaN guard is actually present at `digest.ts:175`, narrowing REA-003 to the `removed.push(repositoryId)` bookkeeping only).

## Verdict

**PASS WITH NOTES** — 13/13 tasks verified, 17/17 scenarios satisfied, CRITICAL fix confirmed on main with regressions, full offline battery green on main at `455967a`.
