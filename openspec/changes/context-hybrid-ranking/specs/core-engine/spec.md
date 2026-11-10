# Core Engine Delta

> **Change**: `context-hybrid-ranking`
> **Base spec**: `openspec/specs/core-engine/spec.md`
> **Sequencing**: the base for this delta is the MERGED `graph-context-retrieval` text (change #471), which is NOT yet in `openspec/specs/core-engine/spec.md` — that change is un-archived at authoring time. The requirement below is quoted from `openspec/changes/graph-context-retrieval/specs/core-engine/spec.md` ("Token Budget Management") with this change's modification applied on top. Archive order: `graph-context-retrieval` first, then this change; applying this delta to the post-#471 spec yields exactly the text below.

## MODIFIED Requirements

### Requirement: Token Budget Management

The system MUST manage token consumption to avoid exceeding model context limits. Token usage from `generateText()` is tracked via `result.usage.inputTokens` and `result.usage.outputTokens` (AI SDK v5 naming).

The graph-neighborhood context MUST carry its own dedicated budget configured by `graphContextMaxTokens`, following the `codeIntelMaxTokens` precedent. Rationale: neighborhood tokens are additive signal; without a dedicated cap they would silently erode the diff budget that finding quality depends on.

When the neighborhood section overflows `graphContextMaxTokens`, the surviving entries MUST be selected by a deterministic lexical+structural ranking — NOT positional first-fit in diff order. Each file neighborhood MUST be scored by lexical overlap between tokens extracted from the diff and the neighborhood's signal surface (path segments, changed symbols, `importSymbols`, `exports`), with the file's importer degree applied as tiebreak component. The sort MUST be stable: neighborhoods with equal scores keep their diff order. The ranking MUST fire at both freshness tiers (exact and file-level) and MUST change entry ORDER only — what renders at each tier and the staleness ladder's fail-closed claims are unchanged. The ranking itself MUST fail closed: an error thrown during ranking MUST land in the existing failed-step handling (`failedSteps`, step `graph-context`) and the review MUST continue without the neighborhood section, never failing. When the graph is absent, stale beyond the 7-day tolerance, or the step is disabled, no ranking MUST run and the assembled prompts MUST remain byte-identical to the pre-change behavior. `GraphContextMetadata.rankingMode` MUST report `'lexical'` when the ranker ran and MUST be absent when it did not (skip-path metadata objects are unchanged — the field is absent ≙ did not run; no `'none'` value exists). This ranked rule supersedes the neighborhood sidecar's previous alignment with diff truncation's most-changes priority; diff truncation itself is untouched.

The neighborhood budget MUST NOT shrink the diff budget: the 70/30 context split and diff truncation MUST be computed exactly as they would be with the feature disabled. In multi-voice modes the cap MUST be enforced per voice at the prompt seam: each workflow specialist and each consensus stance receives a neighborhood section capped by `graphContextMaxTokens`, carved from the shared assembled neighborhood for that voice's file subset, and a voice with no neighborhood entries for its subset receives no section.

(Previously — merged `graph-context-retrieval` text: budget truncation inside `formatGraphNeighborhood` was first-fit in input order, and the cap scenario aligned neighborhood truncation with diff truncation's most-changes rule. This change replaces the positional rule with the deterministic lexical+structural ranking and adds the `rankingMode` observability field.)

#### Scenario: Diff exceeds model context

- GIVEN a diff that exceeds the configured model's context window
- WHEN the review pipeline prepares the prompt
- THEN the diff MUST be truncated to fit within the token budget
- AND the truncation MUST prioritize files with the most changes
- AND the review result MUST note that the diff was truncated

#### Scenario: Token usage tracking with AI SDK v5

> Added by change: ai-sdk-v5-migration
- GIVEN a single-step `generateText()` call completes successfully
- WHEN the result usage is accessed
- THEN `result.usage.inputTokens` MUST contain the prompt token count
- AND `result.usage.outputTokens` MUST contain the completion token count
- AND the total tokens used MUST be calculated as `inputTokens + outputTokens`

#### Scenario: Neighborhood output is capped by its dedicated budget

- GIVEN changed files whose full neighborhood rendering would consume 5,000 tokens and `graphContextMaxTokens` set to 1,500
- WHEN the neighborhood section is formatted
- THEN the output MUST NOT exceed 1,500 tokens
- AND truncation MUST keep the highest-ranked neighborhoods under the deterministic lexical+structural ranking (diff-token overlap with path segments/changed symbols/imports, importer-degree tiebreak, stable sort) — not whoever appeared earliest in the diff

#### Scenario: Budget overflow keeps the highest-scored file over an earlier-in-diff low scorer

- GIVEN a diff listing file A first whose neighborhood has negligible diff-token overlap, and file B last whose neighborhood highly overlaps the diff tokens through its paths, changed symbols, and imports
- AND a `graphContextMaxTokens` budget that fits file B's entry but not both entries
- WHEN the neighborhood section is formatted
- THEN file B's neighborhood MUST be rendered and file A's MUST be dropped
- AND the drop MUST be reported through `truncatedFiles` in the graph-context metadata
- AND `rankingMode` MUST report `'lexical'`

#### Scenario: Ranking tie keeps diff order

- GIVEN two changed files whose neighborhoods receive identical lexical+structural scores
- WHEN the ranked neighborhood order is computed
- THEN the file appearing earlier in the diff MUST be ordered first
- AND repeated runs on the same diff and graph MUST produce byte-identical section output

#### Scenario: Ranking failure degrades to failedStep and the review continues

- GIVEN a fresh graph and a ranking step that throws during neighborhood ranking
- WHEN the graph-neighborhood gather step runs
- THEN the error MUST land in the existing failed-steps handling (a `graph-context` entry in `failedSteps`)
- AND the review MUST complete normally without the neighborhood section
- AND no error MUST be surfaced to the caller

#### Scenario: No ranking when the graph is absent, stale, or the step is disabled

- GIVEN a repository where the graph is absent (no published `ghagga/graph` branch, no local `.ghagga/graph.json`), or the loaded graph is stale beyond the 7-day tolerance, or `enableGraphContext` is `false`
- WHEN the review pipeline executes
- THEN no ranking MUST run
- AND where a graph-context metadata object is present it MUST remain byte-identical to the pre-change shape, with `rankingMode` absent (absent ≙ did not run)
- AND the assembled prompts MUST remain byte-identical to the behavior before this change

#### Scenario: Ranking fires at both freshness tiers

- GIVEN the same diff and graph assembled twice — once at the exact tier (symbol-level rendering) and once at the file-level tier (graph fresh within tolerance but not exact-commit-fresh)
- WHEN the neighborhood section is assembled in each run
- THEN both runs MUST order the neighborhoods by the same lexical+structural ranking
- AND each run's rendered entries and per-entry format MUST match its tier's pre-ranking rendering — only the ORDER differs
- AND both runs MUST report `rankingMode: 'lexical'`

#### Scenario: Neighborhood budget never shrinks the diff budget

- GIVEN the same diff and configuration reviewed twice — once with `enableGraphContext` on and a fresh graph, once with it off
- WHEN the 70/30 context split and diff truncation are computed
- THEN both runs MUST produce identical diff budgets and identical truncated diff content

#### Scenario: Per-voice cap in a five-specialist fan-out

- GIVEN a workflow review with 5 specialists, a loaded fresh graph, and neighborhood entries covering the changed files
- WHEN the 5 specialist prompts are built from their context subsets
- THEN each specialist's neighborhood section MUST NOT exceed `graphContextMaxTokens`
- AND a specialist whose subset contains no neighborhood entries MUST receive no neighborhood section
- AND consensus stances MUST be subject to the same per-voice cap
