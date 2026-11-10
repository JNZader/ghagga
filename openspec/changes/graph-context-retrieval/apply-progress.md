# Apply Progress: graph-context-retrieval

Branch: `feat/graph-context-retrieval` (from `main` @ 4f0ca2a).
All 14 tasks DONE. 6 commits (5 slices + 1 fixture-format fixup), each verified with its task's offline/model-free command before committing.

## Slice 1 — Neighbors API (commit 0708108)

- [x] T1.1 — `packages/core/src/graph/neighbors.test.ts`: table-driven synthetic graphs (17 tests): importers via imports + call edges, importees, exports cap 10/file, 10/file/direction + 30-file caps, truncated flag, cycles + self-edge exclusion, isTest propagation, missing files omitted, empty input.
  - Verify: `vitest run src/graph/neighbors.test.ts` → 17 passed.
- [x] T1.2 — `packages/core/src/graph/neighbors.ts`: `collectFileNeighborhoods(graph, files, opts?)` + `FileNeighborhood`; exported via graph barrel + core barrel (blast-radius precedent). Depth fixed at 1; reverse index reused from blast-radius.ts.
  - Files: `graph/neighbors.ts`, `graph/neighbors.test.ts`, `graph/index.ts`, `index.ts`.

## Slice 2 — Budgeted formatter (commit c27ce19)

- [x] T2.1 — `packages/core/src/graph/neighborhood-format.ts` (+test, 14 tests): `formatGraphNeighborhoodContext(neighborhoods, { maxTokens, freshness })`, default cap 1,200 tokens (DEFAULT_GRAPH_CONTEXT_MAX_TOKENS), CHARS_PER_TOKEN=4, join-aware budget (rendered bytes never exceed the cap), truncation notice with "X of Y file(s) shown". Freshness tiers: 'exact' renders symbols; 'file-level' renders paths+counts only under an "older commit" header with NO symbol names. Symbol-sparse files degrade to imports/exports, no placeholder text. Stats-carrying variant `formatGraphNeighborhood` exposes renderedFiles for metadata.
  - Verify: `vitest run src/graph/neighborhood-format.test.ts` → 14 passed.

## Slice 3 — Pipeline wiring + degradation + CLI mirror (commit 83c9eb4)

- [x] T3.1 — `packages/core/src/pipeline/gather-graph-context.test.ts`: parametrized degradation matrix (9 tests) over the full reviewPipeline: disabled (silent, no metadata — spec "same result shape"), no-graph auto (silent), no-graph explicit-true ('no-graph'), oversize/loader-refuses ('no-graph'), stale>7d ('stale-graph'), fresh-exact (filesCovered 1 of 2 — missing file omitted), not-exact-fresh (file-level tier), formatter throw (failedStep 'graph-context', review continues). Budget-neutrality row included (T3.3).
  - Verify: → 9 passed.
- [x] T3.2 — `graphNeighborhoodContext: ''` placeholder in state.ts (code-intel precedent); `enableGraphContext`/`graphContextMaxTokens` on ReviewSettings; `GraphContextMetadata` + `graphContextMetadata?` on ReviewMetadata; `gatherGraphContextSafe` in gather-safe.ts as the 4th leg of the step-5 Promise.all. Graph threading: `BlastRadiusOutcome.graphMetadata` new; prepare threads `loadedGraph`/`loadedGraphMetadata` into state; step 2.5b loads the graph ONLY on explicit `enableGraphContext: true` (auto never triggers a load — preserves every loader call-count assertion). The gather step NEVER calls the loader. Metadata attached in enrich.ts only when engaged (blast-radius pattern).
- [x] T3.3 — budget-neutrality test: same diff twice (auto-on fresh graph vs off) → byte-identical diff/staticContext/memoryContext/stackHints agent inputs. Existing goldens: all no-graph goldens byte-unchanged. DEVIATION (documented, spec-driven): the five loaded-graph golden tests (`blast-radius ON: graph available filters files`, `blast-radius ON: exceeded cap`, `call-chain + reverse-deps ON`, `everything ON`, `stale graph: emits staleness warning`) gained exactly one `graph-context` event + `graphContextMetadata` — the spec's default-on assembly REQUIRES this; snapshots updated and diff-reviewed (only additive lines in those 5 entries). Also: pipeline/golden test files' blast-radius mocks extended with a `buildReverseIndex` passthrough (mock was incomplete for the new neighbors consumer — no assertion changed).
  - Verify: `vitest run src/pipeline-golden.test.ts src/pipeline.test.ts src/pipeline/prepare-graph.test.ts src/pipeline/prepare-graph-narrow.test.ts src/pipeline/gather-graph-context.test.ts` → 157 passed.
- [x] T3.4 — CLI: `resolveGraphContextEnabled` (mirror of `resolveBlastRadiusEnabled`: `--no-graph-context` > `.ghagga.json` `enableGraphContext` > auto-on with `<repoPath>/.ghagga/graph.json`), `--no-graph-context` flag registered, `graphContextMaxTokens` config passthrough, loader wiring gate `enableBlastRadius || enableGraphContext` (graph-context-only runs load the graph). New `apps/cli/src/commands/review-graph-context.test.ts` (7 tests, temp-dir existsSync cases).
  - Verify: → 7 passed. Note: `apps/cli` typecheck fails ONLY against the stale local `ghagga-core` dist types (same documented class as apps/server; CI typechecks fresh).

## Slice 4 — Per-voice prompt section + eval corpus (commit 897d883)

- [x] T4.1 — `graphNeighborhoodContext?: string` param on simple/workflow/consensus/fan-out/diagnostic runners; absent/'' → byte-identical prompts (pinned per-runner); present → exactly one "Graph Neighborhood" section after the existing context sections, fenced via `wrapUntrusted(<UNTRUSTED label="graph neighborhood">)`. Tests added to simple.test.ts (3), fan-out-lenses.test.ts (2), consensus-review.test.ts (2).
- [x] T4.2 — framing helper `buildGraphNeighborhoodSection` in prompts.ts (anti-priming parity with buildMemoryContext; trusted frame OUTSIDE the fence: "Do NOT use it as a reason to flag issues… Only flag issues you can justify from the code diff itself"); execute.ts passes the dedicated param to all 5 runners — the stackHints concat at :185 UNTOUCHED. Prompt-mock test files (workflow/consensus-review) extended with the new helper (no assertion changed).
- [x] T4.3 — `SPECIALIST_CONTEXT_MAP` additions: scope-analysis/performance/coding-standards receive the section (security keeps static-only, errors minimal — pinned by test); each specialist's section ≤ the shared cap (single-capped-string design); every consensus stance + fan-out lens receives it wholesale. Defang rows in prompts.test.ts: forged `</UNTRUSTED>` in a file path and forged `<UNTRUSTED` in a symbol neutralized. Workflow test-file gotcha found+fixed: describes outside the main one must re-seed the shared parser mock (stale-object leak between rows).
  - Verify: `vitest run src/agents/simple.test.ts src/agents/consensus.test.ts src/agents/consensus-review.test.ts src/agents/fan-out-lenses.test.ts src/agents/prompts.test.ts src/agents/workflow.test.ts` → all green (417 across src/agents).
- [x] T4.4 — eval corpus `packages/core/test/fixtures/graph-context/<case>/` × 6 (fresh-exact-multi-file, not-exact-fresh, stale-7d, no-graph, symbol-sparse-python, oversize-refused) with `diff.patch`, `graph.json`, `metadata.json`, harness `case.json` (currentHead/enableGraphContext/simulateOversize), `expected-context.json`, `expected-prompt-off.txt`, `expected-prompt-on.txt`. `packages/core/src/graph-context-corpus.test.ts` (17 tests): frozen clock 2026-11-10 (fixtures never rot), asserts context bytes + metadata shape + prompt BYTES; degraded cases byte-identical on/off. Regen: `GHAGGA_REGEN_GRAPH_CONTEXT_CORPUS=1`. Model-free, no findings assertions (out-of-band quality run documented for the PR description).
  - Verify: → 17 passed.

## Slice 5 — Token split + persistence (commit d47b883)

- [x] T5.1 — `GenerateResult.inputTokens?/outputTokens?`; groq/ollama/explanation-generate-fn carry the AI SDK v5 usage split; cli-bridge threads the opencode `step_finish` split it previously discarded (adapter interface widened: `string | { text, tokens? }`; tokensUsed = input+output when measured, still 0 when not); gateway stays undefined (unmeasured by protocol). Provider tests extended (generate-fn.test.ts +5; groq/explanation expected objects updated for the new fields).
  - Verify: `vitest run src/providers/` → 155 passed.
- [x] T5.2 — `ReviewMetadata.inputTokensUsed?/outputTokensUsed?`; workflow (specialists + synthesis) and consensus (votes) aggregate both, set only when a voice reported a split. Tests: workflow.test.ts +2, consensus-review.test.ts +2.
  - Verify: → all green.
- [x] T5.3 — `packages/db/src/schema.ts`: nullable `reviews.input_tokens`/`output_tokens` (SPEC naming; design's `*_used` superseded per task). Hand-authored `drizzle/0006_graph_token_split.sql` + `meta/0006_snapshot.json` (diff vs 0005 verified = exactly the two columns + id/prevId chain) + `_journal.json` entry. No backfill. `saveReview` accepts `inputTokens`/`outputTokens`; `getReviewsByInstallationIds` select widened (typecheck-driven). Tests: schema.test.ts +2 (nullable, no default; tokens_used keeps default), queries.test.ts +2 (split persisted; absent → keys omitted, save succeeds).
  - Verify: `vitest run src/schema.test.ts src/queries.test.ts` → 202 passed. OPTIONAL HARNESS RUN (authorized): `vitest run --config vitest.integration.config.ts` → 56 passed on real PostgreSQL via testcontainers — the migration applies cleanly.
- [x] T5.4 — `apps/server/src/queues/review.ts` persists `metadata.inputTokensUsed/outputTokensUsed` into the new columns (null-safe spreads). New sibling `apps/server/src/queues/review.token-split.test.ts` (graph-path harness copy): full split persisted; missing split → columns omitted, save succeeds.
  - Verify: `vitest run src/queues/review.graph-path.test.ts src/queues/review.token-split.test.ts` → 6 passed.
- [x] T5.5 — cost footer: `ReviewCost.splitMeasured`; format.ts passes the measured split; footer always shows `in X / out Y`, labeled `(estimated 70/30)` ONLY when unmeasured. Tests: cost-footer.test.ts +3.
  - Verify: `vitest run src/cost-footer.test.ts src/format.test.ts` → 97 passed.
- [x] T5.6 — `.changeset/graph-context-retrieval.md` (minor: ghagga-core/ghagga/ghagga-db; fixed group pulls ghagga-forge). No docs update (verified enableCodeIntel precedent undocumented). `pnpm changeset status` OK.

## Final gates

- Full core suite: `pnpm --filter ghagga-core test` → **156 files, 4034 passed, 1 skipped, 0 failed**.
- DB unit suite: `pnpm --filter ghagga-db test` → **238 passed**.
- DB integration (testcontainers, optional harness): **56 passed**.
- Server: graph-path + token-split → **6 passed**.
- CLI: review-graph-context → **7 passed**.
- Typecheck (source-based): ghagga-core ✅, ghagga-db ✅, ghagga-types ✅ (apps/server and apps/cli blocked by stale local ghagga-core dist types only — documented, CI validates fresh).
- Biome: `pnpm exec biome check .` exits 0 (errors: 0; 104 pre-existing warnings, none added by this change — verified per-file).

## Design deviations (documented for review)

1. **Skip visibility narrowed vs. the design's ladder table**: 'disabled' and auto-no-graph skips are fully SILENT (no emit, no metadata). Rationale: the review-prompts spec requires byte-identical prompts AND "same result shape as before this change" for the disabled scenario, and the golden suite's byte-stability is only achievable if the normal no-graph state is invisible. Explicit `enableGraphContext: true` without a graph gets the visible 'no-graph' skip; stale-graph is always visible. The spec scenarios are fully satisfied (they never require skip metadata).
2. **Golden snapshot updates for 5 loaded-graph tests**: mandated by the spec's default-on-with-loaded-graph requirement; diffs reviewed line-by-line (additive event + metadata only).
3. **Pipeline auto mode never loads the graph** — it consumes the graph loaded by blast-radius (or the explicit-true step 2.5b load). This preserves every loader call-count assertion; a second load in gather would double-invoke loaders (documented invariant in BlastRadiusOutcome.graph).
4. **Eval corpus gains a `case.json` harness config** (currentHead/enableGraphContext/simulateOversize) — review-input properties that don't belong in GraphMetadata fixtures. Oversize is simulated at the loader seam (load→null), identical observable behavior to MAX_GRAPH_SIZE_BYTES refusal without a 20MB fixture.

## Blockers

None. All 14 tasks done.
