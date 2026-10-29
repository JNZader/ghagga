# Proposal: SQLite Memory — Bring System Memory to CLI & Action

## Intent

GHAGGA's system memory makes reviews progressively smarter by storing patterns, decisions, and learnings from past reviews and injecting them as context into future reviews. Currently memory **only works in SaaS mode** because it depends on PostgreSQL (via `ghagga-db` / Drizzle ORM). The CLI passes `db: undefined` and `enableMemory: false`, and the Action does the same — meaning repeated reviews of the same project never build institutional knowledge.

This change introduces an abstract `MemoryStorage` interface in `packages/core` with two adapters: `SqliteMemoryStorage` (using sql.js, a pure WASM SQLite) for CLI and Action, and `PostgresMemoryStorage` for SaaS (wrapping existing `ghagga-db` query functions). This decouples `packages/core` from `ghagga-db` entirely and enables memory in all three distribution modes.

## Scope

### In Scope

- **`MemoryStorage` interface** in `packages/core/src/types.ts` — abstract contract covering all memory operations currently performed by `search.ts` and `persist.ts` (search, save observation, create/end session).
- **`SqliteMemoryStorage` adapter** in `packages/core/src/memory/sqlite.ts` — implements `MemoryStorage` using sql.js (pure WASM, zero native dependencies). Uses FTS5 for full-text search, matching the current PostgreSQL tsvector-based search semantics.
- **`PostgresMemoryStorage` adapter** in `apps/server/src/memory/postgres.ts` — wraps existing `ghagga-db` functions (`searchObservations`, `saveObservation`, `createMemorySession`, `endMemorySession`) behind the `MemoryStorage` interface.
- **Refactor `search.ts`** (`packages/core/src/memory/search.ts`) — replace direct `import { searchObservations } from 'ghagga-db'` with a call to `MemoryStorage.searchObservations()`. The `db: unknown` parameter becomes `storage: MemoryStorage`.
- **Refactor `persist.ts`** (`packages/core/src/memory/persist.ts`) — replace direct `import { saveObservation, createMemorySession, endMemorySession } from 'ghagga-db'` with calls to the `MemoryStorage` interface.
- **Refactor `pipeline.ts`** (`packages/core/src/pipeline.ts`) — replace `input.db` (typed `unknown`) with `input.memoryStorage` (typed `MemoryStorage | undefined`). Update `searchMemorySafe` and the persist call in step 8 to use the interface.
- **Update `ReviewInput`** in `packages/core/src/types.ts` — replace `db?: unknown` with `memoryStorage?: MemoryStorage`.
- **Remove `ghagga-db` dependency** from `packages/core/package.json` — core should have no knowledge of PostgreSQL/Drizzle.
- **Enable memory in CLI** (`apps/cli/src/commands/review.ts`) — create `SqliteMemoryStorage` with db file at `~/.config/ghagga/memory.db`, pass it as `memoryStorage`, set `enableMemory: true`, and derive the project identifier from `git remote get-url origin` instead of hardcoding `"local/review"`.
- **Enable memory in Action** (`apps/action/src/index.ts`) — create `SqliteMemoryStorage` with db file at `/tmp/ghagga-memory.db`, use `@actions/cache` with key `ghagga-memory-{owner/repo}` to persist/restore the file between runs, pass as `memoryStorage`, set `enableMemory: true`.
- **Update SaaS server** (`apps/server/`) — create `PostgresMemoryStorage` wrapping the existing Drizzle DB instance and pass it as `memoryStorage` instead of `db`.

### Out of Scope

- **Memory management UI/commands** (list, inspect, clear, prune observations) — planned as a separate `memory-management` change.
- **Cross-project memory sharing** — each project has isolated memory. Future feature.
- **Memory encryption at rest** for CLI/Action — the SQLite file is stored in plaintext. Privacy stripping (`privacy.ts`) already removes secrets before persisting.
- **Porter stemmer / advanced tokenizers** for FTS5 — default tokenizer is sufficient for keyword-based search of code review observations.
- **Memory in the 1-click deploy mode** — uses the same PostgreSQL path as SaaS, no changes needed.

## Approach

### Architecture: Abstract Interface, Adapters Elsewhere

```
packages/core/src/types.ts        → MemoryStorage interface
packages/core/src/memory/sqlite.ts → SqliteMemoryStorage (sql.js + FTS5)
apps/server/src/memory/postgres.ts → PostgresMemoryStorage (wraps ghagga-db)
```

The core pipeline depends only on the `MemoryStorage` interface. Each distribution mode provides the appropriate adapter:

| Mode   | Adapter                 | Storage                                 | Persistence                   |
| ------ | ----------------------- | --------------------------------------- | ----------------------------- |
| SaaS   | `PostgresMemoryStorage` | PostgreSQL (existing schema, unchanged) | Always available              |
| CLI    | `SqliteMemoryStorage`   | `~/.config/ghagga/memory.db`            | Local filesystem              |
| Action | `SqliteMemoryStorage`   | `/tmp/ghagga-memory.db`                 | `@actions/cache` between runs |

### MemoryStorage Interface

```typescript
export interface MemoryStorage {
  searchObservations(
    project: string,
    query: string,
    options?: { limit?: number; type?: string },
  ): Promise<MemoryObservationRow[]>;

  saveObservation(data: {
    sessionId?: number;
    project: string;
    type: string;
    title: string;
    content: string;
    topicKey?: string;
    filePaths?: string[];
  }): Promise<MemoryObservationRow>;

  createSession(data: { project: string; prNumber?: number }): Promise<{ id: number }>;

  endSession(sessionId: number, summary: string): Promise<void>;

  close(): Promise<void>;
}

export interface MemoryObservationRow {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
}
```

### SQLite Schema (sql.js + FTS5)

```sql
CREATE TABLE IF NOT EXISTS memory_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  pr_number INTEGER,
  summary TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES memory_sessions(id),
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  topic_key TEXT,
  file_paths TEXT DEFAULT '[]',  -- JSON array
  content_hash TEXT,
  revision_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_obs_project ON memory_observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_topic_key ON memory_observations(topic_key);
CREATE INDEX IF NOT EXISTS idx_obs_content_hash ON memory_observations(content_hash);

-- FTS5 virtual table (replaces PostgreSQL tsvector)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts
  USING fts5(title, content, content='memory_observations', content_rowid='id');

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO memory_observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
```

### Key Technical Decisions

1. **sql.js over better-sqlite3**: sql.js is pure WASM with zero native dependencies. better-sqlite3 requires native compilation and breaks with ncc bundling (which the Action uses). sql.js bundles cleanly into a single file.

2. **FTS5 with default tokenizer**: PostgreSQL uses `tsvector` with the `english` dictionary (includes stemming). FTS5's default `unicode61` tokenizer does not stem, but for our use case (keyword matching of code review observations like "auth", "pool", "config"), exact keyword matching is sufficient. Porter stemmer adds complexity and dependency without meaningful benefit for this domain.

3. **Content dedup logic ported from PostgreSQL**: The 15-minute dedup window (`contentHash` + timestamp check) and `topicKey` upsert logic from `packages/db/src/queries.ts:370-441` are reimplemented in `SqliteMemoryStorage` using equivalent SQLite queries. SQLite supports `RETURNING` since 3.35+ and sql.js ships SQLite 3.46+.

4. **CLI project identifier from git remote**: Currently `review.ts:95` hardcodes `repoFullName: 'local/review'`. This change derives it from `git remote get-url origin`, normalizing to `owner/repo` format (strips `.git` suffix and host). Falls back to `"local/unknown"` if no remote exists.

5. **Action cache strategy**: `@actions/cache` with key `ghagga-memory-{owner/repo}` and restore key `ghagga-memory-{owner/repo}`. The SQLite file is small (~500KB/year per active repo). Cache is per-repo, so different repos don't share memory. Race condition on concurrent PRs: `@actions/cache` is immutable per key, so the first run to finish wins. Subsequent runs in the same cache window reuse the same snapshot. This is acceptable — a few missed observations are preferable to cache corruption.

## Affected Areas

| Area                                   | Impact   | Description                                                                                                                                                                       |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`           | Modified | Add `MemoryStorage` interface, `MemoryObservationRow` type. Replace `db?: unknown` with `memoryStorage?: MemoryStorage` on `ReviewInput`.                                         |
| `packages/core/src/memory/search.ts`   | Modified | Replace `import { searchObservations } from 'ghagga-db'` with `MemoryStorage.searchObservations()`. Change `db: unknown` parameter to `storage: MemoryStorage`.                   |
| `packages/core/src/memory/persist.ts`  | Modified | Replace `import { saveObservation, createMemorySession, endMemorySession } from 'ghagga-db'` with `MemoryStorage` method calls. Change `db: unknown` to `storage: MemoryStorage`. |
| `packages/core/src/memory/sqlite.ts`   | New      | `SqliteMemoryStorage` class using sql.js. Schema init, FTS5, dedup, topic-key upsert.                                                                                             |
| `packages/core/src/pipeline.ts`        | Modified | Replace `input.db` references with `input.memoryStorage`. Update `searchMemorySafe` and persist call.                                                                             |
| `packages/core/package.json`           | Modified | Remove `"ghagga-db": "workspace:^"` dependency. Add `"sql.js": "^1.11.0"`.                                                                                                        |
| `apps/server/src/memory/postgres.ts`   | New      | `PostgresMemoryStorage` adapter wrapping existing `ghagga-db` functions.                                                                                                          |
| `apps/server/` (webhook, inngest, api) | Modified | Replace `db: dbInstance` with `memoryStorage: new PostgresMemoryStorage(db)` when calling the pipeline.                                                                           |
| `apps/cli/src/commands/review.ts`      | Modified | Create `SqliteMemoryStorage` at `~/.config/ghagga/memory.db`, set `enableMemory: true`, derive `repoFullName` from git remote.                                                    |
| `apps/action/src/index.ts`             | Modified | Create `SqliteMemoryStorage` at `/tmp/ghagga-memory.db`, use `@actions/cache` for persistence, set `enableMemory: true`.                                                          |
| `apps/action/package.json`             | Modified | Add `"sql.js": "^1.11.0"` dependency (already has `@actions/cache`).                                                                                                              |

## Risks

| Risk                                                  | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sql.js WASM bundling with ncc                         | Medium     | High   | The Action uses `@vercel/ncc` to bundle. sql.js WASM binary (~1MB) must be included as an asset. Test ncc build early in implementation. If ncc can't bundle the WASM, load it from a sibling file via `locateFile` option.                                                              |
| FTS5 search quality parity with PostgreSQL tsvector   | Low        | Medium | PostgreSQL `english` dictionary does stemming (e.g., "running" matches "run"). FTS5 default tokenizer does not. For code review observation keywords, this is acceptable. If needed later, FTS5 supports the `porter` tokenizer as an opt-in.                                            |
| Action cache race conditions on concurrent PRs        | Medium     | Low    | `@actions/cache` keys are immutable — first writer wins. Subsequent concurrent PRs within the same cache window read a slightly stale snapshot. This is acceptable: at worst, a few observations from one PR won't be visible to a concurrent PR until the next run. No data corruption. |
| Breaking change to `ReviewInput` (db → memoryStorage) | Low        | Medium | The `apps/server` is the only consumer that passes `db`. The change is a coordinated rename across the monorepo. No external consumers — `ghagga-core` is published but `db` field was typed `unknown` and documented as internal.                                                       |
| sql.js memory usage on large memory DBs               | Very Low   | Low    | At ~500KB/year per repo, even a very active repo won't exceed a few MB. sql.js loads the entire DB into memory, which is fine for this scale.                                                                                                                                            |

## Rollback Plan

1. **Core changes are additive**: The `MemoryStorage` interface is new. The `SqliteMemoryStorage` adapter is a new file. If issues arise, revert the interface change and restore direct `ghagga-db` imports in `search.ts` and `persist.ts`.
2. **CLI and Action memory is opt-in by default**: If SQLite initialization fails, `SqliteMemoryStorage.create()` returns `undefined` and the pipeline gracefully degrades (existing behavior — `memoryStorage: undefined` means memory is skipped).
3. **SaaS path is a thin wrapper**: `PostgresMemoryStorage` delegates to the same `ghagga-db` functions. If the adapter has bugs, the fix is in the adapter, not in the DB layer.
4. **git revert scope**: All changes are in one feature branch. A single `git revert` of the merge commit restores full previous behavior.

## Dependencies

- **sql.js** (`^1.11.0`): Pure WASM SQLite. MIT licensed. Stable, well-maintained, 5k+ GitHub stars. Used by Observable, Datasette, and many others.
- **`@actions/cache`**: Already a dependency of `apps/action`. No new dependency for cache support.
- **Existing `ghagga-db` functions**: `searchObservations`, `saveObservation`, `createMemorySession`, `endMemorySession` — unchanged. `PostgresMemoryStorage` wraps them.

## Success Criteria

- [ ] `MemoryStorage` interface defined in `packages/core/src/types.ts` with search, save, session, and close methods
- [ ] `SqliteMemoryStorage` passes unit tests covering: schema init, save + dedup, topic-key upsert, FTS5 search, session lifecycle
- [ ] `PostgresMemoryStorage` wraps existing `ghagga-db` functions and passes integration tests
- [ ] `packages/core/package.json` has no `ghagga-db` dependency
- [ ] CLI review with `--verbose` shows memory search results from `~/.config/ghagga/memory.db`
- [ ] CLI memory persists between runs: first run saves observations, second run retrieves them
- [ ] Action memory persists between runs via `@actions/cache` (verified in test workflow)
- [ ] SaaS memory continues to work unchanged (PostgreSQL path through `PostgresMemoryStorage`)
- [ ] `reviewPipeline` works with `memoryStorage: undefined` (graceful degradation, no regressions)
- [ ] ncc bundle of the Action succeeds with sql.js WASM included
