# Review Ledger — nightly-health-digest

Full-4R review (diff >400 lines) of `feat/nightly-health-digest`, 2026-11-10. Four lenses, one exhaustive sweep each. Adversarial verification: one CRITICAL candidate with CONVERGENT discovery (risk + resilience independently, identical root cause) → reconciliation rule 1 (2+ voices, high confidence) → fix-forward, refutation batch skipped per that rule (documented here). Fix round 1 of max 2 → scoped re-review: **RESOLVED, zero new defects**.

## Candidate — convergent CRITICAL

| ID | Lens votes | Outcome | Resolution |
|---|---|---|---|
| RISK-001 ≡ RES-001 | risk + resilience, independent discovery, identical root cause | **Fixed (round 1)** | Adopt-before-create: new forge verb `findOpenDigestIssue` (exact-title over open issues); worker adopts a crashed attempt's orphan on BOTH create paths (first-run + 404-rotate) instead of blind-POSTing duplicates (BullMQ attempts 3 → up to 3 orphans/night, recurring). Scoped re-review: RESOLVED; regressions pin create-NOT-called + rotate-receives-adopted-number on both paths. |

Root cause detail: the one-open partial unique index (`uq_digests_open_issue`) constrains DB rows only — it cannot see forge-side orphans. The crash window between `createDigestIssue` and the `rotateOpenDigest` commit left no open row, so every retry re-entered the create branch.

## Info findings (WARNING/SUGGESTION — status info, never blocking)

- RES-002 (WARNING): processor builds the GitHub seam BEFORE `runDigestForRepository`'s guards — a deleted repo burns 3 attempts + FK-rejected FAILED row instead of the intended graceful SKIPPED; self-heals on restart.
- RES-003 (WARNING): settings-save hooks are fire-and-forget — Redis down during PUT returns 200 with no scheduler registered; silent until next boot reconciler.
- REL-001 (WARNING): settings-save hooks upsert the scheduler unconditionally; bullmq 6.7 `override:true` semantics can drop a due-and-waiting nightly run (missed night, self-heals next night; real semantics untested — suite uses a fake queue).
- REA-001 (WARNING): `getReviewsSinceWatermark` docblock sells the 30-day DB filter as volume-bounding when it is load-bearing for digest contents; name hides the window.
- REA-002 (WARNING): 30-day window dual-sourced (`DIGEST_RANKING_WINDOW_DAYS` db / `RANKING_WINDOW_DAYS` core), no cross-reference — silent drift.
- REL-002 / REA-003 / REA-004 (SUGGESTION): watermark clock-skew double-count window; reconciler NaN id contract break on malformed ids; synthetic HealthHistoryEntry filler unmarked.

## Verified clean (per lens)

- **Risk**: injection neutralized (`sanitizeTableCell` strips HTML comments — the marker cannot be faked into file paths); token/auth/circuit-breaker conventions; 403 drift → bounded attempts → single FAILED row, no loop; settings coalescing matrix (repo wins wholesale, `?? false`, fire-time re-resolve); reconciler cannot register non-opted repos; no secrets in bodies; GitLab verbs unreachable (repositories table is GitHub-only).
- **Reliability**: watermark truth table (SKIPPED/FAILED unchanged, POSTED=runAt) verified incl. bullmq internals (`attemptsMade` increments before `failed` emit — FAILED row exactly once); 404-only rotation (closed issues PATCH 200); scoring equivalence pinned on shared fixture; tiebreak chain deterministic; formatter byte-stable; migration 0007 chains 0006, CHECK matches enum; restart neither duplicates nor re-upserts schedulers; no regressions (GitLab compiles with new verbs — throws).
- **Resilience**: startup never blocks; reconciler idempotent + heals; shutdown order race-free; malformed/null jsonb tolerated; watermark null handled; GitLab misroute bounded.
- **Readability**: enum/naming consistent with house (issue_drafts, review.ts queue); severity weights imported not redefined; marker single-sourced; integration tests assert the INDEX by name on real PG; 0007 snapshot clean-generated; worker 123 lines (house precedent ~600); no lying fake-timer tests.

## Fix round record

Commit 15a4555 (8 files, +187/−8): `findOpenDigestIssue` port verb + GitHub client `findOpenIssueByTitle` (circuit breaker, 10s, PR-filtered, exact title) + adapter + factory getter + GitLab throw-verb + `createOrAdopt` in the worker (both create paths) + 2 regression tests. Server suite 1,178 green (digest 21); forge+server typechecks; biome 0 errors, 104 pre-existing warnings (baseline restored after a transient +1 unused-param warning).

## Follow-ups (fix-between-SDDs backlog)

1. RES-002: reorder guards before seam construction (deleted-repo → SKIPPED not 3 attempts).
2. RES-003 + REL-001: settings-hook registration semantics (await or surface failure; conditional upsert only when digestsEnabled changed; real-queue scheduler semantics test).
3. REA-001/REA-002: fix the docblock + cross-reference (or single-source) the 30-day window.
4. REL-002: pin watermark to max(runAt, last row createdAt).
5. REA-003: guard the reconciler id parse (NaN contract).
