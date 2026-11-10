# Verify Report — graph-context-retrieval

**Change**: graph-context-retrieval (squash-merged to `main` as `07a06f8`, PR #471, 2026-11-10T06:12:33Z).
**Verifier method**: read-only verification against `origin/main`. The working tree's tracked files are byte-identical to `origin/main` (`git diff origin/main -- packages apps .changeset` → empty; squash merge, same tree). All file:line citations below are valid on `main`.
**Note on task count**: tasks.md contains **17** checkbox task items (T1.1–T5.6), not 14 as stated in the dispatch and apply-progress. All 17 were verified.

## 1. Per-task verification

| Task | Status | Evidence (file:line on main) |
|---|---|---|
| T1.1 Neighbors tests | VERIFIED | `packages/core/src/graph/neighbors.test.ts` — table-driven rows: importers via imports AND call edges (:59-65), exports capped at 10 (:113), importers cap (:164), importees cap (:176), no-truncated-when-fits (:189), 30-file cap (:199), opts overrides (:212), cycles (:92), self-edge exclusion (:105), isTest propagation (:127), missing files omitted (:156), empty input (:40) |
| T1.2 Neighbors API | VERIFIED | `packages/core/src/graph/neighbors.ts` — `collectFileNeighborhoods` :83-134, `FileNeighborhood` :23-48, caps `MAX_NEIGHBORS_PER_FILE=10` :60 / `MAX_NEIGHBORHOOD_FILES=30` :63 / `MAX_EXPORTED_SYMBOLS_PER_FILE=10` :66, `truncated` :109-112, self-edges filtered :102-103, missing node omitted :100, empty → `[]` :88, reverse index reused :93. Exported via `graph/index.ts:46-50` and core barrel `index.ts:365-390` |
| T2.1 Budgeted formatter | VERIFIED | `packages/core/src/graph/neighborhood-format.ts` — default cap 1,200 tokens :27, `CHARS_PER_TOKEN=4` :30, join-aware budget :75-105, truncation notice "X of Y file(s) shown" :99-101, file-level "older commit" header :79, file-level = paths+counts only NO symbols :135-139, symbol-sparse degrades to imports/exports with no placeholder :122-127, stats variant `formatGraphNeighborhood` :68. Tests: `neighborhood-format.test.ts` 14 tests (:37, :42, :54, :73, :81, :89, :100, :115, :123, :134, :142, :167, :175, :179) |
| T3.1 Degradation matrix | VERIFIED | `packages/core/src/pipeline/gather-graph-context.test.ts:226-361` — 9 rows: disabled :227, no-graph auto :244, no-graph explicit :252, oversize/loader-refuses :271, stale>7d :291, fresh-exact with missing file (filesCovered<changed) :310, not-exact-fresh :327, formatter throw→failedStep :342 |
| T3.2 Pipeline wiring | VERIFIED | `gather-safe.ts:272-351` (`gatherGraphContextSafe` ladder: disabled :281, no-graph :289-298, stale :304-313, freshness tier :317-319, throw→failedStep :338-350); `state.ts:105-108`; `types.ts:293/:299` (settings) + `:603` (`graphContextMetadata?`); `gather-context.ts:60-67` (4th leg of step-5 `Promise.all`); `enrich.ts:123-124` (metadata attach); `prepare.ts:254-263` (explicit-true step-2.5b load), `:323-324` (graph threading) |
| T3.3 Budget neutrality + goldens | VERIFIED | `gather-graph-context.test.ts:364-393` — same diff on/off → byte-identical `diff`/`staticContext`/`memoryContext`/`stackHints` agent args. Goldens: `pipeline-golden.test.ts` suite green (core suite 4034 passed); 5 loaded-graph goldens carry the spec-mandated additive `graph-context` event + metadata (see deviation ruling D2) |
| T3.4 CLI default-on mirror | VERIFIED | `apps/cli/src/commands/review.ts` — `resolveGraphContextEnabled` :1221-1228 (precedence: `--no-graph-context` > `.ghagga.json` > auto-on with `.ghagga/graph.json`), flag :141-143, settings wiring :340-345, loader gate `enableBlastRadius \|\| enableGraphContext` :374. Tests: `review-graph-context.test.ts` 7 tests (:37-71) — ran, 7 passed |
| T4.1 Per-voice section tests | VERIFIED | Optional param on all 5 runners: `simple.ts:52`, `workflow.ts:104`, `consensus.ts:87`, `fan-out-lenses.ts:467`, `diagnostic.ts:57`. Byte-identity absent-vs-empty pinned per runner: `simple.test.ts:431`, `workflow.test.ts:758`, `consensus-review.test.ts:269`, `fan-out-lenses.test.ts:1145`. Exactly-one-section: `simple.test.ts:442-448`, `fan-out-lenses.test.ts:1169` |
| T4.2 Section + framing helper | VERIFIED | `prompts.ts:661-671` — `buildGraphNeighborhoodSection`: `wrapUntrusted` fence with `GRAPH_NEIGHBORHOOD_UNTRUSTED_LABEL` :647, trusted anti-priming frame outside the fence ("Do NOT use it as a reason to flag issues… Only flag issues you can justify from the code diff itself"); ''→'' keeps `.filter(Boolean)` arrays identical. `execute.ts:190-282` passes the dedicated param to all 5 runners; stackHints concat untouched |
| T4.3 Specialist map + defang | VERIFIED | `workflow.ts:133-141` — `SPECIALIST_CONTEXT_MAP`: scope-analysis/performance-review/coding-standards get the section; security-audit keeps `['staticContext']`, error-handling `[]`. Tests: `workflow.test.ts:731-756` (distribution + synthesis excluded), `:772-784` (per-specialist ≤ cap). Defang rows: `prompts.test.ts:576-584` (forged `</UNTRUSTED>` in file path), `:586-592` (forged `<UNTRUSTED` in symbol) |
| T4.4 Eval corpus | VERIFIED | `packages/core/test/fixtures/graph-context/` — 6 cases (fresh-exact-multi-file, not-exact-fresh, stale-7d, no-graph, symbol-sparse-python, oversize-refused) × {diff.patch, graph.json*, metadata.json, case.json, expected-context.json, expected-prompt-off.txt, expected-prompt-on.txt}. `graph-context-corpus.test.ts` — FROZEN_NOW 2026-11-10 :41, REGEN hook :155 — ran, **17 passed** |
| T5.1 Provider token split | VERIFIED | `generate-fn.ts:26-32` (`inputTokens?`/`outputTokens?`) + `:57-70` (total = in+out); `groq.ts:30-34`, `ollama.ts:32-36`, `explanation-generate-fn.ts:62-66` (from AI SDK v5 `usage`); `cli-bridge.ts:289-314` (`parseOpenCodeOutput` split), threaded `:473`, `:777`; `gateway.ts:71` stays `tokensUsed`-only (unmeasured). Providers suite green (155 per apply; full core suite confirms) |
| T5.2 Metadata aggregation | VERIFIED | `types.ts:580/:582` (`inputTokensUsed?`/`outputTokensUsed?`); `workflow.ts:391-392` (specialists) + `:416-417` (synthesis); `consensus.ts:391` (set only when a voice reported a split). Tests: `workflow.test.ts` "token split aggregation" describe (:796+), `consensus-review.test.ts:320` |
| T5.3 DB migration 0006 | VERIFIED | `packages/db/src/schema.ts:175-176` — nullable `input_tokens`/`output_tokens` (SPEC naming); `drizzle/0006_graph_token_split.sql` — exactly two `ADD COLUMN` statements, no backfill; `meta/_journal.json:51` chains after 0005. Tests: `schema.test.ts:44` (nullable, no default), `:54` (tokens_used authoritative); `queries.test.ts:675` (split persisted), `:704` (unmeasured → NULL, save succeeds). Optional integration harness (real PostgreSQL) reported 56 passed by implementer — not re-run by verifier (Docker-gated) |
| T5.4 Server persistence | VERIFIED | `apps/server/src/queues/review.ts:964-968` — null-safe spreads of `metadata.inputTokensUsed`/`outputTokensUsed` into `saveReview` columns. Tests: `review.token-split.test.ts:275` (full split persisted), `:294` (missing split → columns omitted, save succeeds) — ran with graph-path file, **6 passed** |
| T5.5 Cost footer split | VERIFIED | `cost-footer.ts:76-94` (`splitMeasured`), `:131-134` — "(estimated 70/30)" label ONLY when unmeasured; `format.ts:601-602` passes measured split. Tests: `cost-footer.test.ts:129` (measured, no marker), `:140` (unmeasured labeled), `:148` |
| T5.6 Changeset | VERIFIED | `.changeset/graph-context-retrieval.md` — minor: ghagga-core/ghagga/ghagga-db; `pnpm changeset status` OK (fixed group pulls ghagga-forge minor, action/dashboard patch). No docs/README delta — consistent with `enableCodeIntel` precedent |

**17/17 task items VERIFIED on main. No gaps.**

## 2. Scenario → test mapping

### core-engine (9 + 5)

| Scenario | Test / code path |
|---|---|
| Successful full pipeline review | `pipeline.test.ts:1086-1089` (every-step-ran coverage signal, PASSED) + `pipeline-golden.test.ts:1176` ("everything ON"); layers unchanged, goldens green |
| Static analysis failure does not block review | `pipeline.test.ts:1060` (static-analysis throw → failedSteps + PARTIAL, review continues) |
| Empty diff | `pipeline.test.ts:182`, `pipeline-golden.test.ts:1366` |
| Graph neighborhood assembled when a graph is loaded | `gather-graph-context.test.ts:310` (fresh-exact, filesCovered, dedicated field via `execute.ts:190-282`); corpus `fresh-exact-multi-file` (`graph-context-corpus.test.ts:186/:233`) |
| Graph neighborhood skipped when the setting is disabled | `gather-graph-context.test.ts:227` (no context, no state field, same result shape) |
| Fail-closed when the graph is missing | `gather-graph-context.test.ts:244` (auto) + `:252` (explicit); corpus `no-graph` |
| Fail-closed when the graph is stale beyond 7 days | `gather-graph-context.test.ts:291`; corpus `stale-7d` (`:252`) |
| Fail-closed when the graph is oversized | `gather-graph-context.test.ts:271` (loader refuses → no-graph); corpus `oversize-refused` |
| Symbol-sparse extractors degrade to imports/exports | `neighborhood-format.test.ts:54` + `:89`; corpus `symbol-sparse-python` (`:259`) |
| Diff exceeds model context | `utils/diff.test.ts:171-260` (`truncateDiff` describe) — pre-existing, unchanged; budget-neutrality test additionally pins byte-identical truncation on/off |
| Token usage tracking with AI SDK v5 | `generate-fn.test.ts` (12 tests), `groq`/`ollama`/`explanation-generate-fn`/`cli-bridge` provider tests (`providers/` suite green) |
| Neighborhood output is capped by its dedicated budget | `neighborhood-format.test.ts:134` (fits), `:142` (exactly-over), `:167` (cap-clamp), `:175` (default 1200), `:179` (≤ budget) |
| Neighborhood budget never shrinks the diff budget | `gather-graph-context.test.ts:365` (byte-identical 70/30 inputs + truncated diff) |
| Per-voice cap in a five-specialist fan-out | `workflow.test.ts:772-784` (each specialist ≤ cap); no-section case via `:731-756` (security/errors) + empty-string design; consensus stances capped by same shared cap (`consensus.ts:284`, test `:269-286`) |

### review-prompts (4)

| Scenario | Test |
|---|---|
| Neighborhood section injected with untrusted-content fencing | `prompts.test.ts:575-592` (fence + defang), `simple.test.ts:442-457` (section + pinned position), `fan-out-lenses.test.ts:1163-1169`, `consensus-review.test.ts:276-286`; anti-priming frame has no findings-encouraging directive (prompts.ts:663-671) |
| Prompts byte-identical when the setting is disabled | `simple.test.ts:431`, `workflow.test.ts:758`, `consensus-review.test.ts:269`, `fan-out-lenses.test.ts:1145` (all: absent === empty-string byte-identical); existing golden prompt suites pass unchanged |
| Prompts byte-identical when the graph degrades | `graph-context-corpus.test.ts:204` ("degraded cases: on === off" across 4 degraded cases) + `gather-graph-context.test.ts:244/:271/:291` (context '' → no section) |
| Per-specialist neighborhood subsets in workflow mode | `workflow.test.ts:731-756` (map-determined subsets; security/errors/minimal excluded; synthesis excluded); cap `:772-784`. Note: workflow specialists have no file partitioning — each reviews the full diff (`workflow.ts:207` "same for all specialists"), so each receiving specialist's subset IS the full changed-file set; "no entries → no section" holds via the empty-string path |

### server (4)

| Scenario | Test |
|---|---|
| Review with a complete token split is persisted | `review.token-split.test.ts:275` |
| Migration leaves existing rows and aggregates unchanged | `schema.test.ts:44/:54` + `queries.test.ts:675/:704` (unit, mock DB); migration-on-existing-rows verified by implementer via integration harness (56 passed, PostgreSQL/testcontainers) — verifier did not re-run (Docker-gated); aggregates sum only `tokens_used` (`queries.ts:825`) |
| Review without a token split still saves | `review.token-split.test.ts:294` + `queries.test.ts:704` |
| Aggregate token queries keep their semantics | `queries.ts:825` — `coalesce(sum(tokens_used),0)`; new columns only selected for display (`:712-713`), never summed into any aggregate (grep: no other token `sum(`) |

**18/18 scenarios have a corresponding test or explicit code path on main. No scenario gaps.**

## 3. Offline validation (run by verifier, 2026-11-10)

| Suite | Command | Result |
|---|---|---|
| ghagga-core | `pnpm --filter ghagga-core test` | **156 files, 4034 passed, 1 skipped, 0 failed** (matches apply-progress claim) |
| ghagga-db | `pnpm --filter ghagga-db test` | **5 files, 238 passed, 0 failed** (matches claim) |
| server graph tests | `pnpm --filter @ghagga/server exec vitest run src/queues/review.graph-path.test.ts src/queues/review.token-split.test.ts` | **6 passed** (4 + 2; matches claim) |
| CLI graph-context | `pnpm --filter ghagga exec vitest run src/commands/review-graph-context.test.ts` (run from `apps/cli`) | **7 passed** (matches claim) |
| corpus re-run | `vitest run src/graph-context-corpus.test.ts` | **17 passed** (8 static `it()` × describe.each expansion; matches claim) |
| Biome | `pnpm exec biome check .` | **exit 0, 0 errors, 104 warnings, 3 infos** (matches claim; warnings pre-existing per implementer's per-file audit) |

## 4. Deviations ruling (spec wins over design)

| # | Deviation | Ruling |
|---|---|---|
| D1 | Skip visibility narrowed: `disabled` and auto-no-graph skips are fully silent (no emit, no metadata) vs. the design's ladder table | **ACCEPTABLE — spec-mandated.** Core-engine scenario "skipped when the setting is disabled" requires "no neighborhood field MUST be set on the pipeline state" and "same result shape as before this change"; review-prompts requires byte-identical prompts. Silent skip is the only implementation that satisfies both. Spec wins over design |
| D2 | Golden snapshot updates for 5 loaded-graph tests | **ACCEPTABLE — spec-mandated.** Default-on assembly "whenever a dependency graph is loaded" (core-engine requirement) necessarily adds the event + metadata to those goldens. Review ledger (reliability lens) confirmed the 5 snapshot diffs are purely additive; all no-graph goldens byte-unchanged |
| D3 | Pipeline auto mode never loads the graph — it consumes the graph loaded by blast-radius or the explicit-true step-2.5b load | **ACCEPTABLE.** The spec's assembly scenario is conditioned on "a dependency graph loaded" (a given, not a pipeline obligation); the product surface (CLI) auto-resolves to explicit-true and loads (`review.ts:340`, `:374`), and the fail-closed missing-graph scenario demands silent skip. Preserves the single-load invariant; no loader call-count regression |
| D4 | Eval corpus gains a `case.json` harness config; oversize simulated at the loader seam | **ACCEPTABLE.** Test-fixture mechanics only; spec says nothing about fixture format. Observably identical to a real `MAX_GRAPH_SIZE_BYTES` refusal without a 20 MB committed fixture |
| D5 | (T3.4 note) `apps/cli` typecheck fails only against stale local `ghagga-core` dist types | **ACCEPTABLE — environment limitation, not a code defect.** CLI vitest compiles the same sources and passes (7/7); CI typechecks against fresh builds. No spec impact |

## 5. Review-ledger cross-check

`review-ledger.md` is complete: full-4R (diff >400 lines), zero BLOCKER/CRITICAL candidates (no refuter fan-out required by the contract), 7 findings all WARNING/SUGGESTION with status `info` (correct — they never block), fix-between-SDDs follow-ups logged (RES-001 NaN staleness fail-open, RES-002 unbounded GitHub loader fetch, REL-001 double-load, REA-001 hardcoded 7). Nothing open against this change.

## 6. Overall verdict

**PASS WITH NOTES**

- 17/17 task items implemented and verified on main with evidence.
- 18/18 spec scenarios mapped to concrete tests; no scenario gaps.
- All offline suites re-run by the verifier: green, counts match the implementer's claims exactly.
- All 5 documented deviations ruled acceptable; D1/D2 are spec-mandated, not implementer indulgence.
- Notes (non-blocking): (a) dispatch/apply-progress say "14 tasks" but tasks.md has 17 items — bookkeeping miscount, all verified; (b) DB integration harness (56 tests) is implementer-reported, not verifier-re-run (Docker-gated); (c) the two fix-between-SDDs candidates from the review ledger (RES-001, RES-002) remain open as backlog — correctly outside this change.
