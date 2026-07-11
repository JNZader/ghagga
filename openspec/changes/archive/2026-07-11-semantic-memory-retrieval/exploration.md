# Exploration: semantic-memory-retrieval (MEM-HYBRID-006)

Artifact store: openspec. Change: `semantic-memory-retrieval`. Backup: Engram `sdd/semantic-memory-retrieval/explore`.

## Goal

Close MEM-HYBRID-006 (see `notes/AUDIT-2026-07-10.md`): memory search is semantic
**re-ranking of a keyword candidate set**, not true semantic retrieval. Both
backends gate candidates on a lexical match before embedding scoring, so a
semantically-close but lexically-disjoint observation (e.g. query "secret
leakage" vs a "credential exposure" note) is never retrievable.

## Current state (verified)

Both backends share a two-stage flow: (1) a lexical gate produces a candidate
set, (2) if an `EmbeddingProvider` is present, candidates are re-ranked with
`finalScore = 0.7*cosineSim + 0.3*normalizedKeywordScore`. Step 1 is a hard
filter — a lexically-disjoint but semantically-close observation never becomes a
candidate.

- **SQLite** (`packages/core/src/memory/sqlite.ts:257-515`): `searchObservations`
  branches on `embeddingProvider`; set → `_hybridSearch` (FTS5 `MATCH`, fetch
  `limit*5` by `bm25()`, decay filter, normalize BM25 to [0,1], cosine from
  stored `embedding BLOB`, combine 0.7/0.3, cap at `limit`, update
  `last_accessed_at` only for returned rows); unset → keyword-only FTS5 path.
- **PostgreSQL** (`packages/db/src/queries.ts:732-851`): gate
  `search_observations @@ to_tsquery(...)`, `candidateLimit = max(embedFn?
  limit*5 : limit, returnLimit)` by `ts_rank DESC`; if `embedFn` set uses
  **positional rank** `1 - i/(n-1)` as the keyword-score proxy (NOT the real
  `ts_rank` — inconsistent with SQLite's real BM25 value), combine 0.7/0.3.
  `embedding` is `doublePrecision[]` (float8[]), cosine computed in JS.
- Adapter `apps/server/src/memory/postgres.ts:56-98` re-applies the same
  `computeStrength`/`minStrength` decay filter (duplicated logic).
- `packages/core/src/embed.ts`: `EmbeddingProvider` interface + `cosineSimilarity`
  + float32 (de)serialization. **No concrete implementation ships anywhere.**

## PIVOTAL FINDING — the feature is DORMANT

`EmbeddingProvider` is wired **nowhere in production**. Verified at every
construction site:
- `apps/server/src/queues/review.ts:861`: `new PostgresMemoryStorage(db, installationId)` — no provider.
- `apps/cli/src/commands/review.ts:275,278`, `apps/cli/.../memory/utils.ts:42`, `apps/action/src/index.ts:349`: single-arg — no provider.
- No file `implements EmbeddingProvider` outside test fakes; no embedding
  dependency in any `package.json`.

**Implication:** in all 4 distribution modes `searchObservations` ALWAYS takes
the keyword-only branch. `_hybridSearch`/`embedFn` run only in unit tests.
**MEM-HYBRID-006 is a latent defect with zero current user impact** — the
semantic path is never taken. Fixing the retrieval mechanism and wiring a real
provider are two separable pieces of work.

## Affected areas

- `packages/core/src/memory/sqlite.ts:257-515` — gating, re-rank, decay, access update.
- `packages/db/src/queries.ts:732-851` — gating, re-rank (positional-rank proxy), access update.
- `apps/server/src/memory/postgres.ts:56-98` — duplicated decay filter (keep in sync).
- `packages/core/src/embed.ts` — provider interface, cosine, serialization.
- `packages/db/src/schema.ts:191-223` — `embedding` is `doublePrecision[]`, not `vector(dim)`.
- `openspec/specs/memory-storage/spec.md` — main spec to delta (R5 "FTS5 Search Parity").
- `openspec/config.yaml:7` — DB = PostgreSQL (Neon/Supabase); pgvector generally supported but NOT verified live.
- `docker-compose.yml:125-126` — self-hosted `postgres:16-alpine` lacks pgvector.

## Approaches

**Option A — brute-force cosine candidate source (JS, both backends), UNION with keyword candidates.**
Select bounded project embeddings, cosine top-K, union by `id` with keyword
candidates, dedup, feed existing re-rank/decay/limit. No new deps, no migration,
symmetric, deterministically testable. Cons: O(n) per query over project
embeddings; no retention ceiling bounds it (design must pick a bounded K).
Effort: Low-Medium.

**Option B — pgvector for Postgres (real ANN) + brute-force for SQLite (asymmetric).**
`CREATE EXTENSION vector`, migrate `embedding` to `vector(dim)` (dim must be
pinned — undefined until a provider is chosen), HNSW/IVFFlat index, `<=>` ANN.
SQLite (sql.js WASM) categorically cannot load native `sqlite-vec`/`sqlite-vss` →
inherently asymmetric. Neon/Supabase generally support pgvector (unverified
live); self-hosted `postgres:16-alpine` does not (image change + deploy-doc
change). Effort: Medium-High.

## Recommendation

**Option A**, scoped narrowly to the retrieval mechanism (symmetric brute-force
union, both backends), so retrieval is already correct if/when a provider is
wired. Defer Option B (pgvector) as a scale-contingent follow-up (pinning a
vector dim before a provider exists risks a second migration). Provider wiring
(model choice, cost, batching, backfill of un-embedded rows) is a separate change.

## Risks

- No embedding provider exists to test end-to-end; verification relies on test fakes until one is wired.
- Option A's per-project embedding scan is unbounded — pick a bounded K, not a full scan.
- Backend inconsistency: PG positional-rank proxy vs SQLite real BM25; vector-only candidates (no lexical rank) need a symmetric convention (treat as 0, mirroring "no embedding" → cosine 0).
- Dedup-by-id required across both candidate sources before scoring.
- `last_accessed_at` touched only for final limit-capped returned rows — preserve through the merge.
- Empty-query and no-provider fallbacks must stay byte-for-byte identical.
- pgvector availability asserted from config/docs, not verified live.
- Self-hosted `postgres:16-alpine` lacks pgvector — Option B later expands blast radius into deploy.

## Next

sdd-propose — AFTER the orchestrator confirms with the user whether provider
wiring is in/out of scope. Recommended: Option A, mechanism-only; file pgvector
and provider-wiring as separate follow-ups.
