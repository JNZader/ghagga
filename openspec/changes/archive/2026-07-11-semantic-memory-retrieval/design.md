# Design: Semantic Memory Retrieval

## Technical Approach

Implement Option A (bounded brute-force cosine union, symmetric on both backends) plus real provider wiring. A config-driven factory resolves an `EmbeddingProvider` (`none` default). Retrieval unions a bounded cosine candidate set with the existing keyword candidates, dedups by `id`, then feeds the unchanged 0.7/0.3 re-rank + decay + limit pipeline. Ship two provider implementations (one HTTP, one optional local), backfill NULL rows, and guard mixed dimensions on read. `none` keeps behavior byte-for-byte identical (spec R5).

## Architecture Decisions

### D1 — Ship 2 providers, not per-vendor clients
**Choice**: One generic **OpenAI-compatible HTTP provider** (`base URL + model + optional key`) + one optional **local Transformers.js provider** (`@xenova/transformers`, undeclared user-installed peer — see D7).
**Rejected**: Separate Voyage/OpenAI/Cohere SDK clients (N deps, N maintenance surfaces, bundle bloat).
**Rationale**: The `/v1/embeddings` contract is a de-facto standard — one client covers OpenAI, Voyage-compatible endpoints, and free self-hosted servers (Ollama, LM Studio, text-embeddings-inference) by URL alone. Satisfies "agnostic + free + local" with 1 network impl + 1 offline impl.

### D2 — Config surface (env → all 3 contexts)
| Var | Values / example |
|-----|------------------|
| `EMBEDDING_PROVIDER` | `none` (default) \| `openai-compatible` \| `local` |
| `EMBEDDING_MODEL` | e.g. `text-embedding-3-small`, `Xenova/all-MiniLM-L6-v2` |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` \| `http://localhost:11434/v1` |
| `EMBEDDING_API_KEY` | optional (omitted for local/self-hosted) |
| `EMBEDDING_DIMENSION` | int; asserted against provider's reported dim |

**Mapping**: server reads `process.env`; CLI merges the same keys from its config file over env; Action exposes matching `inputs`/`secrets` mapped to the same env names. One `resolveEmbeddingConfig(env)` (Zod-parsed) in `packages/core` feeds `createEmbeddingProvider(config)` at every construction site. `none`/unset → factory returns `null` → current path.

### D3 — Dimension/provider metadata + read guard
**Choice**: Store `embedding_model TEXT` + `embedding_dim INT` **per row** (columns, not a config singleton) alongside the vector; both NULL when unembedded. Read guard: skip cosine (treat as 0) when `row.embedding_dim !== provider.dimension` OR `model !== active model` OR length mismatch — mirrors existing "no embedding → cosine 0".
**Rejected**: Single metadata/config row (can't represent a half-migrated table; races on swap).
**Rationale**: Per-row metadata makes a provider/dim swap safe *and* observable — old rows silently degrade to keyword-only until re-embedded. Documented path: swap config → run backfill in re-embed mode (D6).

### D4 — Bounded cosine candidate K
**Choice**: `EMBEDDING_CANDIDATE_K` default **200**, per project (+type filter when set). Query: `SELECT id,…,embedding WHERE project=? [AND type=?] AND embedding IS NOT NULL ORDER BY last_accessed_at DESC LIMIT K`. Cosine top-`limit*5` of that set, then UNION by `id` with the keyword `limit*5` set, dedup, score all in the shared pipeline.
**Rationale**: `ORDER BY last_accessed_at` makes the bound recency-biased and deterministic; 200 caps per-query JS cosine cost while covering realistic per-project memory sizes. Configurable for large installs; pgvector deferred replaces this scan later.

### D5 — Unified keyword-score convention
**Choice**: Both backends use a **normalized positional rank** `1 - i/(n-1)` over the merged candidate list ordered by native lexical rank (BM25 for SQLite, `ts_rank` for PG). **Vector-only candidates** (no lexical match) get keyword-score **0**.
**Rejected**: Keeping SQLite's raw normalized BM25 (not comparable to PG's proxy; two conventions).
**Rationale**: Positional rank is the only score both engines can produce identically post-union; converges the pre-existing PG/SQLite inconsistency onto one rule. Vector-only = 0 mirrors "no embedding → cosine 0" symmetrically.

### D6 — Backfill mechanism
**Choice**: Standalone script `packages/core/scripts/backfill-embeddings.ts`, invoked per context (`pnpm ghagga memory backfill` CLI subcommand; server admin script; not in Action). Iterates `embedding IS NULL OR embedding_model != active` rows in `id` batches (default 100), `embedBatch`, `UPDATE`; commits per batch → resumable/idempotent (re-run skips populated-matching rows). Flags: `--batch`, `--limit`, `--re-embed` (forces model mismatch rows). Rate/cost-aware: inter-batch delay + max-rows cap.
**Rationale**: Idempotency via the same read guard predicate; batching bounds API cost and enables resume after failure.

### D7 — Optional dep + Action bundle
**Choice**: Local provider uses lazy `await import('@xenova/transformers')` inside the factory branch, wrapped in try/catch → on absence log + fall back to `none`. `@xenova/transformers` is an **undeclared, user-installed optional peer** (`pnpm add @xenova/transformers`), NOT an `optionalDependency` — declaring it would force-install a heavy ML lib + its vulnerable transitive `protobufjs` for everyone (this surfaced as a `pnpm audit --prod` failure during merge). `ncc` config for the Action externals/excludes it, and the Action never selects `local` (HTTP or `none` only).
**Rationale**: Keeps the Action bundle lean; CLI/server get local embeddings when installed; missing dep never crashes.

### D8 — Testing with a deterministic fake provider
**Choice**: `FakeEmbeddingProvider` (hash-of-tokens → fixed-dim unit vector) for deterministic cosine. Cover: union surfaces a lexically-disjoint semantic match; dedup (same `id` from both sources scored once); mixed-dim guard (wrong-dim row → cosine 0, not crash); `none` → identical to keyword baseline (golden); backfill idempotency; provider-swap degradation.

## Data Flow

```
config/env ─→ createEmbeddingProvider() ─→ provider | null
                                              │
query ─┬─ keyword candidates (FTS5/tsquery, limit*5) ─┐
       └─ cosine candidates (bounded K, top limit*5) ─┴─→ UNION by id / dedup
                                                          │
                                          0.7*cosine + 0.3*posRank → decay → limit
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/embed.ts` | Modify | Factory + OpenAI-compat + local providers, config resolver |
| `packages/core/src/memory/sqlite.ts:257-515` | Modify | Cosine union + dedup; metadata columns |
| `packages/db/src/queries.ts:732-851` | Modify | Same union; posRank convention |
| `packages/db/src/schema.ts:191-223` | Modify | `embedding_model`, `embedding_dim` columns |
| `apps/server/src/memory/postgres.ts` | Modify | Wire provider; keep decay in sync |
| `apps/{server,cli,action}` sites | Modify | Resolve+inject provider per context |
| `packages/core/scripts/backfill-embeddings.ts` | Create | Batched idempotent backfill |

## Interfaces

Reuse existing `EmbeddingProvider` (`embed`, `embedBatch`, `dimension`) + `EmbeddingProviderFactory`. Add `resolveEmbeddingConfig(env)` and `createEmbeddingProvider(config): EmbeddingProvider | null`.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | union/dedup, mixed-dim guard, posRank, `none` parity | `FakeEmbeddingProvider`, golden diff |
| Integration | backfill idempotency/resume, PG+SQLite symmetry | temp DB per backend |
| E2E | lexically-disjoint recall | fake provider both backends |

## Migration / Rollout

Additive columns (nullable) → no destructive migration. Ship with `none` default; enable per context by config. Provider/dim swap = config change + backfill `--re-embed`. Rollback: set `none`.

## Open Questions (RATIFIED by user)

- [x] **Recommended default (documented)**: `Xenova/all-MiniLM-L6-v2` (384, local, free) is the primary recommended setup when semantics is enabled. The system default stays `none`; the Action (no local provider) falls back to the OpenAI-compatible HTTP provider. `text-embedding-3-small` (1536) is documented as the API option.
- [x] **Candidate K default = 200** — accepted (configurable via `EMBEDDING_CANDIDATE_K`).
- [x] **OpenAI-compatible client is the sole HTTP provider** — confirmed; Voyage/others enter via `EMBEDDING_BASE_URL`, no per-vendor SDK.
