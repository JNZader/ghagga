# Exploration: Context Hybrid Ranking (zvec-grep-inspired)

## Exploration Scope

How the graph-neighborhood context (merged #471) selects files/symbols for its 1,200-token budget today, and where a diff-relevance ranking (zvec-grep-style hybrid) could slot in. Read-only map of selection, signals, embedding surface, spec deltas, risks.

## Current State

- **Selection is purely structural + input-ordered.** `collectFileNeighborhoods` (`packages/core/src/graph/neighbors.ts:83-134`) takes changed files in **diff order** (`fileList` = `filteredFiles.map(f=>f.path)`, `pipeline/prepare.ts:233`; blast-radius filter preserves order), caps at 10/direction/file (`neighbors.ts:60`, `MAX_NEIGHBORS_PER_FILE`), 30 files total (`:63`), 10 exported symbols (`:66`). Per-direction slices take the FIRST N in graph iteration order (`:105-107`).
- **Budget cut = first-fit in input order.** `formatGraphNeighborhood` (`packages/core/src/graph/neighborhood-format.ts:68-106`) accumulates entries at CHARS_PER_TOKEN=4 (`:30`), `break`s at first overflow (`:90`) — whoever comes earlier in diff order survives; DEFAULT_GRAPH_CONTEXT_MAX_TOKENS=1200 (`:27`). Dropped count → `truncatedFiles` (`gather-safe.ts:327`).
- **Assembly + staleness ladder**: `gatherGraphContextSafe` (`pipeline/gather-safe.ts:272-351`): disabled→silent (`:281`), no-graph→silent/visible (`:289-298`), stale>7d→skip (`:304-313`), not exact-fresh→file-level tier (`:317-319`), exact→symbols; collect(`:321`)→format(`:323`); throw→failedStep (`:338`). Runs inside the step-5 `Promise.all` quartet (`pipeline/gather-context.ts:53-68`); result passed verbatim to every voice runner (`pipeline/execute.ts:190-282`) and fenced once in `agents/prompts.ts:661-663`.

## Affected Areas

- `graph/neighbors.ts`, `graph/neighborhood-format.ts` (contract: order-in = render order), `pipeline/gather-safe.ts:321-327` (insertion point), `types.ts:550-559` (`GraphContextMetadata` — could carry ranking mode).
- Signals: `diff/parse.ts:222` (`parseUnifiedDiff`), `graph/call-chain.ts:184` (`extractChangedSymbolsFromDiff`, regex declaration-level), `graph/changed-symbols.ts` (SCIP `symbolRanges`, innermost-symbol per changed line), `graph/schema.ts:62-121` (`GraphNode.imports/importSymbols/exports/calls/isTest`), `search/searcher.ts` (BM25 + `tokenize` precedent).
- Embedding surface: `embed.ts` (provider registry `:87-124`, `embedBatch` `:164`, `cosineSimilarity` `:417`, `FakeEmbeddingProvider` `:364`); `ranking/index.ts:65-102` (`rankFindings` — the shape to mirror); wired via `input.embeddingProvider` (`types.ts:190`), constructed in `apps/server/src/queues/review.ts:873`, `apps/cli/src/lib/embedding.ts:48`, `apps/action/src/index.ts:124` (default `none`).
- Specs: `openspec/changes/graph-context-retrieval/specs/core-engine/spec.md` (MODIFIED "Review Pipeline Execution" `:8-16`, "Token Budget Management" `:85-117` — whose budget-truncation scenario `:117` already says "prioritize files with the most changes") and `specs/review-prompts/spec.md` (ADDED "Graph Neighborhood Prompt Section"). **Note: neither requirement is in `openspec/specs/*/spec.md` yet; the change dir is un-archived.**

## Approaches

| # | Approach | Determinism | Cost | Signal quality | Testability |
|---|---|---|---|---|---|
| A | Deterministic lexical: score = diff tokens ∩ (path segments, changed symbols, importSymbols/exports) + structural tiebreak (degree), stable sort | Full | Zero (pure/sync, fits neighbors.ts contract) | Good for exact-name matches; misses synonyms | Corpus/golden-pin-able |
| B | Embedding rerank: embed diff summary + per-file neighborhood text, cosine — mirrors `rankFindings` (fallback to original order) | None across providers | 1 embedBatch call/review | Best semantic recall | Only via FakeEmbeddingProvider |
| C | Hybrid (zvec-grep shape): A always + B as additive boost when `input.embeddingProvider` present | A-tier when no provider | A + optional batch | Best combined (their Recall@N evidence) | A pinned; B smoke-tested |
| D | Structural-only priority (importer degree / changed-line count) | Full | Zero | No diff relevance; weakest | Easy |

## Recommendation

**C, phased.** Land A first: pure module `graph/neighborhood-rank.ts`, `rankNeighborhoods(neighborhoods, diffText, graph?) => FileNeighborhood[]` (stable sort; ties keep diff order), invoked in `gather-safe.ts` between `:321` and `:323`. Then B as opt-in boost behind provider presence, copying `rankFindings`' contract verbatim (`ranking/index.ts:69` guard, `:98-101` catch→original order). A alone already satisfies the spec's latent "prioritize files with the most changes" hook (`core-engine` delta `:117`).

## Constraints

- `collectFileNeighborhoods` is documented pure/synchronous (`neighbors.ts:81`) — lexical scoring must stay sync; embedding rerank belongs in the async gather step only.
- Byte-identical-when-disabled/degraded contracts (review-prompts delta `:24-36`; `pipeline/gather-graph-context.test.ts` budget-neutrality) — ranking must never fire when the ladder skips.
- Budget never shrinks the diff (70/30 split untouched — ranking only reorders the sidecar).
- Fail-closed: a ranking throw must land in the existing `:338-350` catch, not fail the review.

## Risks

- **Non-determinism**: embedding variance breaks the 6-case corpus pinned bytes (`graph-context-corpus.test.ts`, fixtures `test/fixtures/graph-context/`, REGEN env) and prompt goldens (`pipeline-golden.test.ts`, `__snapshots__`). Mitigation: default = lexical; embedding only reorders, never renders.
- **Stale-graph interaction**: at file-level tier no symbol claims render — ranking on stale `importSymbols` only changes ORDER, so fail-closed semantics hold; but it can promote relationships that no longer exist (mitigate: cap embedding boost magnitude).
- **Echo chamber**: pure diff-token overlap favors files the diff already names; the novel signal is structural (importers NOT in the diff) — hybrid score must retain the structural component.
- **Spec base state**: graph-context requirements absent from `openspec/specs/` — new deltas must quote the merged text and may need to sequence after archiving.

## Open Questions

1. Rank at both freshness tiers or exact-only?
2. Also rank WITHIN a file's 10-per-direction slots (which importers get listed), or only file order?
3. Flag for embedding tier — reuse `features.semanticRanking` auto-enable pattern or new `graphContextRanking`?
4. Changed symbols: SCIP `computeChangedSymbolsComplete` with regex fallback, or regex-only for simplicity?
5. Expose `rankingMode: 'lexical'|'hybrid'|'none'` in `GraphContextMetadata`?
6. Tie-break = original diff order everywhere (byte-stability)?
7. Does this change chain on the un-archived `graph-context-retrieval` change or wait for archive→spec sync?
8. Offline eval: extend the corpus fixtures with a "budget actually cuts" case that pins WHICH files survive?
