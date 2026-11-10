# Proposal: Graph-Guided Context Retrieval

## Intent

Review voices pay for broad, low-signal context. Every voice receives the full truncated diff plus advisory call-chain text, regardless of which files actually matter, and fan-out/consensus multiply that cost per specialist. Precision-retrieval tooling in the jevgrep class reports ~30% agent cost cuts from feeding models exactly the neighborhood a change touches. GHAGGA already builds a dependency graph (`ghagga index`, published to the `ghagga/graph` branch) and computes blast-radius from it — but the review pipeline never uses it to focus context. This change turns the dormant graph into a budgeted, per-file neighborhood context section so reviews spend fewer input tokens on changed files' true semantic surroundings (importers/importees, key symbols) while the raw diff stays intact.

## Scope Decision

**Approach B first.** A budgeted, opt-out graph-neighborhood sidecar with its own prompt section is reversible, measurable, and preserves the proven raw-diff pipeline as the control. Approach C (graph+scope-synthesized context replacing the truncated diff) is the largest token win but the highest regression risk; it is gated on the token metric and quality guardrails this change ships. Default **ON when a graph is available** (consistent with blast-radius auto-enable in the CLI), disabled via a setting.

## Scope

### In Scope

- Pure neighborhood query API over `DependencyGraph` (neighbors, imported symbols) — no pipeline wiring.
- Budgeted formatter for neighborhood output, following the code-intel precedent (`enableCodeIntel`/`codeIntelMaxTokens`).
- Pipeline wiring with fail-closed degradation: no graph, stale graph, or missing fields means no neighborhood section, never an error.
- Per-voice prompt section carrying the neighborhood, fenced as untrusted content per the prompts contract.
- Input/output token split: measured separately in `ReviewMetadata`, persisted through a `reviews` schema migration, so the success metric is visible.
- Quality guardrails: golden prompt suites stay byte-stable when the feature is off, plus a minimal eval corpus (5-10 synthetic PR fixtures) comparing findings with graph context on/off.

### Out of Scope

- Approach C: replacing the raw truncated diff with scope/symbol-synthesized context (`scope/` activation is slice 6, future work).
- Per-review graph building or lazy incremental indexing; the published-graph read model stands.
- New extractor languages or tree-sitter migration of the regex extractors.
- An eval-harness product; the fixture corpus is a guardrail, not a deliverable capability.

## Capabilities

### Modified Capabilities

- `core-engine`: new graph-context gather step with its own token budget, fail-closed degradation semantics, and input/output token split in review metadata (deltas to Review Pipeline Execution and Token Budget Management).
- `review-prompts`: a new neighborhood context section per voice, additive and untrusted-fenced, with byte-stable prompts when the feature is disabled.
- `server`: persist the input/output token split on the `reviews` record.

No `settings` spec delta: the toggle rides the existing pipeline settings object (precedent: `enableCodeIntel` carries no settings-spec requirements).

## Approach

Slices land in dependency order, each independently testable:

1. **Neighbors API** — traversal over the existing reverse index; pure, no pipeline coupling.
2. **Budgeted formatter** — cap neighborhood output tokens (code-intel precedent shape).
3. **Pipeline wiring + degradation** — opt-out setting, fail-closed when the graph is missing/stale.
4. **Per-voice prompt section** — dedicated context field, untrusted fencing, per-voice budget awareness for fan-out/consensus subsets.
5. **Token split + metric** — `ReviewMetadata` input/output fields, `reviews` migration, surfaced in cost reporting.

Slice 6 (optional `scope/` activation for symbol bodies) is named future work and gated on slice 5's metric.

## Affected Areas

| Area             | Impact   | Description                                                        |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `packages/core`  | Modified | Neighbors API, formatter, gather step, prompts, token metadata     |
| `packages/db`    | Modified | `reviews` schema: separate input/output token columns              |
| `apps/server`    | Modified | Persist the split; graph fetch path reused unchanged               |
| `apps/cli`       | Modified | Default-on detection mirrors blast-radius auto-enable              |

Rough size: 800-1,400 authored lines across the five slices.

## Risks

| Risk                                     | Mitigation                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| Graph freshness (orphan branch indexed at another commit) | File-level neighborhoods tolerate 7-day staleness; symbol-precise claims fail closed on `isExactCommitFresh` |
| Uneven extractor symbol density (6 regex languages, 3 SCIP-only) | Neighborhood formatter degrades to imports/exports-only when symbols are absent |
| Prompt-format stability (golden suites) | New section is additive; byte-stable when the setting is off; golden tests pin it |
| Quality regression from compressed context | Raw diff preserved; eval fixture corpus compares findings on/off before default-on stands |
| Fan-out/consensus context multiplication | Per-voice-aware budgets at the workflow subset seam                            |
| Metric gap (input tokens unmeasured)     | Slice 5 ships schema + measurement before the success claim is evaluated       |

## Rollback Plan

Disable the setting; prompts return byte-identical to baseline and the pipeline skips the gather step. Token-split columns remain (harmless, additive) and stored reviews stay valid.

## Dependencies

- Existing graph build/publish flow, `PreloadedGraphLoader`, and blast-radius reverse index; no new libraries.

## Success Criteria

- [ ] Input tokens per review measurably below baseline on the eval corpus (target delta recorded during design), with output tokens tracked alongside.
- [ ] Golden prompt suites are byte-identical when the feature is off.
- [ ] Finding quality on the eval corpus is equal-or-better with graph context on versus off.
- [ ] Degradation tests pass when the graph is missing, stale beyond tolerance, or symbol-sparse.
- [ ] `reviews` records persist separate input/output token counts and the metric is visible in cost reporting.

## Open Design Questions

1. Inject through the existing `combinedStackHints` channel or a new dedicated state field with its own per-voice prompt section?
2. Per-voice budget mechanics: one shared neighborhood budget with per-specialist subsets (workflow seam), or per-voice independent budgets?
3. Staleness tolerance for file-level neighborhoods: 7-day rule, `lastIndexedCommit` distance bound, or both?
4. Schema migration shape: nullable separate columns vs. a JSON token-usage object on `reviews`; backfill policy for existing rows.
