# Design: Graph-Guided Context Retrieval

## Technical Approach

Approach B: a pure neighborhood query over the loaded `DependencyGraph`, a budgeted formatter (code-intel precedent), an opt-out gather-step that assembles a fenced per-file neighborhood section, and a measured input/output token split so the success metric exists. The raw diff pipeline is untouched; rollback is one setting.

## Architecture Decisions

| # | Decision | Choice and rationale (evidence) | Rejected alternative |
| --- | --- | --- | --- |
| 1 | Injection channel | New `PipelineStateBase.graphNeighborhoodContext: string` (state.ts, placeholder `''` like `codeIntelContext`, prepare.ts:309), assembled in gather, passed as its own optional param to every runner, injected as `wrapUntrusted(...)` in the system-prompt arrays. Riding `combinedStackHints` (execute.ts:185) fails twice: `stackHints` is interpolated RAW/unfenced (simple.ts:193) while graph text is attacker-influenceable data under the fencing contract (prompts.ts:300-530), and byte-stability would depend on execute's string concat. `.filter(Boolean)` (simple.ts:198) makes prompts byte-identical when `''`. | Extending `callChainContext` in prepare-graph.ts:301-378 (Approach A: unfenced, unbounded, no own budget). |
| 2 | Neighbors API | New `packages/core/src/graph/neighbors.ts`: `collectFileNeighborhoods(graph, files, opts?) → FileNeighborhood[]`, BOTH directions — importers via `buildReverseIndex` (imported from blast-radius.ts:56, includes call edges), importees via `node.imports` — plus capped `node.exports` symbol list (10/file, mirrors gather-safe.ts:155-160). Depth fixed at 1: transitive dependents are blast-radius's job (blast-radius.ts:96-200, depth 3/cap 50, golden-pinned — do not churn). Caps: 10/file/direction, 30 files total, `truncated` flag per file. | Extending `computeBlastRadius` (semantics churn in golden-pinned BFS); symbol-precise edges (fail on `importSymbols` gaps for Python/Rust regex, schema.ts:73-81). |
| 3 | Budget mechanics | Fixed sidecar `graphContextMaxTokens`, default **1,200** (code-intel precedent 1,500 at context.ts:14; lower because it rides beside code-intel + call-chain). Formatter accumulates sections at CHARS_PER_TOKEN=4 with truncation notice (context.ts:44-57 pattern). NOT carved from the 70/30 split: `calculateTokenBudget` (token-budget.ts:140-150) and diff truncation (prepare.ts:269-276) run in prepare, before gather — diff budget cannot shrink by construction. Per-voice: ONE shared capped string; workflow specialists get it via `SPECIALIST_CONTEXT_MAP` additions (workflow.ts:114-122) for scope-analysis/performance/coding-standards (security keeps static, errors stays minimal); simple/consensus/fan-out receive it wholesale. No per-specialist re-truncation — the cap is applied once; re-slicing fragments per-file sections. | Per-voice independent budgets (N formatter configurations, no quality evidence justifying it). |
| 4 | Staleness ladder | Three tiers. `isGraphStale` >7d (schema.ts:405-411) → NO section. Not `isExactCommitFresh` (narrow-symbols.ts:117-132) → file-level only: importer/importee PATHS + counts, header marked "may be from an older commit"; NO symbol names (symbol claims fail closed, exactly like `narrowBySymbols`). Exact-fresh → full per-edge symbol detail. Absence (no graph/disabled) is normal, not a `failedStep` — surfaced via `graphContextMetadata.skippedReason` (CORE-INTEL-003 visibility pattern, gather-safe.ts:126-233). | Commit-distance bound (no distance metric exists; `lastIndexedCommit` is equality-only). |
| 5 | Token split | `GenerateTextFn` result gains optional `inputTokens`/`outputTokens`. Capture where the data already exists: groq.ts:30, ollama.ts:32, explanation-generate-fn.ts:62 (from `usage`); cli-bridge — `parseOpenCodeOutput` (cli-bridge.ts:281-309) ALREADY returns `{input?, output?}` and discards it; wire through. Gateway protocol carries only `tokensUsed` (gateway.ts:71) → stays undefined, marked unmeasured. `ReviewMetadata.inputTokensUsed?/outputTokensUsed?` (types.ts:539 area); workflow.ts:264,337 and consensus.ts:313,366 aggregate both. DB: two nullable integer columns `input_tokens_used`/`output_tokens_used` on `reviews` (schema.ts:167), additive migration, no backfill (NULL = unmeasured). cost-footer.ts:67-75 `calculateReviewCost` already accepts `{inputTokens, outputTokens}` — callers pass measured values; the 70/30 heuristic survives only as unmeasured fallback. | JSON token-usage object on `reviews` (not aggregatable with `sum()` without JSON functions; existing aggregate at queries.ts:816 sums a column). |
| 6 | Eval corpus | `packages/core/test/fixtures/graph-context/<case>/` (fixtures precedent: scip-*-sample). Per case: `diff.patch`, `graph.json`, `metadata.json`, `expected-context.json` (asserted context SHAPE: which files/symbols appear, freshness tier, truncation markers), `expected-prompt-off.txt` (byte-identical baseline) and `expected-prompt-on.txt`. CI is model-free/network-free/deterministic: vitest runs wiring+formatter against fixtures asserting shape and byte-stability; findings quality is NOT asserted in CI — it rides the golden suites' determinism (same prompt bytes → same distributions) plus one documented out-of-band model run over the corpus before default-on stands. | Findings-quality assertions in CI (flaky, model-dependent, slow). |

## Data Flow

    ghagga index → ghagga/graph branch ─→ PreloadedGraphLoader (server) | .ghagga/graph.json (CLI)
                                              │
    diff → prepare (parse, 70/30 budget, diff truncation — UNCHANGED)
                                              │
    gather (step 5.x, new): enableGraphContext? ──no→ '' (byte-stable prompts)
       │ yes: graph loaded? ──no→ skip (skippedReason: 'no-graph')
       │      isGraphStale(>7d)? ──yes→ skip ('stale-graph')
       │      collectFileNeighborhoods (reverse index + node.imports, caps)
       │      isExactCommitFresh? ──no→ file-level only, "older commit" header
       │      formatNeighborhoodContext (1,200-token cap, truncation notice)
       ↓
    PipelineState.graphNeighborhoodContext
       ↓
    execute → per-runner param → wrapUntrusted(<UNTRUSTED label="graph neighborhood">)
       → system prompt (simple/consensus/fan-out: all; workflow: 3 of 5 specialists)
       ↓
    providers → inputTokens/outputTokens → metadata → reviews.input_tokens_used/output_tokens_used
       → cost-footer (measured split; 70/30 only when unmeasured)

## Settings Surface

| Field (ReviewSettings) | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enableGraphContext` | `boolean?` | `undefined` = auto-on when a graph is loaded (mirrors blast-radius auto-enable, review.ts:1156-1171) | `false` disables; `true` attempts, degrades to skip when no graph |
| `graphContextMaxTokens` | `number?` | `1_200` | Formatter cap; clamped ≥ 0 |

No settings-spec delta (precedent: `enableCodeIntel`/`codeIntelMaxTokens`, types.ts:281-285, carry none).

## Interfaces / Contracts

- `collectFileNeighborhoods(graph: DependencyGraph, files: string[], opts?: { maxPerFile?: number; maxTotalFiles?: number }): FileNeighborhood[]` — pure, synchronous, no I/O.
- `FileNeighborhood = { file: string; importers: string[]; importees: string[]; exportedSymbols: string[]; importedSymbolEdges?: number; isTest: boolean; truncated: boolean }`.
- `formatGraphNeighborhoodContext(neighborhoods: FileNeighborhood[], opts: { maxTokens: number; freshness: 'exact' | 'file-level' }): string` — `''` on empty input.
- `graphContextMetadata = { skippedReason?: 'disabled' | 'no-graph' | 'stale-graph'; filesCovered: number; truncatedFiles: number; freshness: 'exact' | 'file-level' }` on `ReviewMetadata` (optional).
- Output text is untrusted DATA: fenced via `wrapUntrusted`, defanged by `sanitizeUntrusted` (prompts.ts:470-477), capped by `UNTRUSTED_BLOCK_CHAR_CAP`.

## Degradation Ladder

| Condition | Behavior | Visible as |
| --- | --- | --- |
| Setting `false` | Skip step, no emit, `''` context | `skippedReason: 'disabled'` |
| No graph loaded | Skip, one progress emit | `skippedReason: 'no-graph'` |
| `isGraphStale` (>7d) | Skip | `skippedReason: 'stale-graph'` |
| Not exact-commit-fresh | File paths/counts only, "older commit" header | `freshness: 'file-level'` |
| File missing from graph | Omit that file's section | `filesCovered < changed` |
| Budget overflow | Truncation notice, stop | `truncatedFiles` |
| Formatter throw | Catch, `failedStep`, continue without | gather-safe pattern |

## File Changes

| Files | Action |
| --- | --- |
| packages/core/src/graph/neighbors.ts (+test) | Pure neighborhood query + caps |
| packages/core/src/graph/neighborhood-format.ts (+test) | Budgeted formatter, freshness tiers |
| packages/core/src/pipeline/state.ts, gather-context.ts, gather-safe.ts (+tests) | `graphNeighborhoodContext` field, gatherGraphContextSafe step, skip metadata |
| packages/core/src/pipeline/execute.ts | Pass new param to runners (concat at :185 UNTOUCHED) |
| packages/core/src/agents/{simple,workflow,consensus,fan-out-lenses,diagnostic}.ts (+prompt goldens) | Optional param, fenced section, `SPECIALIST_CONTEXT_MAP` additions |
| packages/core/src/providers/{groq,ollama,cli-bridge,generate-fn,explanation-generate-fn}.ts | Capture `inputTokens`/`outputTokens` |
| packages/core/src/types.ts, agents/{workflow,consensus}.ts, cost-footer callers | Metadata fields, aggregation, measured split |
| packages/db/src/schema.ts, queries.ts, drizzle/0004_* | Nullable `input_tokens_used`/`output_tokens_used` |
| apps/server/src/queues/review.ts | Persist split (:960, :1064) |
| packages/core/test/fixtures/graph-context/* | Eval corpus (6 design decision) |

## Slices: Size and Risk

| Slice | Lines | Risk | Notes |
| --- | --- | --- | --- |
| 1. Neighbors API | 150-250 | Low | Pure, golden-tested traversal |
| 2. Formatter | 150-250 | Low | Deterministic budget math |
| 3. Wiring + degradation | 200-350 | Medium | Ladder exhaustively tested; fail-closed |
| 4. Prompt section | 150-300 | Medium | Byte-stability goldens per runner; fencing |
| 5. Token split + migration | 150-250 | Medium | DB migration; provider matrix (gateway unmeasured) |

## Testing Strategy

- **Slice 1**: table-driven unit tests over synthetic graphs — directions, caps, cycles, test files, missing nodes.
- **Slice 2**: budget boundary tests (fits/exactly-over/cap-clamp), freshness tiers, empty → `''`.
- **Slice 3**: degradation ladder as parametrized cases (each row of the ladder); no-graph/stale/disabled produce `''` and correct `skippedReason`; existing prepare/gather goldens byte-stable.
- **Slice 4**: golden prompt snapshots per runner — off = byte-identical to current goldens; on = exactly one new fenced section at a pinned position; defang tests (forged `</UNTRUSTED>` in a file path/symbol).
- **Slice 5**: provider unit tests (groq/ollama/cli-bridge report split; gateway undefined), aggregation sums, migration integration in packages/db PostgreSQL harness, cost-footer shows measured vs estimated.
- **Eval corpus**: CI model-free shape assertions + prompt-byte snapshots; quality gate is out-of-band and documented before default-on.

## Migration / Rollout

Append DB migration first (nullable columns — harmless). Ship slices 1-5 behind `enableGraphContext` auto-on-with-graph. Rollback: set `false`; prompts and pipeline return byte-identical to baseline; columns remain valid.

## Open Questions

None.
