# Exploration: GHAGGA Graph-Guided Context Retrieval

## Exploration Scope

This exploration maps the terrain for feeding review voices (simple/workflow/consensus/fan-out) a graph-guided, focused context window — per changed file, its semantic neighborhood (importers/importees, key symbols) — instead of raw everything. Success metric: fewer input tokens per review with equal-or-better finding quality. No implementation, no live model/forge calls, no test suites or eval baselines were run.

## Current State

- **Pipeline context assembly.** Prepare parses/filters the diff (`packages/core/src/pipeline/prepare.ts:167-233`), runs graph steps 2.5/2.6 (`prepare.ts:235-258` → `packages/core/src/pipeline/prepare-graph.ts:74-187, 286-379`), then computes the 70/30 budget and truncates the diff (`prepare.ts:269-276`; ratios at `packages/core/src/utils/token-budget.ts:89-92`, `calculateTokenBudget` at `:140-150`, default window 128k at `:79`). Gather runs static analysis ∥ memory search ∥ code-intel as one `Promise.all` (`packages/core/src/pipeline/gather-context.ts:48-54`), prepends negative-examples + self-improve rules to memory (`:131-135`), then picks L0/L1/L2 fidelity for static and memory (`:137-146` → `packages/core/src/utils/context-levels.ts:285-334`; remaining budget after stack hints splits 60/40 static/memory). Code-intel context is budgeted separately (`packages/core/src/code-intel/context.ts:17`, default 1,500 tokens). Execute combines `stackHints + codeIntelContext + callChainContext` into one string passed as `stackHints` to every voice (`packages/core/src/pipeline/execute.ts:185`, dispatch `:188-299`); workflow specialists each receive subsets of context (`packages/core/src/agents/workflow.ts:108-117`). `--enhance` is step 5.5: an AI pass over static findings only (`execute.ts:54-94`) — it does not touch context. Enrich reuses the graph for exploitability (`packages/core/src/pipeline/enrich.ts:147`); finalize persists review observations to memory and sets `coverageComplete` (`packages/core/src/pipeline/finalize.ts:29-63`).
- **Memory (engram-style) injection.** `searchMemorySafe` (`packages/core/src/pipeline/gather-safe.ts:79-101`) → `searchMemoryForContext` builds a query from file-path segments (max 10 terms), fetches at most 3 observations (`packages/core/src/memory/search.ts:76-101, 128`), formatted and framed with anti-priming instructions (`packages/core/src/agents/prompts.ts:612-618`). Backends: SQLite FTS5 bm25 (`packages/core/src/memory/sqlite.ts:325-338`), Postgres ts_rank, or Engram REST (`packages/core/src/memory/engram-client.ts`). PageIndex is dashboard pagination over project memory (`packages/core/src/memory/pageindex/service.ts`), not in the review path.
- **The graph.** Extractors are REGEX-based, not tree-sitter, for 6 languages (TS/JS/Python/Go/Java/Rust — `packages/core/src/graph/schema.ts:19-25`, `packages/core/src/graph/extractors/typescript.ts:1-7`); Kotlin/C#/PHP are SCIP-only (`schema.ts:32`). SCIP builds add `symbolRanges` (`packages/core/src/graph/scip/builder.ts`). Node schema: `hash, language, imports[], importSymbols?, exports[], reExportedSymbols?, reExportsAll?, calls[{target,symbol}], isTest, symbolRange?` (`schema.ts:51-131`). Built by `ghagga index` (SCIP-first, regex fallback) writing `.ghagga/graph.json` + `metadata.json` with `lastIndexedCommit` (`apps/cli/src/commands/index-cmd.ts:60, 98-121`); incremental by content hash (`packages/core/src/graph/builder.ts`, `buildGraphIncremental`). Not built per review: the server fetches it from the `ghagga/graph` orphan branch (`apps/server/src/queues/review.ts:885-915` → `packages/forge/src/adapters/github/github-forge-adapter.ts:549-560` → `packages/core/src/graph/loader.ts:30-81`), wrapped in `PreloadedGraphLoader`; the CLI auto-enables blast-radius when `.ghagga/graph.json` exists (`apps/cli/src/commands/review.ts:1156-1171`). There is NO graph cache keyed by commit — only `lastIndexedCommit` equality (`isExactCommitFresh`, `packages/core/src/graph/narrow-symbols.ts:117-132`) and 7-day staleness (`schema.ts:405-411`).
- **Query surface today.** Public graph queries are `buildReverseIndex` + `computeBlastRadius` (BFS reverse traversal, default depth 3, cap 50 files — `packages/core/src/graph/blast-radius.ts:56-140`) and the subtractive `narrowBySymbols` (`narrow-symbols.ts`). Call-chain/reverse-deps helpers in step 2.6 are content-based, not graph-based. No generic `neighbors(file, depth)` or symbol-lookup API exists.
- **Dormant tree-sitter asset.** `packages/core/src/scope/` (web-tree-sitter WASM) extracts symbol definitions, maps diffs to affected symbols, and "builds focused review context" that "dramatically reduces tokens" (`packages/core/src/scope/index.ts:1-8`, `scope/context-builder.ts:9-13`) — exported from the core barrel (`packages/core/src/index.ts:523-540`) but consumed by nothing in the pipeline.
- **Search indexer.** `packages/core/src/search/indexer.ts` is an in-memory BM25 inverted index with snapshot serialization; its only consumer is the core barrel re-export (`packages/core/src/index.ts:650`). Nothing queries it during review.
- **Token/cost tracking (success-metric hook).** Providers sum `usage.inputTokens + usage.outputTokens` into `tokensUsed` (`packages/core/src/providers/groq.ts:30`, `ollama.ts:32`); result metadata carries it (`packages/core/src/types.ts:539`); workflow/consensus aggregate per specialist (`packages/core/src/agents/workflow.ts:264, 337`; `consensus.ts:313, 366`). Server persists `reviewResult.metadata.tokensUsed` into `reviews.tokens_used` (`apps/server/src/queues/review.ts:960, 1064`; `packages/db/src/schema.ts:167`; `saveReview` at `packages/db/src/queries.ts:354+`; aggregate sum at `:816`). `cost-footer.ts:68-94` HEURISTICALLY estimates a 70/30 input/output split — input tokens are not measured or persisted separately.
- **Existing coverage.** Golden suites pin pipeline degradation/parallelism (`packages/core/src/pipeline/*.test.ts`, `prepare-graph*.test.ts`), graph behavior (`packages/core/src/graph/*.test.ts`, incl. `symbol-context-golden.test.ts`), server graph path (`apps/server/src/queues/review.graph-path.test.ts`). No dedicated finding-quality eval corpus was found (fixtures exist under `packages/core/test/fixtures` but are parser/tool tests, not review-quality evals).

## Affected Areas

- `packages/core/src/pipeline/prepare-graph.ts` and a possible new gather-phase step — where neighborhood context would be produced.
- `packages/core/src/pipeline/execute.ts:185` and `packages/core/src/agents/prompts.ts` — the injection seam and prompt framing (untrusted-content fencing applies to any new context channel).
- `packages/core/src/graph/` — a neighbors/traverse query API over the existing reverse index.
- `packages/core/src/scope/` — candidate activation for symbol-body source extraction.
- `packages/core/src/utils/token-budget.ts` / `context-levels.ts` — budget interplay if context grows or diff shrinks.
- `packages/db/src/schema.ts` + `apps/server` — input/output token split for the success metric.
- Specs: `core-engine` (Review Pipeline Execution, Token Budget Management, Stack Detection), `review-prompts` (context framing, backward compatibility); no graph capability exists in `openspec/specs/` today.

## Approaches

| Approach | Pros | Cons | Effort |
| --- | --- | --- | --- |
| **A. Extend step 2.6 Symbol Impact into a fuller neighborhood block** | Smallest change; reuses loaded graph, degrade patterns, and existing prompt channel | Still advisory text riding `callChainContext`; no token reduction on the diff side; 50-file cap semantics | Low |
| **B. New budgeted graph-context step + dedicated prompt section (opt-in)** | Explicit per-file neighborhood (importers/importees/key symbols) with its own token budget (code-intel precedent); measurable; reversible via setting | New pipeline step, new state field, per-voice prompt changes; must satisfy untrusted-fencing rules | Medium |
| **C. Graph+scope-synthesized context window replacing the raw truncated diff** | Largest token win (scoped symbol bodies instead of whole diff); activates dormant `scope/` | Highest regression risk for finding quality; depends on `fileReader` availability in server mode; exact-commit freshness becomes load-bearing | High |

### Recommended Reversible Slice Sequence

| Slice | Purpose | Estimated authored change |
| --- | --- | --- |
| 1. Pure neighborhood query API over `DependencyGraph` (neighbors, imported-symbols) | Testable traversal without pipeline wiring | 150-250 lines |
| 2. Budgeted formatter (code-intel precedent) | Cap neighborhood output tokens | 150-250 lines |
| 3. Opt-in pipeline wiring + degradation | Feature-flagged, fail-closed integration | 200-350 lines |
| 4. Per-voice prompt section with untrusted fencing | Stable, spec-governed injection | 150-300 lines |
| 5. Input/output token split + persisted metric | Make the success metric measurable | 150-250 lines |
| 6. Optional `scope/` activation for symbol bodies | Path to Approach C, isolated | 250-400 lines |

## Recommendation

Choose **Approach B** first: a pure graph query API plus a budgeted, opt-in neighborhood context step with its own prompt section, preserving the raw diff. Treat diff replacement (Approach C) as a later, separately evaluated slice gated on the token metric and quality guardrails from slice 5. Reuse the code-intel shape (`enableCodeIntel`/`codeIntelMaxTokens`, `gather-safe.ts` degradation) rather than inventing new plumbing.

## Constraints and Coupling

- Graph context reaches voices only through state fields assembled in `execute.ts`; every new channel must respect the untrusted-content fencing contract (`prompts.ts:300-530`).
- Symbol-precise claims must fail closed exactly like `narrowBySymbols` (three pillars incl. `isExactCommitFresh`); file-level neighborhoods may tolerate a 7-day-stale graph.
- Server reviews depend on the externally published `ghagga/graph` branch; there is no per-review build path and `MAX_GRAPH_SIZE_BYTES` (20MB) caps the graph.
- Extractor symbol density is uneven: `importSymbols` dense for TS/JS/Java (regex) and TS/JS/Rust/Java (SCIP); absent for Python/Rust (regex); `symbolRanges` SCIP-only (`schema.ts:73-81, 120-130`).
- Fan-out/consensus multiply context tokens per specialist — neighborhood budgets must be per-voice aware (`workflow.ts:108-117` subsets).
- The success metric needs an input-token measurement that does not currently exist in the schema.

## Risks

- **Graph freshness:** big PRs reviewed against an orphan-branch graph indexed at a different commit; only narrowing is exact-commit-gated today.
- **Extractor coverage:** 6 regex languages with uneven symbol fidelity; 3 SCIP-only languages require toolchains in the indexing environment.
- **Cost locus:** building the graph per review is prohibitive; the change should assume published-graph reads and degrade to no-neighborhood.
- **Prompt-format stability:** voices' prompts are golden-tested; a new section must be additive and byte-stable when the feature is off.
- **Quality regression:** compressing context risks missed cross-file findings; no eval corpus exists yet to prove equal-or-better.
- **Metric gap:** input tokens are not separately tracked; the headline success metric is currently unmeasurable without schema work.
- **Unmeasured baseline:** no tests, model calls, or token baselines were run during this exploration.

## Open questions for proposal

1. Neighborhood context as a budgeted sidecar (Approach B) or replacement of the raw truncated diff (Approach C) — which is the first deliverable?
2. Inject via the existing `combinedStackHints` channel or a new dedicated context field with its own prompt section per voice?
3. Should neighborhood selection be file-level (always available, staleness-tolerant) or symbol-precise and fail-closed on `builtVia` + `isExactCommitFresh`?
4. Keep the `ghagga/graph` orphan-branch publishing model as the only graph source, or add a lazy per-review incremental build when the graph is missing/stale?
5. Activate the dormant tree-sitter `scope/` module for symbol-body extraction now, or defer it behind the pure-graph slices?
6. Add an input/output token split to `ReviewMetadata` and the `reviews` schema as part of this change, or measure the success metric out-of-band?
7. Which guardrail defines "equal-or-better finding quality" — extend the golden prompt suites, or author a new eval-fixture corpus first?
8. Spec placement: a new graph-context capability, or deltas to `core-engine` (Token Budget Management, Review Pipeline Execution) and `review-prompts` only?
