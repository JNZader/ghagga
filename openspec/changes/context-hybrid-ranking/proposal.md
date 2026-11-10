# Proposal: Hybrid Ranking of Graph-Neighborhood Context

## Intent

When the graph-neighborhood sidecar overflows its 1,200-token budget, `formatGraphNeighborhood` cuts first-fit in input order: the survivors are whoever appeared earliest in the diff, not whoever is most relevant to the change (`neighborhood-format.ts:68-106`, `break` at `:90`). The merged spec already demands better — the budget-truncation scenario requires truncation to "prioritize files with the most changes" (`graph-context-retrieval` core-engine delta `:112-117`) — but the implementation honors no priority at all; survival is positional. This change inserts a deterministic lexical ranking between neighborhood collection and formatting so the budget keeps the most relevant neighborhoods: files whose paths, symbols, and imports overlap the diff tokens, with a structural (importer-degree) component so pure diff-name echo doesn't win. Phase 2 adds an embedding boost when `input.embeddingProvider` is present; it is flagged as a separate slice, not in v1.

## Scope Decision

**Approach C, phased.** Phase 1 (this change) is pure lexical: a synchronous, pure ranker — full determinism, zero cost, corpus-pinneable, and it fits the documented pure/sync `collectFileNeighborhoods` contract (`neighbors.ts:81`). Phase 2 (separate slice, may defer) mirrors `rankFindings`' fallback contract verbatim (`ranking/index.ts:69` guard, `:98-101` catch → original order) as an additive boost behind provider presence. Lexical ranking is **default ON**: it is a reorder inside the existing gather step — no prompt-format change, no new tokens, no settings surface — and it fires at both freshness tiers (exact and file-level), where it changes ORDER only, leaving the staleness ladder's fail-closed claims untouched.

## Scope

### In Scope

- Pure sync ranker `graph/neighborhood-rank.ts`: `rankNeighborhoods(neighborhoods, diffText, graph?) => FileNeighborhood[]` — lexical score (diff tokens ∩ path segments / changed symbols / `importSymbols` / `exports`) + structural degree component; stable sort, ties keep diff order.
- Integration in `gatherGraphContextSafe` between collect (`:321`) and format (`:323`), both freshness tiers; a ranking throw lands in the existing `:338-350` catch (failedStep), never failing the review.
- `GraphContextMetadata.rankingMode: 'lexical' | 'none'` for observability.
- Corpus extension: a "budget actually cuts" fixture where the 1,200-token budget provably truncates, pinning WHICH files survive.
- Spec delta (core-engine: Token Budget Management) replacing positional first-fit with a deterministic priority rule.

### Out of Scope

- Embedding boost in the v1 slice (Phase 2, flagged; provider-presence gated).
- Per-direction WITHIN-file slot ranking (which importers fill a file's 10-per-direction cap stays graph-iteration order).
- New graph capabilities, traversal, or extractor changes.
- Prompt-format changes (entry rendering unchanged — only entry ORDER shifts), token-budget changes (70/30 split and `graphContextMaxTokens` cap untouched), settings or schema changes.

## Capabilities

### Modified Capabilities

- `core-engine`: Token Budget Management — the truncation priority rule becomes a deterministic lexical+structural ranking instead of positional first-fit. The delta must quote the merged change text; the requirement is not yet in `openspec/specs/` (see Open Design Questions).

## Approach

Slices land in dependency order, each independently testable:

1. **Lexical ranker + integration + metadata** — `neighborhood-rank.ts` (pure, sync) wired at the gather seam, `rankingMode` in metadata, unit tests, regenerated corpus/prompt goldens for fresh-graph cases.
2. **Corpus budget-cut fixture** — a multi-file fixture whose neighborhoods exceed 1,200 tokens, pinning the surviving order under lexical ranking (highest-scoring file survives; an earlier-in-diff, low-scoring file is dropped).

## Affected Areas

| Area             | Impact   | Description                                                                                     |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `packages/core`  | Modified | `graph/neighborhood-rank.ts` (new), `pipeline/gather-safe.ts` ordering seam, `types.ts` metadata |
| Test suites      | Modified | Corpus fixtures + goldens (`graph-context-corpus.test.ts`, `test/fixtures/graph-context/`), `gather-graph-context.test.ts`, prompt goldens (fresh-graph cases only) |

No `apps/*` or `packages/db` impact: no setting, no schema, no provider wiring.

Rough size: 250-400 authored lines across the two slices.

## Risks

| Risk                                                                | Mitigation                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Non-determinism breaking corpus/golden pinning                      | Phase 1 is lexical only: pure, sync, stable sort, ties keep diff order; the non-deterministic embedding part is a separate deferred slice |
| Echo chamber — diff-token overlap favors files the diff already names | Structural (importer-degree) component retained in the score; importers NOT in the diff can win ties                              |
| Stale graph promoting relationships that no longer exist             | Ranking changes ORDER only at both tiers; what renders and what is asserted (fail-closed claims) unchanged                        |
| Spec base state — graph-context requirements absent from `openspec/specs/` | Delta quotes merged text verbatim; sequencing decided before design (Open Design Question 1)                                 |
| Legitimate golden churn on fresh-graph cases                        | Regeneration via existing REGEN env, pinned within the slice; degradation cases stay byte-identical                               |

## Rollback Plan

Revert the slice commits. The ranker is a pure reorder at a single seam — no setting, no schema, no persisted artifacts — so a revert restores positional first-fit and goldens regenerate to baseline. Stored reviews remain valid (`rankingMode` is an optional metadata field).

## Dependencies

- Merged `graph-context-retrieval` slices: neighbors API, budgeted formatter, gather-safe ladder, prompt section — extended only at the ordering seam, never altered structurally.
- Existing signals reused: `parseUnifiedDiff`, `extractChangedSymbolsFromDiff` (+ SCIP changed-symbols), `GraphNode.imports/importSymbols/exports`, BM25 `tokenize` precedent (`search/searcher.ts`).
- No new libraries; no embedding-provider or `apps/*` changes.

## Success Criteria

- [ ] Corpus goldens pin the ranked order deterministically: identical bytes across runs, ties resolved by diff order.
- [ ] The budget-cut fixture proves survivors are relevance-ranked, not diff-ordered: the highest-scoring file survives, an earlier-in-diff but low-scoring file is dropped.
- [ ] Prompts are byte-identical when the graph is absent, stale beyond tolerance, or the step is disabled (existing degradation goldens untouched).
- [ ] A ranking throw lands in the existing failedStep catch; the review completes (fail-closed preserved).
- [ ] Sidecar token usage is unchanged: reorder only; `graphContextMaxTokens` cap and the 70/30 diff split untouched.
- [ ] `GraphContextMetadata.rankingMode` reports `'lexical'` when the ranker ran and `'none'` when it did not.

## Open Design Questions

1. Sequencing: delta against the un-archived `graph-context-retrieval` change (quoting merged text) or gate on archive → `openspec/specs/` sync first?
2. Changed-symbol signal: SCIP `computeChangedSymbolsComplete` with regex fallback, or regex-only (`extractChangedSymbolsFromDiff`) for simplicity?
3. Does lexical relevance satisfy the spec's "prioritize files with the most changes" clause, or must changed-line count be an explicit score component?
4. Phase 2 seam: reuse the `features.semanticRanking` auto-enable pattern or a new `graphContextRanking` flag — decide now even if the slice defers?
5. Kill-switch: lexical ranking unconditional whenever the sidecar renders, or a setting for rollback parity with other pipeline features?
