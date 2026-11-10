# Proposal: Blast-Radius Diagram in Review Comment and Dashboard

## Intent

Blast radius is computed and paid for on every graph-backed review, but it is render-invisible: `applyBlastRadius` collapses the result into counts-only `BlastRadiusMetadata` (`prepare-graph.ts:94-106`, `:151-158`), `formatReviewComment` never reads `result.metadata.blastRadius` (`format.ts:452-611`), and the DTO pick-list drops metadata entirely (`apps/server/src/routes/api/reviews.ts:158-181`). Reviewers see a narrowed review with no picture of why. Render the blast-radius subgraph as a mermaid diagram in the review comment and the dashboard detail view, from one deterministic source.

## Scope Decision

**Selective (Approach B, standing recommendation — vettable at design).** Ship mermaid as the single diagram source: a pure renderer in core feeds an additive comment section, capped node/edge lists persist through the existing metadata jsonb, and the dashboard renders the identical mermaid source. Interactivity (react-flow) and per-hop visualization are deferred until measured demand.

### In Scope

- Pure, sorted, sanitized mermaid renderer in core over explicit node/edge input (alphanumeric ids, quoted labels).
- Edge derivation via the merged `collectFileNeighborhoods` neighbors API (`packages/core/src/graph/neighbors.ts`) — both directions (importers via reverse edges, importees via `node.imports`), queried over the capped blast-radius node set, keeping edges internal to that set. `computeBlastRadius` semantics stay untouched.
- Capped node/edge lists carried into `BlastRadiusMetadata`; additive data-presence-gated `### Blast Radius` comment section; one new DTO key; dashboard detail embed rendering the same mermaid source, lazy-loaded.
- Default ON when blast-radius ran (rides existing `enableBlastRadius`; no separate v1 toggle — vettable).
- Render cap ~25 nodes with directory-clustered "+N more" truncation; legend honesty for `graphStale` and `exceededCap`.

### Out of Scope

- react-flow / pan-zoom interactivity; GitLab-specific rendering (both forges render mermaid natively); per-node hop-distance visualization; new settings toggles.

## Capabilities

### Modified Capabilities

- `review-formatting`: new additive `### Blast Radius` section (mermaid fenced block), data-presence-gated to `''` when absent (same contract as `formatSemanticDiffSection`), with strict label sanitization.
- `core-engine`: extend `BlastRadiusMetadata` with capped node/edge lists under Review Pipeline Execution; add the pure mermaid renderer to the graph module.
- `server`: project one new DTO key (diagram data) from the persisted metadata blob on the reviews API; `packages/types/src/api.ts` declares the shared shape (no separate `types` capability — server owns the API surface).
- `dashboard-ui`: Review History "View review detail" renders the diagram; mermaid npm loaded lazily only when a review has diagram data (GitHub Pages bundle constraint).

## Approach

Four independently shippable slices (from exploration):

1. Pure mermaid renderer (sorted, capped, sanitized) — testable without pipeline coupling (~150-250 lines).
2. Edge-carrying blast-radius summary via the neighbors API threaded into `BlastRadiusMetadata` (~150-300).
3. Additive comment section + sanitization + golden stability across all three consumers (~150-250).
4. DTO projection + dashboard detail embed with lazy mermaid (~200-350).

The neighbors API is depth-1 per file; edges between intermediate (hop 2-3) nodes are derived by querying neighborhoods over the full capped node set, not just changed files. Exact derivation is a design-phase question.

## Affected Areas

| Area               | Impact   | Description                                                        |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `packages/core`    | Modified | Mermaid renderer; edge derivation; metadata extension; new section |
| `packages/types`   | Modified | One DTO key on the review shape                                    |
| `apps/server`      | Modified | Project diagram data in `toReviewDto`                              |
| `apps/dashboard`   | Modified | Detail-modal diagram component + lazy mermaid chunk                |

Rough size: ~700-1,100 lines including tests and spec deltas.

## Risks

| Risk                    | Mitigation                                                                      |
| ----------------------- | ------------------------------------------------------------------------------- |
| Mermaid injection       | Allowlist sanitizing + quoted labels + numeric ids; test quotes, `-->`, HTML, newline headers |
| Golden determinism      | Renderer explicitly sorts nodes/edges; no `Set` iteration in output              |
| Comment size            | ~25-node render cap; persisted lists capped server-side, not just render-side    |
| Dashboard bundle        | mermaid lazy-loaded only when diagram data exists; main bundle unchanged         |
| Stale graph             | `graphStale`/`exceededCap` rendered in the legend                                |
| jsonb growth            | Persisted list caps decided at design; counts already survive                    |

## Rollback Plan

The section is data-gated: stop emitting diagram metadata and the comment is byte-identical to today's (`''` when absent). Metadata fields are additive — old readers ignore them. Remove the DTO key and the dashboard lazy path is never taken.

## Dependencies

- graph-context-retrieval slice 1 (`collectFileNeighborhoods`) — merged on main (PR #471).
- Existing sanitizers (`sanitizeMarkdownText`/`sanitizeTableCell`) and `upsertSummaryComment` posting path; mermaid npm (new, dashboard only, lazy chunk).

## Success Criteria

- [ ] Golden comment tests byte-stable when diagram data is absent (CLI, action, server consumers).
- [ ] Sanitization tests pass for injection vectors: quotes, `-->`, HTML entities/tags, newline header injection.
- [ ] Dashboard main bundle size unchanged; mermaid loads only on the lazy path when a review has diagram data.
- [ ] Deterministic output: sorted nodes/edges, stable ids — identical inputs produce byte-identical mermaid across runs.
- [ ] Diagram shows up+downstream edges for changed files with honest legend (`graphStale`, `exceededCap`, "+N more" truncation).

## Open Questions (design phase)

1. DTO key shape: full `{nodes, edges, mermaid, flags}` vs mermaid source string only.
2. Persisted list cap sizes vs render cap (jsonb growth bound).
3. Section placement and `<details>` collapsed vs open in the comment.
4. Mermaid version pinning and lazy strategy (dynamic-import chunk vs CDN).
5. Directory-cluster rendering details (subgraph depth, "+N more" granularity).
