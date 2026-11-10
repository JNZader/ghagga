# Delta for Server

> **Change**: `graph-context-retrieval`
> **Base spec**: `openspec/specs/server/spec.md`

## ADDED Requirements

### Requirement: Input/Output Token Split Persistence

The review result metadata contract MUST carry `inputTokens` and `outputTokens` alongside the existing `tokensUsed`, and the server MUST persist the split on the `reviews` record through additive, nullable columns introduced by a migration (`input_tokens`, `output_tokens`). Rationale: the change's success metric — fewer input tokens per review at equal-or-better finding quality — is unmeasurable while only a merged total is stored.

The existing `tokens_used` column and its aggregate queries MUST keep their current semantics: `tokens_used` remains the authoritative total, and for any review where the split is present, `tokens_used` MUST equal `input_tokens + output_tokens`. Pre-existing rows are not backfilled; their split columns remain null.

#### Scenario: Review with a complete token split is persisted

- GIVEN a completed review whose result metadata carries `tokensUsed: 10000`, `inputTokens: 7000`, and `outputTokens: 3000`
- WHEN the server saves the review
- THEN the `reviews` row MUST persist `tokens_used = 10000`, `input_tokens = 7000`, and `output_tokens = 3000`

#### Scenario: Migration leaves existing rows and aggregates unchanged

- GIVEN review rows created before this migration
- WHEN the migration runs
- THEN their `tokens_used` values MUST remain unchanged and the new split columns MUST be null
- AND existing stats and aggregate responses (including total-token sums) MUST return identical values as before the migration

#### Scenario: Review without a token split still saves

- GIVEN a completed review whose metadata lacks `inputTokens`/`outputTokens` (provider or core version without the split)
- WHEN the server saves the review
- THEN `tokens_used` MUST persist exactly as before this change and the split columns MUST remain null
- AND saving MUST NOT fail

#### Scenario: Aggregate token queries keep their semantics

- GIVEN a repository with reviews both with and without the split
- WHEN aggregate token queries run (for example, repository token totals)
- THEN the results MUST match pre-change semantics — the sum of `tokens_used`
- AND the new columns MUST NOT be double-counted into any existing aggregate
