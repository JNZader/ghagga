# Design: Hybrid Ranking of Graph-Neighborhood Context (Phase 1 — Lexical)

## Technical Approach

A pure, synchronous lexical ranker (`graph/neighborhood-rank.ts`) inserted at the gather seam between `collectFileNeighborhoods` and `formatGraphNeighborhood`. Deterministic by construction: fixed integer weights, unique-token set intersections, stable sort (ties keep diff order). No settings surface, no prompt-format change, no budget change — the 1,200-token first-fit cut (`neighborhood-format.ts:68-106`) stays as-is; only the ORDER it cuts over changes.

## Architecture Decisions

| # | Decision | Choice and rationale (evidence) | Rejected alternative |
| --- | --- | --- | --- |
| 1 | Score formula | See "Score Formula" below. Weights 3/5/2/1 (integer scale): symbol hit strongest (cross-file export mention = the anti-echo differentiator), path hit middle (near-constant baseline — every changed file's path is in its own diff header), importSymbol hit weak (language-skewed: TS/JS/Java dense, Python/Rust absent, `schema.ts:73-81`), hub bonus = 1 binary point (`importers.length >= 10` ⟺ raw degree ≥ 10 since importers cap at `MAX_NEIGHBORS_PER_FILE`, `neighbors.ts:60`, `:105`). Max structural influence is 1 < any symbol hit (5) → structure breaks ties, never dominates lexical. | Graded degree (0-10 points: 9 importers would outrank a symbol hit — structure dominates, echo chamber returns); changed-line count component (noisy: generated files, renames; subsumed by changed-symbol count inside w2, which is exactly the spec's "prioritize files with the most changes" hook). |
| 2 | Tokenization | Reuse `tokenize` from `search/indexer.ts:62-68` (the exploration cites `searcher.ts`, but the export lives in indexer; `searcher.ts:20` imports it the same way). Pure/sync/deterministic, stop-word filtered, and its only import is type-only (`indexer.ts:9`) — zero runtime deps. Paths are split on `/` and `.` before tokenizing (tokenize keeps `-`/`_` intact, matching how segments appear in diff headers). No camelCase splitting: identifiers match verbatim, which is the intended exact-name semantic. | A lighter local split (third tokenizer to maintain, stop-word drift between ranker and search); camel-splitting (sub-token matches inflate scores and blur the exact-name signal). |
| 3 | Changed-symbol signal | Regex-only `extractChangedSymbolsFromDiff` (`call-chain.ts:184`): sync, zero cost, returns `Map<file, Set<symbol>>` in exactly the shape w2 needs; map keys come from `+++ b/` lines — the same path space as `fileList` (both derive from `parseUnifiedDiff`). Known lower-bound (DEPRECATED note, `call-chain.ts:176-183`): body-only changes are invisible → under-count degrades to fewer w2 points, never wrong output (ranking is order-only). | SCIP `computeChangedSymbolsComplete` (accuracy gain matters for Symbol Impact content, not tie-break scoring; heavier and bound to `symbolRanges` presence — pointless cost for an ordering hint). |
| 4 | Kill-switch | None. The ranker is a reorder inside the existing gather try-block; entry rendering, budget math, fencing untouched. `enableGraphContext === false` already kills the whole sidecar including ranking (`gather-safe.ts:281`). Rollback = revert (proposal.md:62-64: no setting, no schema, no persisted artifacts). | A `graphContextRanking` setting (settings surface + spec churn for a purely internal reorder; rollback parity already exists via revert). |
| 5 | Integration point | `gather-safe.ts` between `:321` (collect) and `:323` (format), inside the existing try → a ranker throw lands in the `:338-350` catch (failedStep, review continues — no new catch code). `input.diff` (`types.ts:90`) is already a param of `gatherGraphContextSafe` → no signature change. `rankingMode: 'lexical'` added to the rendered-path metadata at `:336`; skipped paths (`:294`, `:311`) omit it — `stale-7d`/`no-graph` fixtures pin FULL metadata, adding a field there would break degradation goldens for zero value (absent ≙ did not run). Both freshness tiers rank (order-only at file-level; fail-closed rendering unaffected). | Ranking outside the try (a second failure contract to maintain); ranking in the formatter (couples scoring to rendering, untestable in isolation). |
| 6 | Budget-cut fixture | New corpus case `test/fixtures/graph-context/budget-cut-ranked/` (same 7-file shape as `fresh-exact-multi-file`). 12 graph nodes engineered so exact-tier entries total ~7,000 chars > 4,800 (1,200 × `CHARS_PER_TOKEN=4`, `neighborhood-format.ts:30`): each entry carries 10 importers + 10 importees + 10 exports (~550-650 chars/entry) → the `break` at `neighborhood-format.ts:90` fires around entry 8; ~4-5 dropped. Cast by intent: `src/ranker.ts` (hero — diff body in ANOTHER file's hunk calls its exports → high symbolHits; LAST in diff order), `src/hub.ts` (≥10 importers, zero lexical), `src/filler-a..i.ts` (filler-a FIRST in diff order, zero lexical, long entries). Pins: filler-a DROPPED + ranker.ts SURVIVES (proves non-positional), rendered order = score-desc with stable ties, truncation notice counts exact, rendered chars ≤ 4,800. Readability: fillers share one uniform node shape (copy + path substitution); assertions target names, not byte offsets; bytes regen via `GHAGGA_REGEN_GRAPH_CONTEXT_CORPUS=1` (`graph-context-corpus.test.ts:155`). | Shrinking `graphContextMaxTokens` in case.json to force overflow with 4 files (the design question pins the DEFAULT 1,200 budget; a shrunken cap wouldn't prove the default-config behavior). |

## Score Formula (exact)

```
diffTokens  = Set( tokenize(input.diff) )                          // indexer.ts tokenize
changedSyms = extractChangedSymbolsFromDiff(diffText)              // Map<file, Set<symbol>>

pathTokens(n)      = tokens of segments(n.file) ∪ segments(each importer) ∪ segments(each importee)
                     // segments: split on '/' and '.', then tokenize
symPool(n)         = changedSyms.get(n.file) ∪ n.exportedSymbols
impSymTokens(n)    = ∪ values( graph.nodes[n.file].importSymbols )  // graph optional → without it w3 = 0

score(n) = 3 · |pathTokens(n) ∩ diffTokens|
         + 5 · |symPool(n) ∩ diffTokens|
         + 2 · |impSymTokens(n) ∩ diffTokens|
         + (n.importers.length >= 10 ? 1 : 0)                      // hub bonus

order: sort by score DESC, stable sort → ties keep collect (= diff) order
```

All intersections over UNIQUE tokens → repetition cannot inflate a score; token sets are never emitted, so Set iteration order cannot leak into output. `|changedSyms.get(n.file)|` counts this file's touched symbols → files with more changes score higher inside w2 (spec's latent clause, answered: NO explicit changed-line-count component needed).

## Data Flow

```
input.diff ──tokenize──→ diffTokens (Set)
             │
             └─extractChangedSymbolsFromDiff──→ changedSyms (Map)      [call-chain.ts:184]
                                                        │
collectFileNeighborhoods(graph, fileList)                │             [gather-safe.ts:321]
        │                                               │
        ▼                                               ▼
rankNeighborhoods(neighborhoods, input.diff, graph)   ← NEW (between :321 and :323)
  3·pathHits + 5·symbolHits + 2·importSymbolHits + hubBonus; stable sort
        │
        ▼
formatGraphNeighborhood(ranked, { maxTokens, freshness })             [:323 — unchanged first-fit]
        │
        ▼
metadata { filesCovered, truncatedFiles, freshness, rankingMode: 'lexical' }   [:336]
  throw anywhere above → existing :338-350 catch → failedStep, context ''
```

## Interfaces / Contracts

- `rankNeighborhoods(neighborhoods: FileNeighborhood[], diffText: string, graph?: DependencyGraph): FileNeighborhood[]` — pure, synchronous, no I/O, never mutates input; returns a NEW array (same references), score-desc, stable. `graph` optional: without it the importSymbol term scores 0.
- `GraphContextMetadata.rankingMode?: 'lexical'` (`types.ts:550-559`) — present only on the rendered path. `'hybrid'`/`'none'` reserved for Phase 2 / observability later; NOT added now (skip fixtures pin full metadata).
- Spec delta (core-engine: Token Budget Management, MODIFIED): truncation priority = deterministic lexical+structural ranking, ties by diff order — replacing positional first-fit.

## Proposal Open Questions — Answers

1. **Sequencing**: archive `graph-context-retrieval` FIRST (mechanical pre-task, no code) so the MODIFIED requirement exists in `openspec/specs/` and validates normally. Fallback only if archiving is blocked: quote the merged delta text and accept validation friction.
2. **Changed symbols**: regex-only for v1 (Decision 3).
3. **"Most changes" clause**: satisfied by the changed-symbol count inside w2 — no explicit changed-line component (Decision 1).
4. **Phase 2 flag**: none — the embedding boost gates on `input.embeddingProvider` presence, mirroring `rankFindings`' guard (`ranking/index.ts:69`, `:98-101` catch → original order); `rankingMode` gains `'hybrid'`. Decided now, implemented never in this slice.
5. **Kill-switch**: no setting (Decision 4).

## File Changes

| Files | Action |
| --- | --- |
| `packages/core/src/graph/neighborhood-rank.ts` (+unit test) | NEW: pure lexical ranker |
| `packages/core/src/pipeline/gather-safe.ts` | 2-line seam (`:321`-`:323`) + `rankingMode` at `:336` |
| `packages/core/src/types.ts` | `rankingMode?: 'lexical'` on `GraphContextMetadata` |
| `packages/core/test/fixtures/graph-context/budget-cut-ranked/*` | NEW corpus case (Decision 6) |
| Corpus/prompt goldens | Regen fresh-graph cases ONLY (`fresh-exact-multi-file`, `not-exact-fresh` gain `rankingMode` + possible order shift); degradation cases byte-identical |
| `openspec/changes/context-hybrid-ranking/specs/core-engine/spec.md` | MODIFIED delta (after archive pre-task) |

## Slices: Size and Risk

| Slice | Lines | Risk | Notes |
| --- | --- | --- | --- |
| 0. Archive graph-context-retrieval → specs sync | ~0 (mechanical) | Low | Pre-task; unblocks spec validation |
| 1. Ranker + integration + metadata + unit/gather tests | 200-300 | Low | Pure function; 2-line seam |
| 2. Corpus budget-cut fixture + golden regen | 150-250 | Medium | Fixture math must provably overflow; golden churn review |
| 3. Spec delta | 40-80 | Low | Quotes base text post-archive |

## Testing Strategy

- **Unit (`neighborhood-rank.test.ts`)**: table-driven — empty diff; empty neighborhoods; echo floor (every changed file gets its path baseline); neighbor-path hit from diff BODY; export-mention hit from another file's hunk (cross-file, the anti-echo case); importSymbol hit; language skew (no `importSymbols` → w3 = 0); hub bonus tie-break; stability (equal scores keep input order); path-space mismatch (file absent from `changedSyms`).
- **Gather (`gather-graph-context.test.ts`)**: ranks at BOTH tiers; skip paths emit no `rankingMode` (metadata byte-identical to today); ranker throw → `failedStep` + `context: ''` (module-mock `rankNeighborhoods` to throw).
- **Corpus**: `budget-cut-ranked` pins survivors + order + truncation counts; regen of `fresh-exact-multi-file`/`not-exact-fresh`; `stale-7d`/`no-graph`/`oversize-refused` untouched bytes.
- **Prompt goldens**: only fresh-graph cases regenerate; off-case bytes identical.

## Migration / Rollout

No migration. Ranker ships default-on for every sidecar render. Rollback: revert slice commits — goldens regenerate to positional baseline; stored reviews unaffected (`rankingMode` optional).

## Open Questions

None.
