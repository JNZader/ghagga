# Verify Report: Semantic Memory Retrieval

**Mode**: full artifacts (proposal/specs/design/tasks present) — verifying merged code on `main` @ 468f4fb (all 8 PRs #293-#300 merged).

## Task Completeness

All 8 phases / 38 checklist items in `tasks.md` are checked `[x]`. Verified against real code:

| Phase | Status | Evidence |
|---|---|---|
| 1 — Provider abstraction | PASS | `packages/core/src/embed.ts` — `resolveEmbeddingConfig`, `createEmbeddingProvider`, registry with `none`/`openai-compatible`/`local`, `FakeEmbeddingProvider` |
| 2 — Schema | PASS | `packages/db/src/schema.ts:219,225` (`embeddingModel`/`embeddingDim`), `packages/db/drizzle/0001_clumsy_gressill.sql` (additive `ALTER TABLE ... ADD COLUMN`, nullable), SQLite `runIdempotentAlter` in `sqlite.ts:282-285` |
| 3 — SQLite cosine union | PASS | `sqlite.ts:406-637` `_hybridSearch` — bounded K query, dimension/model guard, union+dedup, positional-rank keyword score, `last_accessed_at` scoped to final rows only |
| 4 — Postgres cosine union | PASS | `queries.ts:825-1012`, `postgres.ts:75-144` — mirrors SQLite; decay filter explicitly synced in the adapter (`postgres.ts:103-141`), matching D5 |
| 5 — Context wiring | PASS | server `apps/server/src/queues/review.ts:872-873`, CLI `apps/cli/src/lib/embedding.ts`, Action `apps/action/src/index.ts:101-123` (coerces `local`→`none` with warning) |
| 6 — Backfill | PASS | `packages/core/src/memory/backfill.ts` (idempotent, batched, resumable), CLI `apps/cli/src/commands/memory/backfill.ts`, server `apps/server/scripts/backfill-embeddings.ts`, standalone `packages/core/scripts/backfill-embeddings.ts` — none reachable from the Action |
| 7 — Local optional provider | PARTIAL (see CRITICAL below) | `LocalEmbeddingProvider` lazy-imports `@xenova/transformers`, throws-on-degrade (never zero vectors); Action `ncc` excludes it (`-e @xenova/transformers` in `apps/action/package.json:6`, asserted by `apps/action/src/build-config.test.ts`) — but task 7.1 ("add as optionalDependency") was NOT done as worded |
| 8 — Docs | PASS | `docs/configuration.md` + `docs/memory-system.md` cover config surface, recommended default, Action limitation, backfill usage |

## Runtime Evidence (executed, not just inspected)

- `pnpm --filter ghagga-core test -- --run` → 131 files / 3466 tests PASS
- `pnpm --filter ghagga-db test -- --run` → 4 files / 171 tests PASS
- `pnpm --filter @ghagga/server test -- --run` → 31 files / 654 tests PASS
- `pnpm --filter ghagga test -- --run` (CLI) → 42 files / 448 tests PASS (1 skipped, pre-existing)
- `pnpm --filter @ghagga/action test -- --run` → 10 files / 203 tests PASS
- `pnpm --filter ghagga-core build` → clean `tsc` build (dist refreshed)
- `tsc --noEmit` clean on `@ghagga/server`, `ghagga` (CLI), `@ghagga/action`

## Spec Compliance Matrix — `embedding-providers`

| Requirement | Status | Covering test/evidence |
|---|---|---|
| Provider Selection via Registry/Factory (default none / explicit / unknown→none+warn) | PASS | `embed.test.ts`, `embed.ts:87-124` |
| Local Provider is an Optional Dependency (installed / not installed / init throws) | **PARTIAL** | Behavior (lazy import, catch, degrade-to-none-at-search-layer via throw) is fully implemented and tested; the literal "MUST be declared as an optional dependency" clause is NOT met — see CRITICAL-1 |
| Action Bundle Excludes Local Provider | PASS | `apps/action/package.json:6` (`ncc -e @xenova/transformers`), `build-config.test.ts` asserts no dependency declaration + `-e` flag; `index.ts:101-118` coerces `local`→`none` |
| Batched Embedding Calls | PASS | `OpenAICompatibleEmbeddingProvider.embedBatch` issues one request for N inputs; `backfill.ts:105` calls `embedBatch` once per batch, never N `embed()` |
| Graceful Degradation on Provider/API Failure (search + save) | PASS | `sqlite.ts:516-526` (search), `_computeEmbeddingMeta` (save), `postgres.ts:161-175` (save), `queries.ts:909-924` (search) — all catch-and-continue, no throw to caller |
| Stored Embedding Metadata | PASS | `embedding_model`/`embedding_dim` persisted on every save path (SQLite + PG) |
| Dimension-Mismatch Read Guard | PASS | `isEmbeddingUsable` in both `sqlite.ts:533-540` and `queries.ts:949-954` — excludes mismatched rows from cosine set without error |

## Spec Compliance Matrix — `memory-storage` (R5 delta)

| Requirement | Status | Evidence |
|---|---|---|
| R5.1-R5.6 (unchanged keyword path) | PASS | untouched code paths, existing tests still green |
| R5.7 Semantic Candidate Union | PASS | symmetric bounded-K queries in both backends |
| R5.8 Union/Dedup/Re-rank | PASS | `merged` Map keyed by `id` in both backends, real keyword score kept on overlap |
| R5.9 Vector-only keyword-score 0 | PASS | explicit `keywordScore: 0` branch, both backends |
| R5.10 `last_accessed_at` scoped to final rows | PASS | SQLite touches `accessedIds` post-cap; PG's union path returns untouched pool, `PostgresMemoryStorage.searchObservations` decay-filters+caps+touches only survivors (`postgres.ts:136-141`) — deliberately more careful than a naive port |
| R5.11 No-provider byte-for-byte parity | PASS | SQLite `searchObservations` branches before any union code runs (`sqlite.ts:305-307`); PG `queries.ts:896-903` returns immediately on `!embedFn`; both have explicit "none-parity" golden tests (`sqlite.test.ts:1043`, `queries.test.ts:1248`) |
| Backfill of NULL-Embedding Observations | PASS | `backfill.ts`, idempotency via `listObservationsNeedingEmbedding` predicate (NULL or, with `--re-embed`, mismatched), resumable via `afterId` cursor |

## Design Coherence (D1-D8)

| Decision | Status |
|---|---|
| D1 — 2 providers (HTTP + local) | PASS |
| D2 — config surface, 3 contexts share `resolveEmbeddingConfig` | PASS |
| D3 — per-row metadata + read guard | PASS |
| D4 — bounded K=200, recency-ordered | PASS |
| D5 — unified positional-rank keyword score, PG `ts_rank`-as-proxy removed | PASS |
| D6 — backfill script, batched, resumable | PASS |
| D7 — lazy import + `optionalDependency` + ncc exclude | **PARTIAL** — lazy import and ncc exclude done; `optionalDependency` declaration deliberately NOT done (see CRITICAL-1) |
| D8 — `FakeEmbeddingProvider` | PASS |

## Issues

### CRITICAL-1: `@xenova/transformers` not declared as `optionalDependency` — contradicts spec text, design D7, and tasks.md 7.1

- **tasks.md task 7.1** reads "Add `@xenova/transformers` as an `optionalDependency` in `packages/core/package.json`" and is checked `[x]`.
- **spec (`embedding-providers/spec.md`, "Local Provider is an Optional Dependency")** states: "A local/embedded provider ... MUST be declared as an optional dependency, loaded lazily only when selected, and MUST NOT be a hard dependency of `packages/core`."
- **Actual code**: `packages/core/package.json` has no `optionalDependencies` field at all (verified: `rg optionalDependencies packages/core/package.json` → no match). This was a deliberate decision, not an oversight — `apps/action/src/build-config.test.ts:37-59` explicitly asserts `ghagga-core`'s `package.json` does **not** declare `@xenova/transformers` under `dependencies`/`devDependencies`/`optionalDependencies`, and `docs/configuration.md:83` documents the rationale: declaring it as `optionalDependencies` would still pull the package (and its "vulnerable transitive `protobufjs`") into every install via npm/pnpm's default optional-dependency resolution, so the team chose an **undeclared, user-installed peer** instead (`pnpm add @xenova/transformers` manually), with the same lazy-import/catch/degrade behavior.
- **Assessment**: the *behavioral* intent of the requirement — lazy load, never a hard dependency, graceful degradation on missing/failing package — is fully implemented and tested (all 3 scenarios pass: installed, not-installed, init-throws). Only the literal "declared as an optionalDependency in package.json" clause is unmet, and it's unmet by informed choice with a documented, defensible reason (npm/pnpm's `optionalDependencies` does NOT skip install by default — that would have been a worse outcome than the current design). No spec scenario tests package.json contents directly, so no scenario technically fails.
- **Recommendation**: this is a real deviation between written spec/design/tasks and shipped code. It should be resolved by *updating the spec/design language* (change "MUST be declared as an optional dependency" → "MUST NOT be a hard dependency; loaded lazily" and mark D7/task 7.1 as revised, documented in `docs/configuration.md:83`) rather than changing the code — the shipped approach is arguably safer for the median user. Flagging as CRITICAL per the hard rule ("unchecked/misrepresented task is always CRITICAL") because the tasks.md checkbox and design.md text currently misrepresent what shipped; downgrade to informational once spec/design/tasks text is reconciled with the actual (better) implementation.

### No other CRITICAL findings.

### WARNING-1: `EmbeddingProvider` interface has no `id`/model field; per-call `embeddingModel` threading

Both `SqliteMemoryStorage` and `PostgresMemoryStorage` accept an out-of-band `embeddingModel: string` constructor param (not sourced from the provider itself, since `EmbeddingProvider` only exposes `embed`/`embedBatch`/`dimension`) — every call site (`review.ts`, `embedding.ts`, `index.ts`, backfill scripts) must remember to pass `config.model` alongside the provider instance, or the read guard silently falls back to dimension-only matching (`sqlite.ts:536`, `postgres.ts` constructor doc). Verified all current call sites do thread it correctly, so this is not a live bug — but it's a fragile shape for future call sites to get wrong silently (dimension-only guard degrades gracefully, so a mistake would not crash, just weaken the model-mismatch guard). No spec requirement is violated. Non-blocking.

### SUGGESTION-1: `docs/configuration.md`/`design.md` D7 wording should be updated to match the shipped undeclared-peer approach

Purely a documentation-consistency nit tied to CRITICAL-1 — once that's reconciled this resolves itself.

## Final Verdict

**PASS WITH WARNINGS** (one CRITICAL is a documentation/tasks-accuracy gap, not a functional or spec-scenario failure — no test, scenario, or runtime behavior is broken; the shipped code is functionally equivalent-or-better than what was speced). Recommend resolving CRITICAL-1 by updating `tasks.md`/`design.md` text (not code) before archive, or explicitly accepting the deviation in the archive note.
