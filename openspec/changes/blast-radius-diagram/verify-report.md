# Verify Report: blast-radius-diagram

- **Change**: blast-radius-diagram (13 tasks, 4 slices)
- **Merge**: PR #474 squash → `main` @ `97ee9af` (2026-11-10); local `main` == `origin/main` verified.
- **Mode**: READ-ONLY verification against merged main; evidence cites file:line at `97ee9af`.
- **Verdict**: **PASS WITH NOTES** (2 pre-existing notes, 0 change gaps; all 13 tasks implemented, all 14 delta scenarios have satisfying tests, all 4 fix-round fixes present with regression tests, offline validation green).

## 1. Per-task verification

| Task | Implementation evidence on main | Status |
|---|---|---|
| T1.1 renderer tests | `packages/core/src/graph/diagram.test.ts` — 25 `it(` blocks: D6 vector set, closed-charset property, emission order, numeric-id sort, caps, 10k budget | DONE |
| T1.2 renderer + schema | `packages/core/src/graph/diagram.ts:86` (`sanitizeMermaidLabel`), `:144` (`renderMermaidDiagram`), `:102` (`clusterOfPath`), `:287` (`assertDiagramJsonBudget`); caps + `BlastRadiusDiagram` shape at `graph/schema.ts:255-328` beside `MAX_BLAST_RADIUS_FILES` (:247); exported via `graph/index.ts:11-15,49,55` + `core/src/index.ts:361` | DONE |
| T2.1 summary tests | `graph/diagram-summary.test.ts` — both-direction edges (:61, :80), survivor determinism (:163), 40/25 cap + clusterCounts (:124), internal-edge filter (:146), 49/50/51 boundary (:210/:219/:227), stale (:243), empty gates (:257, :262), immutability (:275) | DONE |
| T2.2 summary builder | `graph/diagram-summary.ts:83` `buildBlastRadiusDiagramSummary(graph, result, graphStale)`; `exceededCap → undefined` (:89); caps + budget at BUILD time (:177-209); `BlastRadiusMetadata.diagram?` additive at `schema.ts:225` | DONE |
| T2.3 wiring, single-graph | `pipeline/prepare-graph.ts:178-188` — builder called inside the in-cap branch against in-hand `graph` (:85 load, once) + untouched `blastResult` (:99) + `stale` (:90); try/catch → `failedSteps` (:183-188); exceededCap branch (:104-116) and `computeBlastRadius` (:99-102) 0-diff; `enrich.ts` passes metadata whole (apply claim confirmed by DTO e2e below). `prepare-graph-diagram.test.ts` 6 scenarios incl. loader-called-ONCE (:138) and builder-throw continuation (:189) | DONE |
| T2.4 corpus | 9 fixture dirs under `test/fixtures/blast-radius-diagram/` (empty, single-file, hub-and-spoke, cycle, exceeded-cap, stale, unicode-paths, injection-corpus, 50-file-cap-boundary) + `graph/diagram-corpus.test.ts` (shape + byte-exact mermaid + two-run determinism + GRAPH_VERSION guard) | DONE |
| T3.1 format tests | `format.test.ts:1232-1403` — S7 structure (:1292) + position (:1311), S8 byte-identity (:1325, :1334), S9 end-to-end injection (:1340), S10 `+15 more` (:1377), S11 flags (:1403) | DONE |
| T3.2 format section | `format.ts:467` `formatBlastRadiusSection` — gate `''` on absent/empty (:468); wraps `diagram.mermaid` UNMODIFIED (:489); OPEN section, no `<details>` (:487-490); positioned after file-category block (:657) before cost footer (:671) via `:662`; legend from trusted literals + meta booleans/counts (:470-485) | DONE |
| T3.3 consumer goldens | CLI/server/action suites green with diagram-absent data (validation below); commit message records the rg marker sweep — zero fixture updates needed | DONE |
| T4.1 DTO type | `packages/types/src/api.ts:79` `blastRadiusDiagram?: BlastRadiusDiagram` after `coverageComplete`, type canonical-in-core (:14, :16); package index re-export `types/src/index.ts:2` (the 7bc6231 follow-up fix) | DONE |
| T4.2 server projection | `apps/server/src/routes/api/reviews.ts:181-190` `isDiagramObject` fail-closed structural guard (mermaid non-empty string + meta object); `toReviewDto:217` conditional spread — key only when present, never `null`/`{}`; `reviews.dto.test.ts` 6 tests | DONE |
| T4.3 dashboard component | `apps/dashboard/src/components/MermaidDiagram.tsx` — static mermaid import (:24, the chunk-isolation mechanism), `initialize({startOnLoad:false})` once (:72-75), effect render (:85-96), reject/throw → `<pre><code>` fallback (:102-113), honesty legend (:35-65); `mermaid ^12.3.0` in dashboard `package.json:21` (11→12 bump for the katex OSV advisory, documented in the squash); `MermaidDiagram.test.tsx` 7 tests (mocked mermaid) | DONE |
| T4.4 lazy embed | `pages/Reviews.tsx:28` `lazy(() => import('@/components/MermaidDiagram'))`, Suspense-wrapped (:104), mounted only when `review.blastRadiusDiagram` (:101); `Reviews.test.tsx:1678` absent → never mounts + import factory never runs, `:1692` present → mounts with DTO data; `mermaid-lazy.test.ts` static-import ban + lazy-only reference + single consumer. Note: `vite build` chunk harness intentionally skipped (build-authorization house rule) — source-level assertion is the agreed CI-fast proxy | DONE |
| T4.5 changeset | `.changeset/blast-radius-diagram.md` — minor `ghagga-core` + `ghagga` (fixed group), release notes cover comment + dashboard + counts-only rollback | DONE |

## 2. Scenario → test map

### core-engine delta

| Scenario | Satisfying test(s) | Verdict |
|---|---|---|
| Successful full pipeline review (pre-existing) | `pipeline.test.ts:237` workflow dispatch, `:255` valid ReviewResult; `pipeline-golden.test.ts` full-pipeline goldens | COVERED |
| Static analysis failure does not block review (pre-existing) | `pipeline.test.ts:510` 'continues when static analysis throws', `:296` toolsRun/toolsSkipped | COVERED |
| Empty diff (pre-existing) | `pipeline.test.ts:182` — but asserts a THROW ('non-empty diff'), while the copied base scenario text says ReviewResult SKIPPED/'empty diff'. **Pre-existing base-spec drift, carried verbatim by this delta; NOT introduced by this change.** See Notes. | COVERED (pre-existing) + NOTE |
| Edges derived in both directions from the neighbors API | `diagram-summary.test.ts:61` (importee+importer edges), `:80` (no dangling); unchanged-semantics clause → `prepare-graph-diagram.test.ts:138` (single load, same computeBlastRadius opts) | COVERED |
| Render cap enforcement and deterministic output | `diagram-summary.test.ts:124` (40/25 → exactly 25, truncated+clusterCounts), `:163` (deterministic ranking); `diagram-corpus.test.ts` two-run byte-identity per case | COVERED |
| Oversize blast radius falls back to counts-only | `diagram-summary.test.ts:227` (51 files → undefined); `prepare-graph-diagram.test.ts:165` (exceededCap → counts-only, no diagram), `:189` (builder throw swallowed, review continues) | COVERED |

### review-formatting delta

| Scenario | Satisfying test(s) | Verdict |
|---|---|---|
| S7 section rendered when data present | `format.test.ts:1292` (one heading/fence, 5 nodes n0..n4, 4 edges), `:1311` (position Files Changed → Blast Radius → cost footer) | COVERED |
| S8 byte-identical when absent | `format.test.ts:1325` (counts-only → no section, byte-identical), `:1334` (absent key); consumer goldens T3.3 | COVERED |
| S9 injection vectors neutralized | `format.test.ts:1340` (end-to-end through real builder + formatter); `diagram-corpus.test.ts:146` (injection-corpus, no hostile byte, no header injection) | COVERED |
| S10 capped truncation "+N more" | `format.test.ts:1377` (≤25 nodes, `+15 more`, omitted names absent) | COVERED |
| S11 stale + exceededCap legend | `format.test.ts:1403` (both notes, neither dropped — synthetic input per the spec-wins resolution) | COVERED |

### server delta

| Scenario | Satisfying test(s) | Verdict |
|---|---|---|
| List reviews for a repository (pre-existing) | `reviews.filter.test.ts` (14 tests, green) | COVERED |
| Update repository settings (pre-existing) | settings route suites (untouched by change; full server suite green) | COVERED |
| Manage API keys (pre-existing) | api-key route suites (untouched; AES-GCM tests pre-exist) | COVERED |
| Review with diagram data returns the key | `reviews.dto.test.ts:135` (5 nodes/4 edges, no transformation loss) | COVERED |
| Review without diagram data omits the key | `reviews.dto.test.ts:188` (counts-only), `:212` (corrupt jsonb), `:222` (meta-less) — key absent, never null/{} | COVERED |
| Backward compatibility for old clients | `reviews.dto.test.ts:202` (legacy rows), `:233` (mixed list, shape identical elsewhere) | COVERED |

### dashboard-ui delta

| Scenario | Satisfying test(s) | Verdict |
|---|---|---|
| View review list (pre-existing) | `Reviews.test.tsx` — 'Reviews page', 'table rendering', 'status filter', 'search filter', 'pagination' describes | COVERED |
| View review detail (pre-existing + diagram clause) | `Reviews.test.tsx:786` detail modal; `:1692` diagram clause | COVERED |
| Diagram renders when present | `MermaidDiagram.test.tsx:52` (8 nodes/7 edges render), `:80` (legend flags); `Reviews.test.tsx:1692` (chunk imported once) | COVERED |
| No render and no bundle cost when absent | `Reviews.test.tsx:1678` (never mounts, import factory never runs); `mermaid-lazy.test.ts:48,65,77` (static-import ban, lazy-only reference, single consumer) | COVERED (source-level proxy; build harness skipped by rule) |
| Render failure falls back to a code block | `MermaidDiagram.test.tsx` reject path, `:133` sync throw, `:144` fallback legend, `:151` missing-meta no-crash | COVERED |

**Scenario gaps introduced by this change: NONE.**

## 3. Fix-round verification (ledger → main)

| Finding | Fix on main (97ee9af) | Regression test |
|---|---|---|
| RES-001 budget throw → PASSED→PARTIAL downgrade | `diagram-summary.ts:207-209` budget overrun → `return undefined` (counts-only class, never failedSteps); clusterCounts bounded top-20 (`:198-201`) | `diagram-summary.test.ts:333` 'budget overrun degrades to undefined instead of throwing into failedSteps' (25 survivors in ~78-char dirs) |
| REL-001 hub edges hidden by capped neighborhoods | `diagram-summary.ts:164-171` edges derive DIRECTLY from each survivor's complete `node.imports` record; hoods feed degree ranking only (`:125-129`) | `diagram-summary.test.ts:299` 'hub edges between survivors survive beyond the neighborhood per-direction cap' (12-decoy hub) |
| RES-002 meta-less blob crashes Reviews page | `reviews.ts:181-190` guard shape-checks mermaid+meta (fail-closed); `MermaidDiagram.tsx:39-43` legend defaults `meta` with typed flags object (the CI-caught `?? {}` typing follow-up is fixed on main) | `reviews.dto.test.ts:222` (3 meta-less shapes → key omitted); `MermaidDiagram.test.tsx:151` (missing meta renders, no TypeError) |
| RISK-001 >25 changed files silently dropped | `diagram-summary.ts:142-145` `omitted` includes `changed.slice(MAX_DIAGRAM_NODES)`; `:187-188` sets `truncated` | `diagram-summary.test.ts:353` 'more changed files than the node cap still flags truncation and counts omissions' |

All four fixes and their regression tests are present on main. The ledger's "fix-author bug caught during the round" (budget constant imported from a non-re-exporting module) is resolved: `diagram-summary.ts:59` imports `BLAST_RADIUS_DIAGRAM_MAX_JSON_CHARS` from `./schema.js`.

## 4. Offline validation (run at verification, merged main)

| Gate | Command | Result |
|---|---|---|
| Core build | `pnpm --filter ghagga-core build` | OK (tsc + assets) |
| Core tests | `pnpm --filter ghagga-core test` | **160 files, 4,126 passed / 1 skipped** |
| Server DTO | `pnpm --filter ./apps/server exec vitest run src/routes/api/reviews.dto.test.ts` | **1 file, 6 passed** |
| Dashboard | `pnpm --filter ./apps/dashboard test` | **39 files, 621 passed** |
| Lint | `pnpm exec biome check .` | **0 errors**; 104 warnings + 3 infos (matches ledger: pre-existing, empty intersection with changed files) |

Counts match the ledger's post-fix-round numbers (core 4,126 / dashboard 621) exactly.

## 5. Notes (non-blocking, pre-existing or by-rule)

1. **Empty-diff scenario text drift (pre-existing)**: the core-engine base scenario "Empty diff" (copied verbatim into this delta) says the pipeline "MUST return a ReviewResult with status SKIPPED and reason 'empty diff'", but `reviewPipeline` throws `'non-empty diff'` (`pipeline.test.ts:182-190` pins the throw). This predates the change (the delta's three pre-existing scenarios were carried unchanged per its merge-seam note) — record it for the base-spec maintenance backlog, not this change.
2. **`vite build` chunk harness skipped by house rule** (documented in apply-progress): the "main bundle MUST NOT include mermaid" clause is pinned at source level by `mermaid-lazy.test.ts` (static-import ban + lazy-only reference + single consumer) plus `Reviews.test.tsx:1678` (import factory never runs). Residual risk (bundler-level hoisting) is theoretical given no entry-reachable static import exists.
3. Ledger follow-up backlog stands as recorded (RES-003 lazy-load failure boundary; REA-002 regex tightening; REA-003/005 dedup; `assertDiagramJsonBudget` now test-only export with zero production callers — confirmed: only the builder's inline check at `diagram-summary.ts:207` runs in production).

## 6. Verdict

**PASS WITH NOTES.** All 13 tasks implemented and verified on merged main with file:line evidence; all 14 delta scenarios (5 new-formatting + 3 new-core + 3 new-server + 3 new-dashboard mapped above, plus carried pre-existing scenarios) have satisfying tests; all 4 fix-round fixes (RES-001, REL-001, RES-002, RISK-001) are on main with regression tests; offline validation fully green (0 errors). The two notes are pre-existing base-spec drift and a by-rule skipped optional build harness — neither is a gap of this change.
