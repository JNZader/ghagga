# Core Engine Delta

> **Change**: `nightly-health-digest`
> **Base spec**: `openspec/specs/core-engine/spec.md`
>
> **Why ADDED, not MODIFIED**: the base core-engine spec has no health requirement.
> Health scoring was specified CLI-side (`cli-enhancements` R9/R10, the `ghagga health`
> command) even though the implementation lives in `packages/core/src/health`. This
> delta adds the server-facing core contract for that module; the CLI-scoped
> requirements in `cli-enhancements` are untouched.
>
> **Merge seam**: no open change touches a health requirement. `graph-context-retrieval`
> and `blast-radius-diagram` both MODIFIED `Review Pipeline Execution` — unrelated to
> this requirement; no rebase interaction.

## ADDED Requirements

### Requirement: Health Analysis from Stored Findings

The core health module MUST accept stored findings (DB-sourced `ReviewFinding[]` read from `reviews.findings` jsonb) as an alternative input to live tool runs. Rationale: server-side digests aggregate findings that already exist in the database; re-running tools or LLMs would multiply cost without changing the signal. The module MUST satisfy:

- **Equivalence**: score, severity counts, recommendations, and trend computed from stored findings MUST equal the pure-function results for the same findings supplied live. The stored-findings path MUST make no LLM calls and consume zero tokens.
- **Aggregation window**: the module MUST aggregate findings across multiple reviews created after a watermark timestamp (the last digest), yielding per-severity counts and a combined finding set for the window.
- **Per-file risk ranking**: the module MUST rank files by a deterministic score derived from findings count × severity weight × recency, incorporating blast-radius counts from review `metadata` when present. Identical inputs MUST produce an identical ranking.
- **Malformed-row tolerance**: findings jsonb that is `null`, not an array, or contains entries missing required fields MUST be skipped or counted as unknown — the module MUST NOT throw.

All functions in this requirement are pure and forge-agnostic: no forge adapter, no HTTP, no filesystem writes.

#### Scenario: Stored-findings scoring equivalence

- GIVEN the same `ReviewFinding[]` (2 critical, 3 medium) supplied live to the health command and stored in `reviews.findings`
- WHEN health scoring runs over the stored findings
- THEN the score, per-severity counts, and recommendations MUST equal the live-run results for the same findings
- AND no LLM call MUST be made and zero tokens MUST be consumed

#### Scenario: Aggregation window since watermark

- GIVEN reviews R1 (yesterday, 1 high finding) and R2 (today, 2 low findings) created after the watermark, and R0 (last week, 5 critical findings) created before it
- WHEN the health module aggregates findings since the watermark
- THEN the window counts MUST reflect R1 and R2 only (1 high, 2 low)
- AND findings from R0 MUST be excluded from counts and ranking

#### Scenario: Per-file risk ranking is deterministic

- GIVEN the window contains findings for `src/a.ts` (3 high, recent) and `src/b.ts` (1 low, older), and review metadata carries blast-radius counts for `src/a.ts`
- WHEN the per-file ranking is computed
- THEN `src/a.ts` MUST rank above `src/b.ts`
- AND computing the ranking twice on identical inputs MUST produce identical order and identical per-file scores

#### Scenario: Malformed findings rows are tolerated

- GIVEN the window contains one review whose `findings` jsonb is `null`, one holding `[{ "not": "a finding" }]`, and one holding well-formed findings
- WHEN aggregation and ranking run over the window
- THEN the well-formed findings MUST be aggregated normally
- AND the malformed rows MUST be skipped or counted as unknown
- AND the module MUST NOT throw
