# Proposal: Semantic Memory Retrieval

## Intent

Memory search is semantic *re-ranking of a keyword candidate set*, not true semantic retrieval (MEM-HYBRID-006). Worse, exploration proved the semantic path is **DORMANT**: no concrete `EmbeddingProvider` is wired in any of the 4 distribution modes, so `searchObservations` always runs keyword-only. This change makes semantic search **actually work** end-to-end: ship pluggable providers, wire them per context, backfill history, and add true lexically-disjoint retrieval. A "credential exposure" note becomes retrievable by "secret leakage".

## Scope

### In Scope
1. **Provider-agnostic architecture** — concrete providers behind the existing `EmbeddingProvider` interface (`packages/core/src/embed.ts`), selected by config/env via a registry/factory. Pluggable: any API provider, a free one, and a local one.
2. **Local/embedded option** (e.g. Transformers.js) as an **optional dependency** — available in CLI/server, never bundled into the Action ncc build.
3. **All 3 contexts live** — server (env), CLI (config), Action (secret). Action uses a light API client.
4. **Backfill** — one-time job re-embedding all NULL-embedding observations so semantic works over full history from activation.
5. **Retrieval = Option A** — bounded brute-force cosine candidate source (JS, symmetric on both backends), UNIONed + deduped by `id` with keyword candidates, feeding the existing 0.7/0.3 re-rank + decay + limit pipeline. Bounded K, not a full scan.
6. **Graceful degradation** — no provider (`none` default) ⇒ behavior byte-for-byte identical to today (keyword-only).

### Out of Scope (follow-ups)
- **pgvector / real ANN for Postgres** — scale-contingent; deferred (pinning a vector dim pre-scale risks a second migration).
- **Vote/consensus ranking changes** beyond what retrieval needs.

## Capabilities

### New Capabilities
- `embedding-providers`: provider registry/factory, config-driven selection, optional-dep local provider, per-context key/config surface, dimension-consistency contract.

### Modified Capabilities
- `memory-storage`: R5 search extended — semantic candidate union (Option A), backfill of NULL embeddings, graceful `none` degradation, reconcile PG positional-rank proxy vs SQLite BM25, symmetric zero convention for vector-only (no-lexical-rank) candidates.

## Approach

Factory resolves provider from config/env (`none` default). Both backends gain a bounded cosine candidate source unioned/deduped with keyword candidates before the unchanged re-rank/decay pipeline. Vector-only candidates use keyword-score 0 (mirrors "no embedding" → cosine 0). Backfill is a standalone script. Local provider is a lazy optional import guarded so the Action bundle stays lean.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/core/src/embed.ts` | Modified | Provider registry/factory; concrete providers |
| `packages/core/src/memory/sqlite.ts:257-515` | Modified | Cosine candidate union + dedup |
| `packages/db/src/queries.ts:732-851` | Modified | Same union; reconcile rank proxy |
| `apps/server/src/memory/postgres.ts:56-98` | Modified | Keep decay filter in sync |
| `apps/{server,cli,action}` construction sites | Modified | Wire provider per context |
| backfill script | New | Re-embed NULL rows |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Dimension mismatch across models (embeddings incompatible) | High | Store provider+dim metadata; provider/dim change ⇒ mandatory re-embed; guard on read |
| Optional-dep load failure | Med | Lazy import + fallback to `none`/keyword |
| Action bundle bloat | Med | Local dep excluded from ncc; Action uses API client only |
| Embedding API cost | Med | Batch embed; bounded backfill; `none` default |
| Unbounded per-project cosine scan | Med | Bounded candidate K |

## Rollback Plan

Set provider config to `none` — restores byte-for-byte keyword-only behavior instantly. Retrieval union code is inert without a provider. No migration to reverse (embeddings stay as harmless NULL/populated columns).

## Dependencies

- Chosen embedding API provider account/key (per context).
- Optional local package (e.g. `@xenova/transformers`) as optionalDependency.

## Success Criteria

- [ ] Lexically-disjoint query retrieves a semantically-close observation.
- [ ] `none` provider ⇒ output identical to current keyword path.
- [ ] Provider swappable via config across server, CLI, Action.
- [ ] Backfill populates all previously-NULL embeddings.
- [ ] Action bundle excludes the local embedding dependency.
