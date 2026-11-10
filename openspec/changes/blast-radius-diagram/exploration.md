# Exploration: Blast-Radius Diagram in Review Comment and Dashboard

## Exploration Scope

This exploration maps rendering the blast-radius subgraph (changed files + importers/dependents, depth-limited) as a diagram in (a) the PR review comment and (b) the dashboard review detail view. The graph, extractors, and `computeBlastRadius` already exist; this change is about rendering and review-surface visibility. No implementation, live model calls, or test suites were run.

## Current State

- **Blast-radius output shape.** `BlastRadiusResult` = `{files: Set<string>, changedFiles[], dependents[], testFiles[], depth, exceededCap}` (`packages/core/src/graph/blast-radius.ts:27-45`, compute at `:96-200`, reverse index `:56-78`). It carries **flat node sets only — no edges, no per-file direction or hop distance**. Only downstream (importers via reverse edges) is traversed; upstream (importees of changed files) is never computed.
- **Cap semantics.** `exceededCap = allFiles.size > maxFiles` (`blast-radius.ts:190`) — the set is NOT truncated, but step 2.5 then falls back to the full diff and records counts only (`packages/core/src/pipeline/prepare-graph.ts:94-106`). Defaults: depth 3, 50 files (`graph/schema.ts` constants; settings override at `prepare-graph.ts:89-92`).
- **Data reduction at step 2.5.** `applyBlastRadius` collapses the result into `BlastRadiusMetadata` = counts + `fallbackReason?` + `graphStale?` (7-day rule, `schema.ts:192-215`, `isGraphStale` at `schema.ts:405-411`) + `narrowedDependents?` (`prepare-graph.ts:151-158`). **No file lists survive.**
- **Step 2.6 text output is prompt-only.** `## Call-Chain Impact` / `## High-Risk Files` / `## Symbol Impact` blocks (`prepare-graph.ts:286-379`, `:214-279`) ride `callChainContext` into `combinedStackHints` (`packages/core/src/pipeline/execute.ts:185`) — they never reach the comment or dashboard.
- **Comment rendering.** `formatReviewComment` (`packages/core/src/format.ts:452-611`) renders status/summary/findings/static-analysis/file-categories/cost-footer. It **never reads `result.metadata.blastRadius`** (set at `packages/core/src/pipeline/enrich.ts:115-116`). Additive-section precedent: `formatSemanticDiffSection` returns `''` when data is absent, keeping baseline byte-identical (`format.ts:496-499`). Untrusted-content sanitizers exist: `sanitizeMarkdownText`/`sanitizeTableCell` (`packages/core/src/sanitize.ts:44-98`).
- **Posting path.** Three consumers call `formatReviewComment`: server queue (`apps/server/src/queues/review.ts:985-1002` — `upsertSummaryComment` delete-all + repost, fixed `<!-- ghagga-review -->` marker, `<!-- reviewId -->` suffix), CLI (`apps/cli/src/commands/review.ts:826`), action (`apps/action/src/index.ts:470`). GitLab adapter implements `upsertSummaryComment` with the same marker (`packages/forge/src/adapters/gitlab/gitlab-forge-adapter.ts:178`). No comment-length truncation exists in code (GitHub API hard limit 65,536 chars).
- **Persistence.** `saveReview` stores `metadata` jsonb blob including `blastRadius` counts (`packages/db/src/queries.ts:353-370`, `packages/db/src/schema.ts:169`; fold at `queues/review.ts:958-972`).
- **Dashboard.** `toReviewDto` is an explicit pick-list: id/repo/prNumber/status/mode/summary/findings/createdAt/`coverageComplete?` — **no metadata, no blast radius** (`apps/server/src/routes/api/reviews.ts:158-181`; shared DTO `packages/types/src/api.ts:42-61`). Review detail is a modal (`apps/dashboard/src/pages/Reviews.tsx:39-120`). Viz libs: **recharts only** (`apps/dashboard/package.json`); no mermaid, react-flow, or d3.
- **Mermaid in repo.** No runtime TS code emits mermaid; docs already use ```mermaid fenced blocks (`docs/review-modes.md:9,24,63`). GitHub (since 2022) and GitLab both render mermaid in comment markdown.

## Affected Areas

- `packages/core/src/graph/` — edge-carrying blast-radius variant (reuse graph-context-retrieval slice-1 neighbors API if landed) and a pure mermaid renderer.
- `packages/core/src/pipeline/prepare-graph.ts` + `enrich.ts` — carry capped node/edge lists into `BlastRadiusMetadata`.
- `packages/core/src/format.ts` — additive `### Blast Radius` section (mermaid fenced block) with sanitization.
- `packages/types/src/api.ts` + `apps/server/src/routes/api/reviews.ts` — one new DTO key projected from the metadata blob.
- `apps/dashboard/src/pages/Reviews.tsx` (and a new component) — embed/render the diagram in the detail modal.
- Specs: `review-formatting` (new section requirement), `dashboard-ui` (Review History "View review detail" scenario), `core-engine` (metadata extension under Review Pipeline Execution).

## Approaches

| Approach | Pros | Cons | Effort |
| --- | --- | --- | --- |
| **A. Mermaid fenced block in comment only (string builder in core)** | Zero new deps; renders natively on both forges; pure/deterministic; rides existing posting path unchanged | Static image-like render, no interactivity; dashboard gets only raw text unless also rendered there; label sanitization burden | Low |
| **B. A + persist nodes/edges in metadata blob + dashboard renders same mermaid client-side (mermaid npm, lazy-loaded)** | One diagram source for both surfaces; dashboard interactive-ish; metadata jsonb already survives | mermaid npm ~1MB bundle hit on a GitHub-Pages-deployed SPA; DTO/key extension; two render paths to keep consistent | Medium |
| **C. Dashboard-only interactive graph (react-flow) + textual summary in comment** | Best dashboard UX (pan/zoom/cluster) | react-flow dep (~300KB+) plus a second diagram dialect; comment gets no diagram (weakest visibility win); most code | High |

### Recommended Reversible Slice Sequence

| Slice | Purpose | Est. lines |
| --- | --- | ---: |
| 1. Pure mermaid renderer over an explicit node/edge input (sorted, capped, sanitized) | Testable without pipeline/format coupling | 150-250 |
| 2. Edge-carrying blast-radius summary (reuse neighbors API if available) threaded into `BlastRadiusMetadata` | Data survives to enrich/format/persistence | 150-300 |
| 3. Additive comment section + sanitization + golden stability | Forge-visible diagram, byte-stable when absent | 150-250 |
| 4. DTO projection + dashboard detail embed (mermaid lazy-load or code block) | Review-visible in dashboard | 200-350 |

## Recommendation

Choose **Approach B**, sequenced so A lands first (slices 1-3 are independently shippable). Render mermaid from a pure function in core with alphanumeric node ids (`n0…`) and quoted, sanitized labels; sort nodes/edges for deterministic golden snapshots; cap diagram nodes (~20-25) with directory-clustered "N more files" truncation and an `exceededCap`/`graphStale` legend note. Persist the capped node/edge lists through the existing metadata jsonb and project one new DTO key. Dashboard renders the identical mermaid source, lazy-loading the mermaid package only when a review has diagram data (defer C-style interactivity until measured demand).

## Constraints and Coupling

- **Couple to `openspec/changes/graph-context-retrieval` slice 1** (pure neighbors API over the reverse index). If it lands first, derive edges from it; else extend `BlastRadiusResult`/`BlastRadiusMetadata` locally and note the merge seam.
- `review-formatting` spec pins `formatReviewComment` scenarios byte-for-byte (R2, S1-S6) — the new section MUST be data-presence-gated (`''` when absent), exactly like `formatSemanticDiffSection`.
- Core cannot import forge; the comment is forge-agnostic markdown, so both adapters render mermaid natively with no adapter changes.
- `upsertSummaryComment` delete-all+repost means diagram content changes repopulate cleanly, but the fixed marker must not be reused for anything else.
- Dashboard deploys on GitHub Pages (`dashboard-ui` spec) — bundle growth is spec-visible; lazy-loading is effectively required for any renderer lib.
- `metadata.blastRadius` is already persisted; adding lists inflates the jsonb blob — cap sizes server-side, not just render-side.
- Upstream (importee) direction and per-file hop distance do not exist in `BlastRadiusResult`; the diagram's edge derivation must define whether to add them or render downstream-only.

## Risks

- **Mermaid injection:** file names come from the attacker-controlled PR head; unsanitized labels can break out of quoted strings or inject edges (`-->`, quotes, HTML). Mitigate with strict allowlist sanitizing + quoted labels + numeric ids; GitHub sanitizes rendered mermaid HTML but structure injection remains.
- **Golden-test determinism:** BFS order is deterministic today, but the renderer must explicitly sort nodes/edges; `Set` iteration in output would be fragile.
- **Comment size:** a 50-node diagram plus findings could push long comments toward API limits; the ~25-node render cap bounds it, but persisted lists need their own cap.
- **Dashboard bundle:** mermaid npm is heavy; without lazy-loading it regresses the Pages deployment.
- **Stale graph:** a diagram from a >7-day-old graph misleads; `graphStale` must be rendered in the diagram legend, and `exceededCap` must show truncation honestly.
- **Two consumers of the same blob:** CLI/action/server all call `formatReviewComment`; the section appears everywhere at once — verify action/CLI golden outputs.

## Open questions for proposal

1. Reuse graph-context-retrieval's neighbors API for edges, or extend `BlastRadiusResult` with an `edges` field first?
2. Diagram scope: downstream-only (what `computeBlastRadius` computes) or also upstream importees (new forward traversal)?
3. Render cap and clustering: fixed ~25 nodes with directory clustering, or configurable via settings (`maxBlastRadiusFiles` is about filtering, not rendering)?
4. Dashboard rendering: lazy-loaded mermaid npm, plain code block, or a lightweight custom SVG?
5. Should persisted metadata carry the capped node/edge lists (jsonb growth) or only the mermaid source string?
6. Where does the section sit in the comment (after Summary, before Findings — next to semantic-diff) and does it collapse inside a `<details>` block?
7. Does `dashboard-ui`'s "View review detail" scenario get amended, or does a new "Blast-Radius Diagram" requirement land?
8. Legend honesty: how to render `graphStale`, `narrowedDependents`, and `exceededCap` inside/next to the diagram?
