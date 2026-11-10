# Review Ledger — blast-radius-diagram

Full-4R review (diff >400 lines) of `feat/blast-radius-diagram`, 2026-11-10. Four lenses, one exhaustive sweep each. Adversarial verification: 3 CRITICAL candidates → 3 refuters (correctness / exploitability-impact / reproducibility), independent 2-of-3 vote. Fix round 1 of max 2 → scoped re-review: **all findings resolved, zero new defects**.

## Candidates (BLOCKER/CRITICAL) — refuted verdict table

| ID | Lens votes (C/I/R) | Outcome | Resolution |
|---|---|---|---|
| RES-001 | STANDS / STANDS / STANDS (3-0) | **Fixed (round 1)** | Budget overrun → `undefined` (counts-only class), never a failedStep; clusterCounts bounded top-20. Scoped re-review: RESOLVED. |
| RES-002 | STANDS / REFUTED / STANDS (2-1 → stands) | **Fixed (round 1)** | Server guard shape-checks `mermaid` + `meta`; legend defaults `meta`. Scoped re-review: RESOLVED. |
| REL-001 | STANDS / STANDS(+severity note) / STANDS (3-0) | **Fixed (round 1)** | Edges derive from survivors' complete `imports` records (no neighborhood slicing can hide them); hoods feed ranking only. Scoped re-review: RESOLVED. |

Refuter evidence highlights: RES-001 reproduced by execution 3× independently (10,662–12,369 chars in-cap; finalize chain verified PASSED→PARTIAL); impact correction recorded — Action exit code unaffected (fails only on FAILED), harm is status/dashboard/trust. REL-001 reproduced with a 15-importer hub (edge absent, `truncated:false`); impact noted advisory-only (verdict/coverage untouched) but spec-scenario violation stood. RES-002 crash reproduced in jsdom (TypeError in sync render, fallback never engaged); impact refuter argued no writer can produce the blob today — vote stood 2-1; fix is cheap defense in depth.

## Info findings (WARNING/SUGGESTION — status info, never blocking)

- RISK-001 (WARNING): >25 changed files dropped `changed[25..]` without `truncated` — **fixed in passing** in round 1 (same code block); re-review RESOLVED.
- RES-003 (WARNING): lazy chunk-load failure (stale chunk post-deploy) escapes the component try/catch → app-level boundary + cached rejection. Open follow-up (info).
- REL-002 (WARNING): clusterCounts unbounded pre-fix — subsumed by the RES-001 bound (top-20).
- REA-001 (WARNING): `toReviewDto` doc block orphaned by inserted helper (position).
- REA-002 (WARNING): mermaid-lazy test regex misses bare `import 'mermaid'` and deep specifiers — guard incomplete.
- REA-003/004/005 (SUGGESTION): `comparePaths` duplicated builder/renderer; `MERMAID_ROOT_CLUSTER` dead export; legend wording duplicated comment/dashboard.

## Verified clean (per lens)

- **Risk**: sanitizer allowlist kills quotes/backticks/`<>%#`/newlines pre-cap; labels always quoted, ids generated; edges/legend zero untrusted bytes; injection corpus pins it. Lockfile additions = mermaid's own tree only. DTO projects the sanitized artifact verbatim.
- **Reliability**: gating truth table (absent/null/legacy/exceededCap/stale → section absent, DTO key absent) pinned by tests; determinism (poolFiles sorted, survivors changed→degree/path, renderer id sort); single graph load pinned; 4 golden hunks diagram-only.
- **Resilience**: builder inside the blast-radius degradation envelope; exceededCap/empty/500-file → counts-only (fixtures); comment delta bounded ~3.2k; concurrent renders safe; `toReviewDto` cannot throw.
- **Readability**: caps single-sourced in schema.ts; naming consistent end-to-end; corpus asserts byte-exact content; fallback reuses the sanitized source.

## Fix round record

Commit 38e02bb (6 files, +178/−37): RES-001 budget-degrade + cluster bound; REL-001 direct-imports edge derivation; RES-002 guard + legend default; RISK-001 omitted-changed. 5 regression tests added (hub edge, budget→undefined, >25-changed truncation, 3 meta-less DTO shapes, missing-meta render). One fix-author bug caught during the round: the budget guard initially imported the constant from a non-re-exporting module (inert guard) — caught by the regression test + probe, import corrected to `schema.js`. Full suites: core 4,126 / server 1,144 / dashboard 621 green; biome 0 errors, 104 pre-existing warnings.

## Follow-ups (fix-between-SDDs backlog)

1. RES-003: lazy-load failure boundary (per-component error boundary or retry-keyed lazy).
2. REA-002: tighten the mermaid-lazy guard regex (bare imports, deep specifiers, .js/.jsx).
3. REA-003/005: single-source `comparePaths` and the legend wording.
4. Non-blocking re-review note: `assertDiagramJsonBudget` now has zero production callers (test-only export).
