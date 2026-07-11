# Tasks: Semantic Memory Retrieval

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1100-1400 (provider factory ~250, HTTP provider ~120, local provider ~100, schema+migration ~60, SQLite union ~180, PG union ~180, 3 wiring sites ~120, backfill script ~150, tests ~300+, docs ~60) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 → PR2 → PR3 → PR4 → PR5 → PR6 → PR7 → PR8 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Provider abstraction: `resolveEmbeddingConfig`, factory, `FakeEmbeddingProvider`, unit tests | PR 1 | Base = main. No behavior change (nothing wired yet). ~250-350 lines. |
| 2 | Schema: `embedding_model`/`embedding_dim` columns + additive migration (PG + SQLite) | PR 2 | Base = PR 1. Nullable, additive only. ~60-100 lines. |
| 3 | SQLite cosine union + dedup + posRank + read guard + `none`-parity tests | PR 3 | Base = PR 2. Touches `packages/core/src/memory/sqlite.ts:257-515`. ~250-350 lines. |
| 4 | Postgres cosine union + dedup + posRank reconcile + decay sync + `none`-parity tests | PR 4 | Base = PR 3. Touches `packages/db/src/queries.ts:732-851`, `apps/server/src/memory/postgres.ts`. ~250-350 lines. |
| 5 | Context wiring: server (env), CLI (config), Action (secrets, HTTP-only) | PR 5 | Base = PR 4. Injects `createEmbeddingProvider` at 3 construction sites. ~150-200 lines. |
| 6 | Backfill script `packages/core/scripts/backfill-embeddings.ts` + CLI subcommand + server admin script + idempotency tests | PR 6 | Base = PR 5. ~200-250 lines. |
| 7 | Local Transformers.js provider (`optionalDependency`) + lazy import + ncc exclude for Action | PR 7 | Base = PR 6. ~150-200 lines. |
| 8 | Docs: config surface, recommended default, rollout/rollback, backfill usage | PR 8 | Base = PR 7. ~60-100 lines, docs only. |

Each slice keeps `none`-default parity as its own acceptance gate (see Phase 3/6/7 tasks below) — no slice may regress the keyword-only baseline before its own merge.

## Phase 1: Provider Abstraction (PR 1)

- [x] 1.1 Add `resolveEmbeddingConfig(env)` (Zod-parsed) to `packages/core/src/embed.ts`: `EMBEDDING_PROVIDER` (`none`|`openai-compatible`|`local`, default `none`), `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY` (optional), `EMBEDDING_DIMENSION`.
- [x] 1.2 Add `createEmbeddingProvider(config): EmbeddingProvider | null` factory in `packages/core/src/embed.ts` — registry keyed by `EMBEDDING_PROVIDER`; unknown id logs warning and falls back to `none` (spec: Unknown provider id).
- [x] 1.3 Implement OpenAI-compatible HTTP provider (`embed`, `embedBatch`, `dimension`) calling `POST {base}/embeddings`; wrap in try/catch per spec "Graceful Degradation on Provider/API Failure".
- [x] 1.4 Add `FakeEmbeddingProvider` (hash-of-tokens → deterministic fixed-dim unit vector) in `packages/core/src/embed.ts` or a test-utils module (design D8).
- [x] 1.5 Unit tests: `resolveEmbeddingConfig` defaults to `none`; unknown provider id falls back to `none` + warns; HTTP provider batches via `embedBatch` not N `embed` calls; embed failure caught and does not throw.

## Phase 2: Schema — Per-Row Embedding Metadata (PR 2)

- [x] 2.1 Add `embedding_model TEXT` + `embedding_dim INT` nullable columns to `packages/db/src/schema.ts:191-223` (`memoryObservations`).
- [x] 2.2 Generate additive Drizzle migration for the two new columns (PostgreSQL); confirm no destructive changes.
- [x] 2.3 Add equivalent nullable `embedding_model`/`embedding_dim` columns to the SQLite observations table (`packages/core/src/memory/sqlite.ts` schema/init) — mirror PG shape.
- [x] 2.4 Test: existing rows read back with `embedding_model`/`embedding_dim` = NULL after migration; no error.

## Phase 3: SQLite Cosine Union (PR 3)

- [x] 3.1 In `packages/core/src/memory/sqlite.ts:257-515`, add bounded cosine candidate query: project- (+type-) scoped, `embedding IS NOT NULL`, `ORDER BY last_accessed_at DESC LIMIT EMBEDDING_CANDIDATE_K` (default 200, env-configurable).
- [x] 3.2 Add dimension-mismatch read guard: skip row (cosine 0 / excluded from candidate set) when `row.embedding_dim !== provider.dimension` or `row.embedding_model !== active model` or length mismatch.
- [x] 3.3 Compute cosine similarity in JS over the guarded candidate set; take top `limit*5`.
- [x] 3.4 Union keyword candidates (`limit*5`) with cosine candidates, dedup by `id`; unified positional-rank keyword-score `1 - i/(n-1)` over merged lexical-rank order; vector-only candidates get keyword-score 0.
- [x] 3.5 Apply unchanged `finalScore = 0.7*cosineSim + 0.3*normalizedKeywordScore` → decay filter → `limit` cap; update `last_accessed_at` only for final returned rows.
- [x] 3.6 Persist `embedding_model`/`embedding_dim` alongside vector on save; on embed failure during save, persist NULL embedding + log warning, do not throw.
- [x] 3.7 Test (acceptance gate): with `none` provider, `searchObservations` output/order/`last_accessed_at` byte-for-byte identical to pre-change baseline (golden test using `FakeEmbeddingProvider` absent).
- [x] 3.8 Test: lexically-disjoint semantic match surfaces via cosine union; keyword+vector overlap dedups to one entry with real keyword score; mixed-dimension rows excluded from cosine set without error; partial-backfill mix (some NULL, some embedded) returns correctly via both paths.

## Phase 4: Postgres Cosine Union (PR 4)

- [x] 4.1 In `packages/db/src/queries.ts:732-851`, mirror the SQLite bounded cosine candidate query (project/type-scoped, `embedding IS NOT NULL`, `ORDER BY last_accessed_at DESC LIMIT K`) with dimension-guard.
- [x] 4.2 Replace/reconcile PG's `ts_rank`-based keyword score with the same positional-rank convention `1 - i/(n-1)` used by SQLite (design D5) — remove the prior ts_rank-as-proxy inconsistency.
- [x] 4.3 Union + dedup by `id`; apply `0.7*cosine + 0.3*posRank`; vector-only candidates get keyword-score 0.
- [x] 4.4 Sync `apps/server/src/memory/postgres.ts:56-98` decay filtering with the SQLite decay logic (spec: "decay filter MUST stay in sync").
- [x] 4.5 Persist `embedding_model`/`embedding_dim` on save; on embed failure, persist NULL embedding + warn, no throw.
- [x] 4.6 Test (acceptance gate): `none` provider ⇒ PG `searchObservations` output identical to pre-change baseline.
- [x] 4.7 Test: PG mirrors the same lexically-disjoint-recall, dedup, mixed-dimension, and partial-backfill scenarios as Phase 3, confirming symmetric SQLite/PG behavior with the same fake-provider dataset.

## Phase 5: Context Wiring (PR 5)

- [x] 5.1 Wire `resolveEmbeddingConfig(process.env)` + `createEmbeddingProvider` into the server memory construction site (env-driven).
- [x] 5.2 Wire the same resolver into the CLI memory construction site, merging config-file keys over env per design D2.
- [x] 5.3 Wire the Action's memory construction site to only ever resolve `none` or the OpenAI-compatible provider (never `local`), mapped from Action `inputs`/`secrets`.
- [x] 5.4 Test: each of the 3 sites resolves `none` when unconfigured and a concrete provider when configured; Action selecting `local` id resolves to `none` (or documented error), never attempts the excluded import.

## Phase 6: Backfill Script (PR 6)

- [ ] 6.1 Create `packages/core/scripts/backfill-embeddings.ts`: iterate rows where `embedding IS NULL OR embedding_model != active`, batch by `id` (default 100), call `embedBatch`, `UPDATE` with embedding + `embedding_model` + `embedding_dim`, commit per batch.
- [ ] 6.2 Add flags: `--batch`, `--limit`, `--re-embed` (forces model-mismatch rows); add inter-batch delay + max-rows cap for rate/cost control.
- [ ] 6.3 Add `pnpm ghagga memory backfill` CLI subcommand invoking the script; add a server admin script entry point; explicitly exclude from the Action.
- [ ] 6.4 Test: backfill populates all NULL-embedding rows and persists provider id + dimension; re-run is idempotent (already-matching rows skipped, only NULL/mismatched rows re-embedded); resumable after simulated mid-batch failure.

## Phase 7: Local Optional Provider (PR 7)

- [ ] 7.1 Add `@xenova/transformers` as an `optionalDependency` in `packages/core/package.json`.
- [ ] 7.2 Implement local provider in `packages/core/src/embed.ts` (recommended default `Xenova/all-MiniLM-L6-v2`, 384 dims) behind `await import('@xenova/transformers')` inside a try/catch; on import or init failure, log + degrade factory result to `none`.
- [ ] 7.3 Update `@vercel/ncc` externals/excludes config for the Action build to exclude `@xenova/transformers`; confirm Action factory path never selects `local`.
- [ ] 7.4 Test: local provider selected + installed ⇒ working provider; selected + not installed (mocked import failure) ⇒ degrades to `none`, warns, no throw; selected + installed but init throws ⇒ same degrade behavior; Action bundle build excludes the package (bundle-content assertion or ncc config test).

## Phase 8: Documentation (PR 8)

- [ ] 8.1 Document `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY`/`EMBEDDING_DIMENSION`/`EMBEDDING_CANDIDATE_K` config surface per context (server env, CLI config, Action inputs/secrets).
- [ ] 8.2 Document recommended default (local `Xenova/all-MiniLM-L6-v2`, 384 dims, free) vs API option (`text-embedding-3-small`, 1536 dims), and that Action always uses HTTP or `none`.
- [ ] 8.3 Document backfill usage (`pnpm ghagga memory backfill`, flags, `--re-embed` for provider swap) and rollback plan (set `EMBEDDING_PROVIDER=none`, no migration reversal needed).
