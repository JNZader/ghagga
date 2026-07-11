# Delta for Memory Storage

## MODIFIED Requirements

### Requirement: R5 FTS5 Search Parity

(Previously: keyword-only FTS5/tsvector matching with optional cosine RE-RANK of the keyword candidate set only. Now: when a provider is active, a bounded cosine candidate set is UNIONED with the keyword candidate set before ranking — closing the "lexically-disjoint but semantically-close observation is never retrievable" gap.)

#### R5.1: Keyword Matching

`SqliteMemoryStorage.searchObservations` MUST use the FTS5 virtual table to perform keyword matching against `title`/`content`. PostgreSQL MUST use `to_tsquery` against `search_observations`. This candidate source is unchanged.

#### R5.2: BM25 Ranking

Keyword candidates SHOULD be ranked by FTS5 `bm25()` (SQLite) or `ts_rank` (PostgreSQL), normalized to `[0,1]` for the combined score. Unchanged.

#### R5.3: Project Scoping

Results MUST be filtered to the given `project`. Unchanged.

#### R5.4: Type Filtering

`options.type`, when provided, MUST further filter results. Unchanged.

#### R5.5: Limit

Results MUST be capped at `options.limit` (default 10). Unchanged.

#### R5.6: Parity Expectations

Exact SQLite/PostgreSQL keyword-ranking parity is NOT required (BM25 vs `ts_rank` differ). Unchanged.

#### R5.7: Semantic Candidate Union (Option A)

When an `EmbeddingProvider` is active, `searchObservations` MUST supplement the keyword candidate set with a bounded cosine-similarity candidate set: select up to a bounded `K` project-scoped, dimension-matching embedded observations, compute cosine similarity in JS, and take the top candidates by similarity. This MUST behave symmetrically on SQLite and PostgreSQL.

#### R5.8: Union, Dedup, and Re-Rank

The keyword candidate set and the cosine candidate set MUST be unioned and deduplicated by observation `id` before scoring. Each deduplicated candidate MUST be scored with the existing formula `finalScore = 0.7*cosineSim + 0.3*normalizedKeywordScore`, then the existing decay filter, then capped at `options.limit`.

#### R5.9: Vector-Only Candidate Scoring

A candidate present only in the cosine set (no lexical match) MUST use keyword-score `0` in the combined formula, mirroring the existing "no embedding" convention where an unembedded candidate uses cosine `0`.

#### R5.10: `last_accessed_at` Update Scope

`last_accessed_at` MUST be updated only for the final limit-capped rows actually returned to the caller, preserved unchanged through the union/dedup/re-rank pipeline — never for candidates that were unioned in but did not survive ranking.

#### R5.11: No-Provider Byte-for-Byte Parity

When no `EmbeddingProvider` is active (`none`), `searchObservations` MUST behave byte-for-byte identically to the pre-union keyword-only path: no cosine candidate set is computed, no union/dedup step runs, and results/ordering/`last_accessed_at` updates are unchanged from current behavior.

#### Scenario: Lexically-disjoint semantic match retrieved

- GIVEN a provider is active
- AND an observation titled "Credential exposure in logs" exists with no lexical overlap with the query
- WHEN `searchObservations(project, "secret leakage")` is called
- THEN the observation MUST appear in the cosine candidate set
- AND it MUST be eligible for the final ranked results if its combined score is competitive

#### Scenario: Keyword and vector candidates overlap

- GIVEN an observation matches both the keyword gate and the cosine top-K
- WHEN the union/dedup step runs
- THEN the observation MUST appear exactly once in the candidate set
- AND its score MUST use its real keyword score, not `0`

#### Scenario: Vector-only candidate scored with keyword-score zero

- GIVEN an observation is in the cosine candidate set only (no FTS5/tsquery match)
- WHEN it is scored
- THEN `finalScore = 0.7*cosineSim + 0.3*0`

#### Scenario: No provider — identical to current behavior

- GIVEN no `EmbeddingProvider` is active
- WHEN `searchObservations` is called with the same project/query/options as before this change
- THEN the returned rows, ordering, and `last_accessed_at` updates MUST be identical to pre-change behavior

#### Scenario: Symmetric behavior across backends

- GIVEN the same provider, project, query, and dataset (modulo backend-specific storage) on SQLite and PostgreSQL
- WHEN `searchObservations` executes on each
- THEN both MUST apply the same union/dedup/0.7-0.3/decay/limit pipeline
- AND `apps/server/src/memory/postgres.ts` decay filtering MUST stay in sync with the SQLite decay logic

#### Scenario: `last_accessed_at` only touches final returned rows

- GIVEN the cosine union brings in 5 extra candidates beyond the keyword set
- AND only 3 of the unioned candidates survive the limit cap
- WHEN the search completes
- THEN `last_accessed_at` MUST be updated only for those 3 returned rows

## ADDED Requirements

### Requirement: Backfill of NULL-Embedding Observations

The system MUST provide a one-time backfill job that re-embeds all existing observations whose stored embedding is NULL (or whose stored dimension does not match the active provider), using the active provider's `embedBatch`.

#### Scenario: Backfill populates NULL embeddings

- GIVEN a provider is configured and observations exist with NULL embeddings
- WHEN the backfill job runs
- THEN every NULL-embedding observation MUST be embedded and its embedding, provider id, and dimension persisted
- AND observations that already have a matching-dimension embedding MUST be skipped

#### Scenario: Retrieval during partial backfill

- GIVEN backfill has embedded some but not all eligible observations (mixed embedded/NULL rows)
- WHEN `searchObservations` is called with a provider active
- THEN embedded rows MUST be eligible cosine candidates
- AND NULL-embedding rows MUST remain reachable only via the keyword candidate path
- AND no error MUST occur due to the mix

#### Scenario: Backfill is idempotent

- GIVEN the backfill job has already run once for the active provider/dimension
- WHEN it is run again
- THEN it MUST re-embed only rows still NULL or dimension-mismatched
- AND it MUST NOT re-embed already-matching rows
