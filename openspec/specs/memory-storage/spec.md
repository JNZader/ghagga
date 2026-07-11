# Spec: Memory Storage

> **Domain**: Memory  
> **Change**: `sqlite-memory`  
> **Type**: FULL (new domain — no prior main spec)  
> **Status**: Draft  

## Overview

This specification defines a storage-agnostic memory subsystem for GHAGGA. Memory enables progressive review intelligence by persisting observations from past reviews and injecting relevant context into future reviews. Today memory only works in SaaS mode (PostgreSQL via `ghagga-db`). This spec introduces an abstract `MemoryStorage` interface with two implementations — SQLite (via sql.js) for CLI and Action, and PostgreSQL for SaaS — and decouples `packages/core` from `ghagga-db` entirely.

---

## Requirements

### R1: MemoryStorage Interface

The system MUST define a `MemoryStorage` interface in `packages/core/src/types.ts` with the following method signatures:

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

  createSession(data: {
    project: string;
    prNumber?: number;
  }): Promise<{ id: number }>;

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

All consumers of memory operations (currently `packages/core/src/memory/search.ts` and `packages/core/src/memory/persist.ts`) MUST call methods on this interface instead of importing functions from `ghagga-db`.

The `close()` method MUST be called when the consumer is done with the storage instance. For SQLite this flushes to disk and frees WASM memory; for PostgreSQL it is a no-op.

### R2: ReviewInput Type Update

`ReviewInput` in `packages/core/src/types.ts` MUST replace the field:

```typescript
db?: unknown;
```

with:

```typescript
memoryStorage?: MemoryStorage;
```

The field MUST be typed as `MemoryStorage | undefined`. The old `db` field MUST be removed. All call sites (server, CLI, Action) MUST be updated to use the new field name.

### R3: SqliteMemoryStorage Implementation

The system MUST provide a `SqliteMemoryStorage` class in `packages/core/src/memory/sqlite.ts` that implements `MemoryStorage` using sql.js (pure WASM SQLite, `^1.11.0`).

#### R3.1: Schema Initialization

On construction, `SqliteMemoryStorage` MUST create the following tables if they do not exist:

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
  file_paths TEXT DEFAULT '[]',
  content_hash TEXT,
  revision_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_obs_project ON memory_observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_topic_key ON memory_observations(topic_key);
CREATE INDEX IF NOT EXISTS idx_obs_content_hash ON memory_observations(content_hash);
```

#### R3.2: FTS5 Virtual Table

`SqliteMemoryStorage` MUST create an FTS5 virtual table for full-text search:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts
  USING fts5(title, content, content='memory_observations', content_rowid='id');
```

It MUST create triggers to keep the FTS index in sync with the base table:

```sql
CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO memory_observations_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;
```

#### R3.3: Content-Hash Deduplication

`saveObservation` MUST compute a SHA-256 content hash from `"${type}:${title}:${content}"` (matching the PostgreSQL implementation in `packages/db/src/queries.ts:364-366`). If an observation with the same `contentHash` AND `project` exists within a 15-minute rolling window, the method MUST return the existing row without inserting a duplicate.

#### R3.4: TopicKey Upsert

When `topicKey` is provided and a row with the same `topicKey` AND `project` already exists, `saveObservation` MUST update the existing row's `content`, `title`, `contentHash`, `filePaths`, and `updatedAt`, and MUST increment `revisionCount` by 1. It MUST return the updated row.

#### R3.5: RETURNING Clause

All INSERT and UPDATE operations that return a `MemoryObservationRow` MUST use SQLite's `RETURNING` clause (available in sql.js since SQLite 3.35+; sql.js ships 3.46+).

#### R3.6: File Persistence

The constructor MUST accept a `filePath: string` parameter. On construction, if the file exists, it MUST be loaded into the sql.js in-memory database. The `close()` method MUST export the database bytes and write them to the provided `filePath`, creating parent directories as needed.

#### R3.7: Static Factory

`SqliteMemoryStorage` MUST expose a static async factory method:

```typescript
static async create(filePath: string): Promise<SqliteMemoryStorage>
```

This factory MUST handle WASM initialization (loading sql.js) and return a ready-to-use instance. If the file at `filePath` exists, it MUST load its contents. If the file does not exist, it MUST initialize an empty database with the full schema.

#### R3.8: file_paths Column Encoding

The `file_paths` column MUST store data as a JSON-encoded string (e.g., `'["src/auth.ts","lib/pool.ts"]'`). `saveObservation` MUST serialize the `filePaths` array to JSON before INSERT. `searchObservations` MUST deserialize it back to `string[] | null` in the returned `MemoryObservationRow`.

### R4: PostgresMemoryStorage Implementation

The system MUST provide a `PostgresMemoryStorage` class in `apps/server/src/memory/postgres.ts` that implements the `MemoryStorage` interface by wrapping existing `ghagga-db` query functions:

| Interface Method | Delegates To |
|---|---|
| `searchObservations` | `ghagga-db.searchObservations` |
| `saveObservation` | `ghagga-db.saveObservation` |
| `createSession` | `ghagga-db.createMemorySession` |
| `endSession` | `ghagga-db.endMemorySession` |
| `close` | No-op (PostgreSQL connection is managed externally) |

The constructor MUST accept the Drizzle `Database` instance (the existing `db` parameter used throughout the server).

The returned `MemoryObservationRow` MUST match the interface shape: `{ id, type, title, content, filePaths }`. The adapter MUST map from the full Drizzle row to this subset.

### R5: FTS5 Search Parity & Semantic Union

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

#### R5.7: Semantic Candidate Union

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

### R6: CLI Memory Integration

#### R6.1: Database Path

The CLI MUST create the SQLite database at the XDG-compliant path: `${XDG_CONFIG_HOME || ~/.config}/ghagga/memory.db`. It MUST use the `getConfigDir()` logic already present in `apps/cli/src/lib/config.ts` (which resolves `XDG_CONFIG_HOME`).

#### R6.2: Project Identifier

The CLI MUST derive the project identifier from `git remote get-url origin`, normalized to `owner/repo` format:
- Strip protocol prefix (`https://github.com/`, `git@github.com:`, etc.)
- Strip `.git` suffix
- Result: `"owner/repo"`

If `git remote get-url origin` fails (no remote), the CLI MUST fall back to `"local/unknown"`.

The current hardcoded `repoFullName: 'local/review'` at `apps/cli/src/commands/review.ts:95` MUST be replaced with this derived value.

#### R6.3: Pipeline Integration

The CLI MUST:
1. Create a `SqliteMemoryStorage` instance via `SqliteMemoryStorage.create(dbPath)`
2. Pass it as `memoryStorage` in the `ReviewInput`
3. Set `enableMemory: true` in `ReviewSettings`
4. Set `context.repoFullName` to the derived project identifier
5. Call `memoryStorage.close()` after the pipeline completes (to persist to disk)

#### R6.4: Opt-Out Flag

The CLI MUST support a `--no-memory` flag that disables memory. When set:
- `memoryStorage` MUST be `undefined`
- `enableMemory` MUST be `false`
- No SQLite database file MUST be created or opened

#### R6.5: ReviewOptions Update

The `ReviewOptions` interface in `apps/cli/src/commands/review.ts` MUST add a `memory: boolean` field (defaulting to `true`). The Commander.js option MUST be `--no-memory` (which sets `memory: false`).

#### R6.6: Memory Backend Selection

> **Origin**: Merged from `engram-adapter` delta spec (2026-03-07)

The CLI MUST support selecting the memory backend via:
1. `--memory-backend <backend>` CLI option on the `review` command
2. `GHAGGA_MEMORY_BACKEND` environment variable

Priority: CLI flag > environment variable > default (`sqlite`).

Valid values MUST be: `sqlite` (default), `engram`.

Invalid values MUST cause the CLI to exit with an error message listing valid backends.

#### Scenario: Select Engram backend via CLI flag

- GIVEN the user runs `ghagga review . --memory-backend engram`
- AND Engram is running at `http://localhost:7437`
- WHEN the review command initializes memory
- THEN `EngramMemoryStorage.create(...)` MUST be called
- AND the review MUST use the Engram adapter for all memory operations

#### Scenario: Select Engram backend via environment variable

- GIVEN `GHAGGA_MEMORY_BACKEND=engram` is set
- AND the user runs `ghagga review .` (no CLI flag)
- WHEN the review command initializes memory
- THEN `EngramMemoryStorage.create(...)` MUST be called

#### Scenario: CLI flag overrides environment variable

- GIVEN `GHAGGA_MEMORY_BACKEND=engram` is set
- AND the user runs `ghagga review . --memory-backend sqlite`
- WHEN the review command initializes memory
- THEN `SqliteMemoryStorage.create(...)` MUST be called (CLI flag wins)

#### Scenario: Invalid backend value

- GIVEN the user runs `ghagga review . --memory-backend redis`
- THEN the CLI MUST exit with code 1
- AND the error message MUST include the valid backends: `sqlite`, `engram`

#### Scenario: Default backend unchanged

- GIVEN no `--memory-backend` flag and no `GHAGGA_MEMORY_BACKEND` env var
- WHEN the review command initializes memory
- THEN `SqliteMemoryStorage.create(...)` MUST be called (existing behavior preserved)

#### R6.7: Engram Host Configuration

> **Origin**: Merged from `engram-adapter` delta spec (2026-03-07)

When the Engram backend is selected, the Engram server URL MUST be configurable via:
- `GHAGGA_ENGRAM_HOST` environment variable (default: `http://localhost:7437`)

#### Scenario: Custom Engram host

- GIVEN `GHAGGA_ENGRAM_HOST=http://192.168.1.100:7437` is set
- AND `--memory-backend engram` is used
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN `baseUrl` MUST be `http://192.168.1.100:7437`

#### Scenario: Default Engram host

- GIVEN `GHAGGA_ENGRAM_HOST` is not set
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN `baseUrl` MUST be `http://localhost:7437`

#### R6.8: Graceful Fallback to SQLite

> **Origin**: Merged from `engram-adapter` delta spec (2026-03-07)

When the Engram backend is selected but Engram is not running, the CLI MUST fall back to SQLite automatically.

The fallback MUST:
1. Log a warning about Engram unavailability
2. Log a message about falling back to SQLite
3. Create a `SqliteMemoryStorage` instance at the standard path
4. Proceed with the review using SQLite

The review MUST NOT fail due to Engram being unavailable.

#### Scenario: Engram selected but not running

- GIVEN `--memory-backend engram` is used
- AND Engram is not running (connection refused)
- WHEN the review command initializes memory
- THEN a warning MUST be logged: `[ghagga] Engram not available at http://localhost:7437: <error>`
- AND a message MUST be logged: `[ghagga] Falling back to SQLite memory`
- AND `SqliteMemoryStorage.create(...)` MUST be called
- AND the review MUST complete successfully using SQLite

#### Scenario: Engram selected but not running, --no-memory also set

- GIVEN `--memory-backend engram` and `--no-memory` are both used
- WHEN the review command processes options
- THEN `--no-memory` MUST take precedence
- AND no memory storage MUST be initialized (neither Engram nor SQLite)

### R7: Action Memory Integration

#### R7.1: Database Path

The Action MUST create the SQLite database at `/tmp/ghagga-memory.db`.

#### R7.2: Cache Strategy

The Action MUST use `@actions/cache` to persist the database file between workflow runs:
- **Cache key**: `ghagga-memory-{github.repository}` (e.g., `ghagga-memory-owner/repo`)
- **Cache path**: `/tmp/ghagga-memory.db`
- **Restore**: At the start of the Action, before creating `SqliteMemoryStorage`
- **Save**: After the review pipeline completes and `memoryStorage.close()` is called

#### R7.3: Pipeline Integration

The Action MUST:
1. Attempt to restore the cached database file
2. Create a `SqliteMemoryStorage` instance via `SqliteMemoryStorage.create('/tmp/ghagga-memory.db')`
3. Pass it as `memoryStorage` in the `ReviewInput`
4. Set `enableMemory: true` in `ReviewSettings`
5. After the pipeline completes, call `memoryStorage.close()`
6. Save the database file to cache

#### R7.4: Opt-Out Input

The Action MUST support an `enable-memory` input (default: `true`). When set to `false`:
- No cache restore or save MUST occur
- `memoryStorage` MUST be `undefined`
- `enableMemory` MUST be `false`

#### R7.5: Cache Eviction

If the cache has been evicted (7-day inactivity in GitHub Actions), the Action MUST start with a fresh empty database. This MUST NOT be treated as an error.

### R8: Pipeline Refactor

#### R8.1: search.ts Refactor

`packages/core/src/memory/search.ts` MUST:
- Remove `import { searchObservations } from 'ghagga-db'`
- Change the `searchMemoryForContext` signature from `(db: unknown, ...)` to `(storage: MemoryStorage, ...)`
- Call `storage.searchObservations(project, query, { limit: 3 })` instead of `searchObservations(db as ..., ...)`
- The `!db` null-guard becomes `!storage`

#### R8.2: persist.ts Refactor

`packages/core/src/memory/persist.ts` MUST:
- Remove `import { saveObservation, createMemorySession, endMemorySession } from 'ghagga-db'`
- Change the `persistReviewObservations` signature from `(db: unknown, ...)` to `(storage: MemoryStorage, ...)`
- Replace `createMemorySession(typedDb, ...)` with `storage.createSession(...)`
- Replace `saveObservation(typedDb, ...)` with `storage.saveObservation(...)`
- Replace `endMemorySession(typedDb, ...)` with `storage.endSession(...)`

#### R8.3: pipeline.ts Refactor

`packages/core/src/pipeline.ts` MUST:
- Replace `input.db` references with `input.memoryStorage`
- Update `searchMemorySafe` (line 365-386) to pass `input.memoryStorage` instead of `input.db` to `searchMemoryForContext`
- Update step 8 (line 256-269) to pass `input.memoryStorage` instead of `input.db` to `persistReviewObservations`
- The null-guard `!input.db` becomes `!input.memoryStorage`

### R9: Core Independence

After this change:
- `packages/core/package.json` MUST NOT list `ghagga-db` as a dependency (remove `"ghagga-db": "workspace:^"`)
- `packages/core/package.json` MUST add `"sql.js": "^1.11.0"` as a dependency
- No file in `packages/core/src/` MUST contain `import ... from 'ghagga-db'`
- `packages/core` MUST be independently installable without PostgreSQL/Drizzle

### R10: Backward Compatibility

#### R10.1: SaaS Behavior

The SaaS server (`apps/server/`) MUST continue working exactly as before. The `PostgresMemoryStorage` adapter wraps the same `ghagga-db` functions with no behavioral changes. SaaS users MUST NOT notice any difference.

#### R10.2: Server Call Sites

All server call sites that currently pass `db: dbInstance` to `reviewPipeline` MUST be updated to pass `memoryStorage: new PostgresMemoryStorage(db)`. This includes webhook handlers, Inngest functions, and API routes.

#### R10.3: Memory-Disabled Path

When `memoryStorage` is `undefined`, the pipeline MUST behave identically to the current `db: undefined` behavior: memory search returns `null`, memory persist is skipped, review completes normally.

### R11: Backfill of NULL-Embedding Observations

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

---

## Cross-Cutting Concerns

### CC1: Graceful Degradation

If memory initialization fails at any point (file permission errors, WASM load failure, sql.js import failure, corrupted database file, etc.), the review MUST still proceed without memory. Specifically:

- `SqliteMemoryStorage.create()` SHOULD be wrapped in a try/catch at the call site (CLI and Action). On failure, `memoryStorage` MUST be set to `undefined` and a warning MUST be logged.
- The pipeline's existing graceful degradation in `searchMemorySafe` and `persistReviewObservations` MUST remain: errors are caught, logged as warnings, and the pipeline continues.
- Memory failures MUST NOT cause the review to fail or throw.

### CC2: sql.js WASM Loading

The sql.js WASM binary (~1MB) MUST be loadable in both environments:

- **CLI** (direct Node.js): sql.js loads its WASM binary from its npm package's `dist/` directory by default. This MUST work without special configuration.
- **Action** (ncc-bundled): The Action uses `@vercel/ncc` for bundling. The WASM binary MUST be included as an asset. If ncc cannot inline the WASM, the `locateFile` option of sql.js MUST be used to load it from a known sibling path.

### CC3: Thread Safety

sql.js operates as an in-memory database with manual file persistence (via `close()`). Concurrent writes are NOT expected:
- The CLI is a single-process tool
- The Action runs one review per job

No file locking or write-ahead log is needed. This constraint MUST be documented in the `SqliteMemoryStorage` class JSDoc.

---

## Scenarios

### S1: CLI First Review with Memory

```gherkin
Given a CLI user runs `ghagga review .` in a git repository with a remote origin of "https://github.com/acme/widgets.git"
  And no memory database exists at ~/.config/ghagga/memory.db
  And the --no-memory flag is NOT set
When the review pipeline executes
Then SqliteMemoryStorage.create("~/.config/ghagga/memory.db") MUST be called
  And the database file MUST be created with all schema tables (memory_sessions, memory_observations, memory_observations_fts)
  And memoryStorage.searchObservations("acme/widgets", ...) MUST be called
  And the search MUST return an empty result (no prior observations)
  And memoryContext MUST be null in the ReviewResult
  And the review MUST complete with AI findings
  And memoryStorage.close() MUST be called after the pipeline completes
  And the database file MUST exist on disk at ~/.config/ghagga/memory.db
  And new observations from significant findings MUST be persisted in the database
```

### S2: CLI Second Review Same Repo

```gherkin
Given a CLI user has previously reviewed "acme/widgets" and observations exist in ~/.config/ghagga/memory.db
  And the user runs `ghagga review .` in the same repository
When the review pipeline executes
Then SqliteMemoryStorage.create("~/.config/ghagga/memory.db") MUST load the existing database file
  And memoryStorage.searchObservations("acme/widgets", ...) MUST return past observations
  And the returned observations MUST be formatted via formatMemoryContext
  And memoryContext MUST be a non-null string in the ReviewResult
  And the formatted context MUST be injected into agent prompts
```

### S3: CLI Review Different Repo

```gherkin
Given observations exist in the memory database for project "acme/widgets"
  And the CLI user runs `ghagga review .` in a repository with remote "https://github.com/acme/gadgets.git"
When memoryStorage.searchObservations("acme/gadgets", ...) is called
Then the search MUST return only observations where project = "acme/gadgets"
  And observations from "acme/widgets" MUST NOT appear in results
```

### S4: CLI with --no-memory Flag

```gherkin
Given a CLI user runs `ghagga review . --no-memory`
When the review command processes options
Then SqliteMemoryStorage MUST NOT be instantiated
  And the ReviewInput.memoryStorage MUST be undefined
  And ReviewSettings.enableMemory MUST be false
  And no database file MUST be created or opened
  And the review MUST complete normally without memory context
```

### S5: CLI with No Git Remote

```gherkin
Given a CLI user runs `ghagga review .` in a git repository with no configured remote
  And `git remote get-url origin` fails with a non-zero exit code
When the project identifier is resolved
Then the project identifier MUST fall back to "local/unknown"
  And the review MUST proceed with project = "local/unknown"
  And observations MUST be scoped to "local/unknown"
```

### S6: Action First Run (Cache Miss)

```gherkin
Given the GHAGGA Action runs on a PR in repository "owner/repo"
  And the enable-memory input is not set (defaults to true)
  And no cache entry exists for key "ghagga-memory-owner/repo"
When the Action executes
Then @actions/cache.restoreCache MUST be called for key "ghagga-memory-owner/repo"
  And the restore MUST return a cache miss (no hit)
  And SqliteMemoryStorage.create("/tmp/ghagga-memory.db") MUST create a fresh database
  And the review pipeline MUST run with memoryStorage set and enableMemory: true
  And after the pipeline, memoryStorage.close() MUST write the database to /tmp/ghagga-memory.db
  And @actions/cache.saveCache MUST be called with path "/tmp/ghagga-memory.db" and key "ghagga-memory-owner/repo"
```

### S7: Action Subsequent Run (Cache Hit)

```gherkin
Given the GHAGGA Action runs on a PR in repository "owner/repo"
  And a cache entry exists for key "ghagga-memory-owner/repo" with a populated database
When the Action executes
Then @actions/cache.restoreCache MUST return a cache hit
  And /tmp/ghagga-memory.db MUST contain the cached database file
  And SqliteMemoryStorage.create("/tmp/ghagga-memory.db") MUST load the existing data
  And memoryStorage.searchObservations("owner/repo", ...) MUST return past observations
  And the review MUST use the memory context for an enriched review
  And after the pipeline, the updated database MUST be saved to cache
```

### S8: Action with enable-memory: false

```gherkin
Given the GHAGGA Action runs with input enable-memory set to "false"
When the Action executes
Then @actions/cache.restoreCache MUST NOT be called
  And SqliteMemoryStorage MUST NOT be instantiated
  And ReviewInput.memoryStorage MUST be undefined
  And ReviewSettings.enableMemory MUST be false
  And @actions/cache.saveCache MUST NOT be called
  And the review MUST complete normally without memory
```

### S9: Action Cache Evicted

```gherkin
Given the GHAGGA Action runs on a PR in repository "owner/repo"
  And the cache entry for "ghagga-memory-owner/repo" was evicted (>7 days inactivity)
When @actions/cache.restoreCache is called
Then it MUST return a cache miss
  And no error MUST be thrown
  And the Action MUST create a fresh empty database
  And the review MUST proceed normally
  And the new database MUST be saved to cache after the review
```

### S10: Server SaaS Path Unchanged

```gherkin
Given the SaaS server processes a webhook for PR #42 on "owner/repo"
  And the server creates PostgresMemoryStorage wrapping the Drizzle db instance
When reviewPipeline is called with memoryStorage: postgresStorage and enableMemory: true
Then PostgresMemoryStorage.searchObservations MUST delegate to ghagga-db.searchObservations
  And PostgresMemoryStorage.saveObservation MUST delegate to ghagga-db.saveObservation
  And PostgresMemoryStorage.createSession MUST delegate to ghagga-db.createMemorySession
  And PostgresMemoryStorage.endSession MUST delegate to ghagga-db.endMemorySession
  And the review result MUST be identical to the pre-change behavior
```

### S11: Memory Search with Results

```gherkin
Given a MemoryStorage instance with 5 observations for project "acme/widgets"
  And the observations have titles containing "auth", "pool", "config", "deploy", "lint"
When searchObservations("acme/widgets", "auth config", { limit: 3 }) is called
Then the result MUST contain at most 3 observations
  And all returned observations MUST belong to project "acme/widgets"
  And each returned MemoryObservationRow MUST have: id (number), type (string), title (string), content (string), filePaths (string[] | null)
```

### S12: Memory Search No Results

```gherkin
Given a MemoryStorage instance with observations for project "acme/widgets"
When searchObservations("acme/widgets", "xyznonexistent", { limit: 3 }) is called
Then the result MUST be an empty array
  And the pipeline MUST set memoryContext to null
  And the review MUST proceed normally without memory context
```

### S13: Observation Content-Hash Deduplication

```gherkin
Given a MemoryStorage instance (SQLite or PostgreSQL)
  And an observation exists with contentHash = sha256("pattern:Auth config:OAuth patterns observed") created 5 minutes ago for project "acme/widgets"
When saveObservation is called with { project: "acme/widgets", type: "pattern", title: "Auth config", content: "OAuth patterns observed" }
Then the content hash sha256("pattern:Auth config:OAuth patterns observed") MUST match the existing row
  And the existing row's created_at MUST be within the 15-minute dedup window
  And the method MUST return the existing observation without inserting a new row
  And the total observation count MUST remain unchanged
```

### S14: Observation Dedup Window Expired

```gherkin
Given an observation exists with the same content hash but created 20 minutes ago
When saveObservation is called with the same type, title, and content
Then the content hash matches BUT the created_at is outside the 15-minute window
  And a new observation MUST be inserted
  And the total observation count MUST increase by 1
```

### S15: TopicKey Upsert

```gherkin
Given an observation exists with topicKey = "pr-42-review" and project = "acme/widgets"
  And it has revisionCount = 1 and content = "Original content"
When saveObservation is called with { project: "acme/widgets", topicKey: "pr-42-review", title: "Updated title", content: "Updated content", type: "decision" }
Then the existing observation MUST be updated (not a new row inserted)
  And the content MUST be "Updated content"
  And the title MUST be "Updated title"
  And the revisionCount MUST be 2
  And the updatedAt MUST be refreshed
  And the returned MemoryObservationRow MUST reflect the updated values
```

### S16: FTS5 Search Keyword Matching

```gherkin
Given a SqliteMemoryStorage instance with observations:
  | project       | title              | content                         |
  | acme/widgets  | Auth configuration | OAuth token refresh patterns     |
  | acme/widgets  | Database pooling   | Connection pool tuning for PG    |
  | acme/widgets  | CSS styling        | Tailwind utility class patterns  |
When searchObservations("acme/widgets", "auth pool") is called
Then observations matching "auth" (in title) and "pool" (in title) MUST be returned
  And the "CSS styling" observation MUST NOT be returned (no matching terms)
  And results MUST be ordered by BM25 relevance rank
```

### S17: Database File Does Not Exist Yet

```gherkin
Given no file exists at the path "/home/user/.config/ghagga/memory.db"
  And the directory "/home/user/.config/ghagga/" exists
When SqliteMemoryStorage.create("/home/user/.config/ghagga/memory.db") is called
Then a new in-memory database MUST be initialized
  And all schema tables (memory_sessions, memory_observations) MUST be created
  And the FTS5 virtual table and triggers MUST be created
  And the instance MUST be ready for search/save operations
  And when close() is called, the file MUST be written to disk
```

### S18: Database File Corrupted

```gherkin
Given a file exists at "/home/user/.config/ghagga/memory.db" but contains invalid/corrupted data
When SqliteMemoryStorage.create("/home/user/.config/ghagga/memory.db") is called
Then the create method MUST throw or return an error
  And the CLI/Action caller MUST catch the error
  And the caller MUST log a warning: "[ghagga] Memory database corrupted, starting fresh"
  And the caller MUST set memoryStorage to undefined (or retry with a fresh DB)
  And the review MUST proceed without memory
```

### S19: WASM Load Failure

```gherkin
Given the sql.js WASM binary cannot be loaded (e.g., file not found, WebAssembly not supported)
When SqliteMemoryStorage.create(...) is called
Then the create method MUST throw an error
  And the CLI/Action caller MUST catch the error
  And the caller MUST log a warning: "[ghagga] Failed to initialize memory: {error message}"
  And the caller MUST set memoryStorage to undefined
  And ReviewSettings.enableMemory MUST remain true (the setting is informational)
  And the review MUST proceed without memory context
```

### S20: Pipeline with memoryStorage undefined

```gherkin
Given reviewPipeline is called with memoryStorage: undefined and enableMemory: true
When the pipeline reaches step 5 (memory search)
Then searchMemorySafe MUST check !input.memoryStorage and return null
  And when the pipeline reaches step 8 (memory persist)
  Then the persist step MUST check !input.memoryStorage and skip persistence
  And the review MUST complete with memoryContext: null
  And no errors MUST be thrown
```

### S21: Core Package Independence

```gherkin
Given the packages/core/package.json after this change
When the dependencies are inspected
Then "ghagga-db" MUST NOT appear in dependencies or devDependencies
  And "sql.js" MUST appear in dependencies with version "^1.11.0"
  And running `grep -r "from 'ghagga-db'" packages/core/src/` MUST return zero matches
```

### S22: Session Lifecycle

```gherkin
Given a MemoryStorage instance
When createSession({ project: "acme/widgets", prNumber: 42 }) is called
Then it MUST return an object with { id: <number> } where id > 0
  And when endSession(sessionId, "Review complete") is called with the returned id
  Then the session's ended_at MUST be set
  And the session's summary MUST be "Review complete"
  And no error MUST be thrown
```

### S23: Git Remote URL Normalization

```gherkin
Given the following git remote URLs:
  | Remote URL                                     | Expected Project ID |
  | https://github.com/acme/widgets.git           | acme/widgets        |
  | git@github.com:acme/widgets.git               | acme/widgets        |
  | https://github.com/acme/widgets               | acme/widgets        |
  | ssh://git@github.com/acme/widgets.git         | acme/widgets        |
  | https://gitlab.com/acme/widgets.git           | acme/widgets        |
When the CLI resolves the project identifier
Then each URL MUST be normalized to the corresponding Expected Project ID
```

---

## Acceptance Criteria

1. `MemoryStorage` interface is defined in `packages/core/src/types.ts` with `searchObservations`, `saveObservation`, `createSession`, `endSession`, and `close` methods
2. `ReviewInput.db` is replaced by `ReviewInput.memoryStorage` typed as `MemoryStorage | undefined`
3. `SqliteMemoryStorage` passes unit tests: schema init, save + dedup, topicKey upsert, FTS5 search, session lifecycle, file persistence
4. `PostgresMemoryStorage` wraps `ghagga-db` functions and passes integration tests
5. `packages/core/package.json` has `sql.js` as dependency and no `ghagga-db` dependency
6. No file in `packages/core/src/` imports from `ghagga-db`
7. CLI creates memory DB at `~/.config/ghagga/memory.db`, derives project ID from git remote, enables memory by default, supports `--no-memory`
8. CLI memory persists across runs: first review saves observations, second review retrieves them
9. Action uses `@actions/cache` to persist memory DB between workflow runs
10. Action supports `enable-memory` input (default true) with opt-out
11. SaaS server uses `PostgresMemoryStorage`, behavior unchanged from pre-change
12. Pipeline works correctly with `memoryStorage: undefined` (graceful degradation)
13. ncc bundle of the Action succeeds with sql.js WASM included
14. All memory failures (WASM load, corrupted DB, file permissions) degrade gracefully with warnings, never breaking the review

---
---

## Memory Management Extension

> **Merged from**: `memory-management` delta spec (2026-03-06)  
> **Change**: `memory-management`  
> **Extends**: Requirements R1–R10 above with management capabilities (CLI commands for inspecting, searching, and pruning memory)

### Overview

This section extends the memory-storage domain with a `ghagga memory` CLI command group providing six subcommands (`list`, `search`, `show`, `delete`, `stats`, `clear`) that give users full visibility and control over their local SQLite memory database. It also extends the `MemoryStorage` interface with five new methods, adds a missing FTS5 delete trigger to the SQLite schema, and stubs the new methods in `PostgresMemoryStorage`.

All commands are CLI-only, output plain text tables (no TUI, no colors), and handle edge cases gracefully: no database file, empty results, invalid IDs, and non-interactive (piped) environments.

---

### Requirements

#### R11: MemoryStorage Interface Extension

The `MemoryStorage` interface in `packages/core/src/types.ts` MUST be extended with five new methods:

```typescript
/** List observations with optional filtering and pagination. */
listObservations(options?: {
  project?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<MemoryObservationDetail[]>;

/** Get a single observation by ID (full or prefix). Returns null if not found. */
getObservation(id: number): Promise<MemoryObservationDetail | null>;

/** Delete a single observation by ID. Returns true if found and deleted, false otherwise. */
deleteObservation(id: number): Promise<boolean>;

/** Get aggregate statistics about the memory store. */
getStats(): Promise<MemoryStats>;

/** Delete all observations, optionally scoped to a project. Returns count of deleted rows. */
clearObservations(options?: { project?: string }): Promise<number>;
```

**Rationale**: The existing interface only supports search, save, and session management. Management commands (list, get, delete, stats, clear) require dedicated methods that don't exist today.

#### R12: New Types — MemoryObservationDetail, MemoryStats

Two new types MUST be added to `packages/core/src/types.ts`:

```typescript
export interface MemoryObservationDetail {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
  project: string;
  topicKey: string | null;
  revisionCount: number;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}

export interface MemoryStats {
  totalObservations: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  oldestObservation: string | null;  // ISO 8601, null if no observations
  newestObservation: string | null;  // ISO 8601, null if no observations
}
```

`MemoryObservationDetail` extends the existing `MemoryObservationRow` with all database columns needed for the `show` command. `MemoryStats` carries aggregate data for the `stats` command.

#### R13: FTS5 Delete Trigger

The `SCHEMA_SQL` constant in `packages/core/src/memory/sqlite.ts` MUST include an `obs_fts_delete` trigger:

```sql
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;
```

This trigger MUST be appended to the existing `SCHEMA_SQL` alongside the existing `obs_fts_insert` and `obs_fts_update` triggers. Because `SCHEMA_SQL` runs via `db.run(SCHEMA_SQL)` on every `SqliteMemoryStorage.create()` call, and the trigger uses `CREATE TRIGGER IF NOT EXISTS`, existing databases MUST automatically gain the trigger the next time they are opened.

#### R14: SqliteMemoryStorage — New Method Implementations

`SqliteMemoryStorage` in `packages/core/src/memory/sqlite.ts` MUST implement all five new methods:

##### R14.1: listObservations

- Default `limit`: 20, default `offset`: 0.
- When `options.project` is provided, filter by `project = ?`. When omitted, return all projects.
- When `options.type` is provided, filter by `type = ?`. When omitted, return all types.
- Results MUST be ordered newest first (`created_at DESC`).
- The `file_paths` column MUST be deserialized from JSON string to `string[] | null`.
- MUST return `MemoryObservationDetail[]`.

##### R14.2: getObservation

- Accepts the integer observation ID.
- MUST return `MemoryObservationDetail | null`. Returns `null` if no row matches.
- The `file_paths` column MUST be deserialized from JSON string.

##### R14.3: deleteObservation

- The `obs_fts_delete` trigger (R13) MUST fire automatically to clean up the FTS index.
- MUST return `true` if a row was deleted, `false` if the ID was not found.
- After deletion, `close()` MUST be called by the consumer to persist the change to disk.

##### R14.4: getStats

Three queries for total/date range, count by type, and count by project.

- MUST return a `MemoryStats` object.
- If no observations exist, `totalObservations` MUST be 0, `byType` and `byProject` MUST be empty objects, `oldestObservation` and `newestObservation` MUST be `null`.

##### R14.5: clearObservations

- When `options.project` is provided, delete only that project's observations.
- When `options.project` is omitted, delete ALL observations.
- The `obs_fts_delete` trigger (R13) MUST fire for each deleted row to clean up the FTS index.
- MUST return the count of deleted rows.
- After clearing, `close()` MUST be called by the consumer to persist.

#### R15: PostgresMemoryStorage Stubs

All five new methods MUST be added to `PostgresMemoryStorage` in `apps/server/src/memory/postgres.ts`. Each MUST throw:

```typescript
throw new Error('Not implemented — use Dashboard for memory management');
```

#### R16: CLI Command Group — `ghagga memory`

A new `memory` command group MUST be registered in `apps/cli/src/index.ts`. The command group MUST be implemented as a subdirectory `apps/cli/src/commands/memory/` with one file per subcommand, a shared `utils.ts`, and an `index.ts` barrel.

#### R17: `ghagga memory list`

##### R17.1: Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--repo <owner/repo>` | string | (none) | Filter by project field |
| `--type <type>` | string | (none) | Filter by observation type |
| `--limit <n>` | number | 20 | Maximum rows to display |

##### R17.2: Output Format

A plain-text table with fixed-width columns using `String.padEnd()`:
- **ID**: First 8 characters of the integer ID, left-padded with zeros.
- **Type**: Observation type, max 10 chars.
- **Title**: Truncated to 40 characters with `...` suffix if longer.
- **Repo**: The `project` field value.
- **Date**: `createdAt` formatted as `YYYY-MM-DD`.

##### R17.3: Empty Results

When no observations match the filters, output: `No observations found.`

#### R18: `ghagga memory search <query>`

##### R18.1: Arguments and Options

- **Required argument**: `<query>` — the search terms (passed to `searchObservations`)
- `--repo <owner/repo>` — scope search to a specific project (inferred from git remote if omitted via `resolveProjectId`)
- `--limit <n>` — maximum results (default 10)

##### R18.2: Output Format

Numbered results showing type in brackets, title, ID (first 8 chars), and content snippet (first 80 characters with `...` suffix if longer).

##### R18.3: Empty Results

Output: `No matching observations found.`

#### R19: `ghagga memory show <id>`

##### R19.1: Arguments

- **Required argument**: `<id>` — the observation ID. The CLI MUST parse the argument as an integer. If parsing fails, print: `Invalid observation ID: "<input>". Expected a number.`

##### R19.2: Output Format

Key-value display, one field per line. Content MUST be displayed in full (no truncation), indented with 2 spaces per line. File paths as comma-separated list or `(none)`.

##### R19.3: Not Found

Output: `Observation not found: <id>` (exit code 1)

#### R20: `ghagga memory delete <id>`

##### R20.1: Arguments and Options

- **Required argument**: `<id>` — the observation ID
- `--force` — skip the confirmation prompt

##### R20.2: Confirmation Flow

Fetch observation → display summary → prompt `Are you sure? (y/N)` → only `y`/`Y` confirms → delete + close → success message. On cancel: `Cancelled.`

##### R20.3: Non-TTY Behavior

If `process.stdin.isTTY` is falsy and `--force` is not set: error and exit 1.

##### R20.4: Force Mode

Skip confirmation prompt entirely.

#### R21: `ghagga memory stats`

##### R21.1: Output Format

Shows: total observations, by type (sorted by count desc), by repository (top 10, sorted by count desc), database file path and size, oldest/newest observation dates.

##### R21.2: No Database

Print: `No memory database found. Run "ghagga review" first to build memory.`

#### R22: `ghagga memory clear`

##### R22.1: Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--repo <owner/repo>` | string | (none) | Scope deletion to a single project |
| `--force` | boolean | false | Skip confirmation prompt |

##### R22.2: Confirmation Flow

Count observations → display scoped/unscoped prompt → only `y`/`Y` confirms → clear + close → success message with count.

##### R22.3: Non-TTY Behavior

Same as R20.3.

##### R22.4: Force Mode

Same as R20.4.

#### R23: Database Lifecycle in Commands

Every command handler MUST: check `existsSync(dbPath)` → open `SqliteMemoryStorage.create(dbPath)` → execute → close in `finally` block. If file does not exist: print `No memory database found. Run "ghagga review" first to build memory.` and exit 0. The database path MUST be `join(getConfigDir(), 'memory.db')`.

#### R24: Confirmation Prompt Implementation

Confirmation prompts MUST use Node.js built-in `readline/promises`. No external prompt library.

#### R25: No New Dependencies (Memory Management)

This extension MUST NOT add any new npm dependencies to `packages/core` or `apps/cli`.

---

### Cross-Cutting Concerns (Memory Management)

#### CC4: Graceful Degradation — No Database File

All six memory management commands MUST handle the case where `~/.config/ghagga/memory.db` does not exist. Check `existsSync(dbPath)` BEFORE opening storage. Print message and exit 0. MUST NOT create an empty database file.

#### CC5: Non-TTY Detection

Commands that require interactive confirmation (`delete`, `clear`) MUST detect non-TTY environments. Non-TTY without `--force`: error exit 1. Non-TTY with `--force`: proceed. TTY with `--force`: proceed. TTY without `--force`: show prompt.

#### CC6: Output Formatting — Plain Text Only

All command output MUST be plain text. No ANSI color codes, no TUI components, no external formatting libraries. Tables use `String.padEnd()`. Output is designed to be parseable by text processing tools.

#### CC7: Error Exit Codes

| Scenario | Exit Code |
|----------|-----------|
| Success (data found and displayed) | 0 |
| Success (no data / empty results) | 0 |
| No database file exists | 0 |
| Observation not found (show/delete) | 1 |
| Invalid input (bad ID format) | 1 |
| Non-TTY without --force | 1 |
| Database open/read error | 1 |
| Cancelled by user | 0 |

#### CC8: ID Display Format

Throughout all commands, observation IDs are displayed as the first 8 characters of the zero-padded integer ID (e.g., `42` → `00000042`).

---

### Scenarios (Memory Management)

#### S24: List — Happy Path, All Observations

```gherkin
Given a memory database exists with 25 observations across 2 projects
  And the user runs `ghagga memory list`
When the command executes
Then listObservations({ limit: 20, offset: 0 }) MUST be called
  And a table with 20 rows MUST be printed (respecting default limit)
  And rows MUST be ordered newest first
```

#### S25: List — Filtered by Repo

```gherkin
Given observations exist for "acme/widgets" and "acme/gadgets"
  And the user runs `ghagga memory list --repo acme/widgets`
Then only observations where project = "acme/widgets" MUST appear
```

#### S26: List — Filtered by Type

```gherkin
Given observations of types "pattern", "bugfix", "learning"
  And the user runs `ghagga memory list --type pattern`
Then only observations where type = "pattern" MUST appear
```

#### S27: List — Custom Limit

```gherkin
Given 50 observations exist
  And the user runs `ghagga memory list --limit 5`
Then exactly 5 rows MUST be printed
```

#### S28: List — Combined Filters

```gherkin
Given observations exist
  And the user runs `ghagga memory list --repo acme/widgets --type bugfix --limit 3`
Then only matching observations MUST appear
```

#### S29: List — Empty Results

```gherkin
Given a memory database with no observations
  And the user runs `ghagga memory list`
Then the output MUST be "No observations found."
  And the exit code MUST be 0
```

#### S30: List — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory list`
Then the output MUST be 'No memory database found. Run "ghagga review" first to build memory.'
  And the exit code MUST be 0
```

#### S31: Search — Happy Path

```gherkin
Given observations for "acme/widgets" containing "auth" terms
  And the user runs `ghagga memory search "auth" --repo acme/widgets`
Then results MUST be displayed as numbered entries ranked by BM25 relevance
```

#### S32: Search — Repo Inferred from Git Remote

```gherkin
Given the current directory is a git repo with remote "https://github.com/acme/widgets.git"
  And the user runs `ghagga memory search "auth"` (no --repo flag)
Then resolveProjectId MUST be called to derive "acme/widgets"
```

#### S33: Search — Custom Limit

```gherkin
Given many observations exist
  And the user runs `ghagga memory search "patterns" --repo acme/widgets --limit 3`
Then at most 3 results MUST be displayed
```

#### S34: Search — No Results

```gherkin
Given the user runs `ghagga memory search "xyznonexistent" --repo acme/widgets`
Then the output MUST be "No matching observations found."
```

#### S35: Search — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory search "auth" --repo acme/widgets`
Then the output MUST be 'No memory database found...'
```

#### S36: Show — Happy Path

```gherkin
Given observation ID 42 exists with all fields populated
  And the user runs `ghagga memory show 42`
Then ALL fields MUST be displayed in key-value format
  And content MUST be displayed in full (no truncation)
```

#### S37: Show — Not Found

```gherkin
Given no observation has ID 999
  And the user runs `ghagga memory show 999`
Then the output MUST be "Observation not found: 999"
  And the exit code MUST be 1
```

#### S38: Show — Invalid ID Format

```gherkin
Given the user runs `ghagga memory show abc`
Then the output MUST be 'Invalid observation ID: "abc". Expected a number.'
  And the exit code MUST be 1
```

#### S39: Show — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory show 42`
Then the no-DB message MUST be printed and exit 0
```

#### S40: Delete — Happy Path with Confirmation

```gherkin
Given observation ID 42 exists and the terminal is a TTY
  And the user runs `ghagga memory delete 42` and types "y"
Then deleteObservation(42) MUST be called
  And storage.close() MUST be called
  And the FTS5 index entry MUST be cleaned up
```

#### S41: Delete — User Cancels

```gherkin
Given the user runs `ghagga memory delete 42` and types "n"
Then deleteObservation MUST NOT be called
  And the output MUST show "Cancelled."
```

#### S42: Delete — Force Mode

```gherkin
Given the user runs `ghagga memory delete 42 --force`
Then no confirmation prompt MUST be shown
  And deleteObservation(42) MUST be called directly
```

#### S43: Delete — Not Found

```gherkin
Given no observation has ID 999
  And the user runs `ghagga memory delete 999`
Then the output MUST be "Observation not found: 999"
  And the exit code MUST be 1
```

#### S44: Delete — Non-TTY Without Force

```gherkin
Given process.stdin.isTTY is falsy
  And the user runs `echo "y" | ghagga memory delete 42`
Then error message MUST be printed and exit code MUST be 1
```

#### S45: Delete — Non-TTY With Force

```gherkin
Given process.stdin.isTTY is falsy
  And the user runs `ghagga memory delete 42 --force`
Then deletion MUST proceed without TTY check blocking
```

#### S46: Delete — FTS5 Cleanup

```gherkin
Given observation ID 42 is indexed in FTS5
  And the user deletes it
Then the obs_fts_delete trigger MUST fire
  And subsequent searches MUST NOT return observation 42
```

#### S47: Delete — Invalid ID / No DB

```gherkin
Given the user runs `ghagga memory delete abc`
Then the output MUST be 'Invalid observation ID: "abc". Expected a number.'
  And exit code MUST be 1

Given no database file exists and the user runs `ghagga memory delete 42`
Then the no-DB message MUST be printed and exit 0
```

#### S48: Stats — Happy Path

```gherkin
Given a populated memory database
  And the user runs `ghagga memory stats`
Then total observations, by-type breakdown, by-repo breakdown, DB file size, and date range MUST be shown
```

#### S49: Stats — Empty Database

```gherkin
Given an empty memory database
  And the user runs `ghagga memory stats`
Then "Total observations: 0" and "(none)" sections MUST be shown
```

#### S50: Stats — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory stats`
Then the no-DB message MUST be printed and exit 0
```

#### S51: Clear — Happy Path, All Observations

```gherkin
Given 147 observations exist and the terminal is a TTY
  And the user runs `ghagga memory clear` and types "y"
Then clearObservations() MUST be called with no project filter
  And storage.close() MUST be called
  And the output MUST show the count of deleted observations
```

#### S52: Clear — Scoped to Repository

```gherkin
Given observations exist for multiple projects
  And the user runs `ghagga memory clear --repo acme/widgets` and types "y"
Then clearObservations({ project: "acme/widgets" }) MUST be called
  And only that project's observations MUST be deleted
```

#### S53: Clear — User Cancels

```gherkin
Given the user runs `ghagga memory clear` and types "n"
Then clearObservations MUST NOT be called
  And the output MUST show "Cancelled."
```

#### S54: Clear — Force Mode

```gherkin
Given the user runs `ghagga memory clear --force`
Then no confirmation prompt MUST be shown
  And clearObservations() MUST be called directly
```

#### S55: Clear — No Observations

```gherkin
Given an empty database
  And the user runs `ghagga memory clear`
Then "No observations to clear." MUST be printed
  And no confirmation prompt MUST be shown
```

#### S56: Clear — Non-TTY Without Force

```gherkin
Given process.stdin.isTTY is falsy and --force is not set
Then error message MUST be printed and exit code MUST be 1
```

#### S57: Clear — Non-TTY With Force and Repo

```gherkin
Given process.stdin.isTTY is falsy
  And the user runs `ghagga memory clear --repo acme/widgets --force`
Then clearObservations({ project: "acme/widgets" }) MUST be called
```

#### S58: Clear — FTS5 Cleanup on Bulk Delete

```gherkin
Given 50 observations all indexed in FTS5
  And the user runs `ghagga memory clear --force`
Then obs_fts_delete trigger MUST fire once per deleted row
  And FTS index MUST be empty after the operation
```

#### S59: FTS5 Delete Trigger — Auto-Migration

```gherkin
Given a database created before this change (no obs_fts_delete trigger)
When SqliteMemoryStorage.create(dbPath) is called with the new code
Then CREATE TRIGGER IF NOT EXISTS obs_fts_delete MUST succeed
  And existing triggers MUST remain unchanged
```

#### S60: FTS5 Delete Trigger — Idempotent on New Database

```gherkin
Given SqliteMemoryStorage.create() is called on a non-existent path
When SCHEMA_SQL runs
Then all three triggers MUST be created without errors
```

#### S61: FTS5 Delete Trigger — Idempotent on Re-Open

```gherkin
Given a database created with the new code
When SqliteMemoryStorage.create(dbPath) is called again
Then CREATE TRIGGER IF NOT EXISTS obs_fts_delete MUST be a no-op
```

#### S62: PostgresMemoryStorage — Stub Methods Throw

```gherkin
Given a PostgresMemoryStorage instance
When listObservations, getObservation, deleteObservation, getStats, or clearObservations is called
Then each MUST throw Error('Not implemented — use Dashboard for memory management')
```

#### S63: PostgresMemoryStorage — Existing Methods Unchanged

```gherkin
Given a PostgresMemoryStorage instance
When existing methods (searchObservations, saveObservation, createSession, endSession, close) are called
Then behavior MUST be identical to pre-change implementation
```

#### S64: CLI Help Text

```gherkin
Given the user runs `ghagga memory --help`
Then all 6 subcommands MUST be listed: list, search, show, delete, stats, clear
```

#### S65: Command Registration

```gherkin
Given the CLI entry point at apps/cli/src/index.ts
Then memoryCommand MUST be registered
  And `ghagga memory` MUST appear in `ghagga --help` output
  And existing commands MUST NOT be affected
```

#### S66: Storage Close in Finally Block

```gherkin
Given a memory command opens storage and an error occurs
Then storage.close() MUST still be called (via finally block)
```

---

### Acceptance Criteria (Memory Management)

15. `MemoryStorage` interface has 5 new methods: `listObservations`, `getObservation`, `deleteObservation`, `getStats`, `clearObservations`
16. `MemoryObservationDetail` and `MemoryStats` types are exported from `packages/core/src/types.ts`
17. `obs_fts_delete` trigger is present in `SCHEMA_SQL`; existing databases gain it on next open
18. `SqliteMemoryStorage` implements all 5 new methods with correct SQL, JSON deserialization, and return types
19. `PostgresMemoryStorage` has all 5 new methods throwing `'Not implemented — use Dashboard for memory management'`
20. `ghagga memory` command group is registered and appears in `ghagga --help`
21. `ghagga memory list` displays table, supports `--repo`, `--type`, `--limit`
22. `ghagga memory search <query>` uses FTS5/BM25, supports `--repo` (inferred from git), `--limit`
23. `ghagga memory show <id>` displays all fields, errors on not-found and invalid IDs
24. `ghagga memory delete <id>` shows confirmation, respects `--force`, cleans FTS5
25. `ghagga memory stats` shows totals, by-type, by-repo, DB file size, date range
26. `ghagga memory clear` prompts, supports `--repo` scoping, `--force`, returns count
27. All 6 commands print no-DB message when `memory.db` does not exist, without creating one
28. `delete` and `clear` require `--force` in non-TTY environments
29. Confirmation prompts use `readline/promises`, accept only `y`/`Y`
30. No ANSI colors, no TUI, no external formatting libraries
31. No new npm dependencies added
32. All new methods have unit tests (101 memory-specific tests)
33. Existing commands (`review`, `login`, `logout`, `status`) unaffected

---

## Extension: Dashboard Memory Management (Full-Stack Delete/Clear/Purge)

> **Origin**: Archived from `dashboard-memory-management` change (2026-03-07)
> **Depends on**: Memory Management extension above (which added MemoryStorage management methods + CLI commands)

This section defines the full-stack implementation of memory management for SaaS Dashboard users. It replaces the 5 stub methods in `PostgresMemoryStorage` (which threw `Error('Not implemented')`) with real implementations, adds 3 DELETE API endpoints, adds 3 PostgreSQL query functions to `packages/db`, and builds the Dashboard UI with a **3-tier confirmation system** proportional to the blast radius of each destructive action.

The 3-tier confirmation system:
- **Tier 1** (delete 1 observation): Simple modal with "Cancel" / "Delete" buttons
- **Tier 2** (clear 1 repo's memory): Modal + text input requiring the exact repo name to enable confirm
- **Tier 3** (purge ALL memory): Modal + text input requiring "DELETE ALL" + confirm button disabled for 5 seconds with visible countdown

All operations are scoped to the authenticated user's GitHub installation(s) — no cross-tenant access is possible.

---

### R26: Database Query — Delete Single Observation

A function `deleteMemoryObservation(db, installationId, observationId)` MUST be added to `packages/db/src/queries.ts`.

The function MUST:
- Delete the observation with the given `observationId` WHERE the observation's project belongs to a repository with the given `installationId`
- Return `true` if a row was deleted, `false` if the observation was not found or did not belong to the installation
- Use a single SQL statement that joins `memory_observations.project` to `repositories.full_name` and filters by `repositories.installation_id = installationId`

The function MUST NOT delete observations belonging to other installations, even if the `observationId` matches.

#### Scenario: S67 — Delete existing observation owned by user

- GIVEN an observation with id=42 exists for project "acme/widgets"
- AND "acme/widgets" belongs to installation 100
- WHEN `deleteMemoryObservation(db, 100, 42)` is called
- THEN the observation MUST be deleted from the database
- AND the function MUST return `true`

#### Scenario: S68 — Delete observation not found

- GIVEN no observation with id=999 exists
- WHEN `deleteMemoryObservation(db, 100, 999)` is called
- THEN no rows MUST be deleted
- AND the function MUST return `false`

#### Scenario: S69 — IDOR prevention — observation belongs to different installation

- GIVEN an observation with id=42 exists for project "evil/repo"
- AND "evil/repo" belongs to installation 200 (not the caller's)
- WHEN `deleteMemoryObservation(db, 100, 42)` is called
- THEN no rows MUST be deleted
- AND the function MUST return `false`

---

### R27: Database Query — Clear Observations by Project

A function `clearMemoryObservationsByProject(db, installationId, project)` MUST be added to `packages/db/src/queries.ts`.

The function MUST:
- Delete all observations WHERE `project` matches AND the project's repository belongs to the given `installationId`
- Return the count of deleted rows (integer >= 0)

The function MUST NOT delete observations for projects belonging to other installations.

#### Scenario: S70 — Clear all observations for a repo

- GIVEN 15 observations exist for project "acme/widgets"
- AND "acme/widgets" belongs to installation 100
- WHEN `clearMemoryObservationsByProject(db, 100, "acme/widgets")` is called
- THEN all 15 observations MUST be deleted
- AND the function MUST return `15`

#### Scenario: S71 — Clear repo with no observations (no-op)

- GIVEN 0 observations exist for project "acme/empty-repo"
- AND "acme/empty-repo" belongs to installation 100
- WHEN `clearMemoryObservationsByProject(db, 100, "acme/empty-repo")` is called
- THEN no rows MUST be deleted
- AND the function MUST return `0`

#### Scenario: S72 — Clear repo belonging to different installation

- GIVEN observations exist for project "evil/repo" belonging to installation 200
- WHEN `clearMemoryObservationsByProject(db, 100, "evil/repo")` is called
- THEN no rows MUST be deleted
- AND the function MUST return `0`

---

### R28: Database Query — Clear All Observations for Installation

A function `clearAllMemoryObservations(db, installationId)` MUST be added to `packages/db/src/queries.ts`.

The function MUST:
- Delete all observations WHERE the observation's project belongs to a repository with the given `installationId`
- Return the count of deleted rows (integer >= 0)

The function MUST NOT delete observations for projects belonging to other installations.

#### Scenario: S73 — Purge all observations for an installation

- GIVEN 50 observations exist across projects "acme/widgets" (30) and "acme/gadgets" (20)
- AND both projects belong to installation 100
- AND 10 observations exist for "other/repo" belonging to installation 200
- WHEN `clearAllMemoryObservations(db, 100)` is called
- THEN 50 observations MUST be deleted (30 + 20)
- AND the function MUST return `50`
- AND the 10 observations for "other/repo" MUST NOT be deleted

#### Scenario: S74 — Purge when nothing to purge

- GIVEN 0 observations exist for any project belonging to installation 100
- WHEN `clearAllMemoryObservations(db, 100)` is called
- THEN no rows MUST be deleted
- AND the function MUST return `0`

---

### R29: Server API — DELETE /api/memory/observations/:id

A `DELETE /api/memory/observations/:id` route MUST be added to `createApiRouter` in `apps/server/src/routes/api.ts`.

The route MUST:
- Require authentication (existing `authMiddleware`)
- Parse `:id` as an integer; return 400 if not a valid number
- Look up the observation's project, then verify the project's repository belongs to one of `user.installationIds`; return 403 if not authorized
- Call `deleteMemoryObservation(db, installationId, observationId)`
- Return `200 { data: { deleted: true } }` on success
- Return `404 { error: "Observation not found" }` if the observation does not exist or is not accessible

#### Scenario: S75 — Delete observation via API (happy path)

- GIVEN the user is authenticated with installationIds [100]
- AND observation id=42 exists for project "acme/widgets" (installation 100)
- WHEN `DELETE /api/memory/observations/42` is sent
- THEN the response MUST be `200 { data: { deleted: true } }`
- AND the observation MUST be deleted from the database

#### Scenario: S76 — Delete observation — not authenticated

- GIVEN the request has no valid auth token
- WHEN `DELETE /api/memory/observations/42` is sent
- THEN the response MUST be `401`

#### Scenario: S77 — Delete observation — not found

- GIVEN the user is authenticated with installationIds [100]
- AND no observation with id=999 exists (or it belongs to another installation)
- WHEN `DELETE /api/memory/observations/999` is sent
- THEN the response MUST be `404 { error: "Observation not found" }`

#### Scenario: S78 — Delete observation — invalid ID format

- GIVEN the user is authenticated
- WHEN `DELETE /api/memory/observations/abc` is sent
- THEN the response MUST be `400 { error: "Invalid observation ID" }`

---

### R30: Server API — DELETE /api/memory/projects/:project/observations

A `DELETE /api/memory/projects/:project/observations` route MUST be added to `createApiRouter`.

The `:project` parameter MUST be URL-decoded to handle `owner/repo` format (e.g., `acme%2Fwidgets` decodes to `acme/widgets`).

The route MUST:
- Require authentication
- Look up the repository by `project` (decoded); return 404 if not found
- Verify `repo.installationId` is in `user.installationIds`; return 403 if not authorized
- Call `clearMemoryObservationsByProject(db, repo.installationId, project)`
- Return `200 { data: { cleared: N } }` where N is the count of deleted rows

#### Scenario: S79 — Clear repo observations via API (happy path)

- GIVEN the user is authenticated with installationIds [100]
- AND "acme/widgets" has 15 observations and belongs to installation 100
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 15 } }`
- AND all 15 observations MUST be deleted

#### Scenario: S80 — Clear repo — not authenticated

- GIVEN the request has no valid auth token
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `401`

#### Scenario: S81 — Clear repo — repo not found

- GIVEN the user is authenticated
- AND no repository "nonexistent/repo" exists in the database
- WHEN `DELETE /api/memory/projects/nonexistent%2Frepo/observations` is sent
- THEN the response MUST be `404 { error: "Repository not found" }`

#### Scenario: S82 — Clear repo — forbidden (different installation)

- GIVEN the user is authenticated with installationIds [100]
- AND "evil/repo" belongs to installation 200
- WHEN `DELETE /api/memory/projects/evil%2Frepo/observations` is sent
- THEN the response MUST be `403 { error: "Forbidden" }`

#### Scenario: S83 — Clear repo — zero observations (no-op success)

- GIVEN the user is authenticated with installationIds [100]
- AND "acme/widgets" belongs to installation 100 but has 0 observations
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

---

### R31: Server API — DELETE /api/memory/observations

A `DELETE /api/memory/observations` route MUST be added to `createApiRouter`.

The route MUST:
- Require authentication
- Determine the user's primary installation ID from `user.installationIds`
- Call `clearAllMemoryObservations(db, installationId)` for each installation ID, summing the results
- Return `200 { data: { cleared: N } }` where N is the total count of deleted rows

The route MUST NOT conflict with the `DELETE /api/memory/observations/:id` route. The Hono router MUST resolve the parameterized route for numeric paths and the bare route for the no-param case.

#### Scenario: S84 — Purge all observations via API (happy path)

- GIVEN the user is authenticated with installationIds [100]
- AND 50 observations exist across all repos belonging to installation 100
- WHEN `DELETE /api/memory/observations` is sent (no path params)
- THEN the response MUST be `200 { data: { cleared: 50 } }`
- AND all 50 observations MUST be deleted

#### Scenario: S85 — Purge all — not authenticated

- GIVEN the request has no valid auth token
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `401`

#### Scenario: S86 — Purge all — nothing to purge

- GIVEN the user is authenticated with installationIds [100]
- AND 0 observations exist for installation 100
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

#### Scenario: S87 — Purge all — multiple installations

- GIVEN the user is authenticated with installationIds [100, 200]
- AND installation 100 has 30 observations and installation 200 has 20 observations
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 50 } }`
- AND all observations for both installations MUST be deleted

---

### R32: PostgresMemoryStorage — Implement Stub Methods

The 5 stub methods in `apps/server/src/memory/postgres.ts` that currently throw `Error('Not implemented')` MUST be replaced with real implementations.

Each method MUST delegate to the appropriate `ghagga-db` query function:

| Method | Delegates To |
|--------|-------------|
| `listObservations(options?)` | New `listMemoryObservations(db, installationId, options)` query |
| `getObservation(id)` | New `getMemoryObservation(db, installationId, id)` query |
| `deleteObservation(id)` | `deleteMemoryObservation(db, installationId, id)` (R26) |
| `getStats()` | New `getMemoryStats(db, installationId)` query |
| `clearObservations(options?)` | `clearMemoryObservationsByProject` (R27) or `clearAllMemoryObservations` (R28) depending on `options.project` |

The `PostgresMemoryStorage` constructor MUST be extended to accept an `installationId: number` parameter (or the adapter must receive it per-call via the API route context).

Note: The `listMemoryObservations`, `getMemoryObservation`, and `getMemoryStats` query functions are additional read queries needed to support the existing Dashboard memory page. They are additive and MUST be scoped by `installationId`.

#### Scenario: S88 — listObservations returns observations for installation

- GIVEN a `PostgresMemoryStorage` instance for installation 100
- AND observations exist for projects belonging to installation 100
- WHEN `listObservations({ project: "acme/widgets", limit: 10 })` is called
- THEN it MUST return `MemoryObservationDetail[]` filtered by project and installation
- AND no observations from other installations MUST be returned

#### Scenario: S89 — getObservation returns detail or null

- GIVEN a `PostgresMemoryStorage` instance for installation 100
- AND observation id=42 exists for a project belonging to installation 100
- WHEN `getObservation(42)` is called
- THEN it MUST return a `MemoryObservationDetail` object with all fields

#### Scenario: S90 — getObservation returns null for non-existent

- GIVEN no observation with id=999 exists (or it belongs to another installation)
- WHEN `getObservation(999)` is called
- THEN it MUST return `null`

#### Scenario: S91 — deleteObservation delegates to DB query

- GIVEN observation id=42 exists for installation 100
- WHEN `deleteObservation(42)` is called
- THEN `deleteMemoryObservation(db, 100, 42)` MUST be called
- AND the method MUST return `true`

#### Scenario: S92 — getStats returns aggregate data

- GIVEN observations exist for installation 100
- WHEN `getStats()` is called
- THEN it MUST return a `MemoryStats` object with `totalObservations`, `byType`, `byProject`, `oldestObservation`, `newestObservation`
- AND only observations for installation 100 MUST be counted

#### Scenario: S93 — clearObservations with project

- GIVEN observations exist for "acme/widgets" belonging to installation 100
- WHEN `clearObservations({ project: "acme/widgets" })` is called
- THEN `clearMemoryObservationsByProject(db, 100, "acme/widgets")` MUST be called
- AND it MUST return the count of deleted rows

#### Scenario: S94 — clearObservations without project (purge all)

- GIVEN observations exist for installation 100
- WHEN `clearObservations()` is called (no project filter)
- THEN `clearAllMemoryObservations(db, 100)` MUST be called
- AND it MUST return the count of deleted rows

---

### R33: Dashboard UI — Tier 1 Confirmation (Delete Single Observation)

Each `ObservationCard` in `apps/dashboard/src/pages/Memory.tsx` MUST display a delete button (trash icon) in the top-right corner.

When the user clicks the delete button, a simple confirmation modal MUST appear with:
- Title: "Delete observation"
- Body: The observation's title and type
- Two buttons: "Cancel" (secondary) and "Delete" (destructive/red)

Clicking "Cancel" or pressing Escape MUST close the modal without any action.
Clicking "Delete" MUST:
- Call the `useDeleteObservation` mutation
- Show a loading state on the button while the request is in flight
- On success: close the modal, remove the observation from the UI, and show a success toast/notification
- On error: show an error message in the modal without closing it

#### Scenario: S95 — Delete single observation via UI (happy path)

- GIVEN the user is viewing the Memory page with observations loaded
- AND observation "OAuth token refresh patterns" is visible
- WHEN the user clicks the trash icon on that observation
- THEN a confirmation modal MUST appear with the title "Delete observation"
- AND the modal MUST show the observation title
- WHEN the user clicks "Delete"
- THEN the observation MUST be removed from the UI
- AND a success message MUST be shown

#### Scenario: S96 — Cancel single delete

- GIVEN the Tier 1 confirmation modal is open
- WHEN the user clicks "Cancel"
- THEN the modal MUST close
- AND no API request MUST be made
- AND the observation MUST remain visible

#### Scenario: S97 — Dismiss modal with Escape key

- GIVEN the Tier 1 confirmation modal is open
- WHEN the user presses the Escape key
- THEN the modal MUST close
- AND no API request MUST be made

---

### R34: Dashboard UI — Tier 2 Confirmation (Clear Repo Memory)

A "Clear Memory" button MUST be displayed in the session header area when a repository is selected.

When clicked, a confirmation modal MUST appear with:
- Title: "Clear all memory for {repoName}"
- Body: "This will delete all {count} observations for this repository. This action cannot be undone."
- A text input with placeholder: "Type {repoName} to confirm" (where `{repoName}` is e.g., "acme/widgets")
- Two buttons: "Cancel" (secondary) and "Clear Memory" (destructive/red)

The "Clear Memory" button MUST be **disabled** until the text input value matches the exact repo name (case-sensitive).

Clicking "Cancel" or pressing Escape MUST close the modal without any action.
Clicking "Clear Memory" (when enabled) MUST:
- Call the `useClearRepoMemory` mutation
- Show a loading state on the button
- On success: close the modal, update the UI to reflect the cleared state, show success toast
- On error: show error message in the modal

#### Scenario: S98 — Clear repo memory via UI (happy path)

- GIVEN the user is viewing memory for "acme/widgets" which has 15 observations
- WHEN the user clicks "Clear Memory"
- THEN a confirmation modal MUST appear showing "This will delete all 15 observations"
- AND the "Clear Memory" button in the modal MUST be disabled
- WHEN the user types "acme/widgets" in the text input
- THEN the "Clear Memory" button MUST become enabled
- WHEN the user clicks "Clear Memory"
- THEN all observations for "acme/widgets" MUST be deleted
- AND the session list MUST update to reflect the empty state
- AND a success message MUST be shown

#### Scenario: S99 — Confirmation text doesn't match (button stays disabled)

- GIVEN the Tier 2 confirmation modal is open for "acme/widgets"
- WHEN the user types "acme/widget" (missing 's')
- THEN the "Clear Memory" button MUST remain disabled
- WHEN the user types "ACME/WIDGETS" (wrong case)
- THEN the "Clear Memory" button MUST remain disabled
- WHEN the user corrects to "acme/widgets"
- THEN the "Clear Memory" button MUST become enabled

#### Scenario: S100 — Cancel clear repo

- GIVEN the Tier 2 confirmation modal is open
- WHEN the user clicks "Cancel"
- THEN the modal MUST close
- AND no API request MUST be made
- AND no observations MUST be deleted

---

### R35: Dashboard UI — Tier 3 Confirmation (Purge All Memory)

A "Purge All Memory" button MUST be displayed in the page header or a danger zone area of the Memory page.

When clicked, a confirmation modal MUST appear with:
- Title: "Purge all memory"
- Body: "This will permanently delete ALL {totalCount} observations across ALL your repositories. This action cannot be undone."
- A text input with placeholder: 'Type "DELETE ALL" to confirm'
- Two buttons: "Cancel" (secondary) and "Purge All" (destructive/red)

The "Purge All" button MUST be **disabled** until BOTH conditions are met:
1. The text input value is exactly "DELETE ALL" (case-sensitive)
2. A 5-second countdown timer has expired

The countdown timer:
- MUST start when the modal opens
- MUST display the remaining seconds on the button (e.g., "Purge All (5s)", "Purge All (4s)", ..., "Purge All (1s)")
- After the countdown reaches 0, the button text MUST change to "Purge All" (no countdown suffix)
- The button MUST remain disabled if the countdown has expired but the text input doesn't match
- The button MUST remain disabled if the text input matches but the countdown has not expired

Clicking "Cancel" or pressing Escape MUST close the modal and reset the countdown.
If the modal is re-opened, the countdown MUST restart from 5 seconds.

Clicking "Purge All" (when both conditions are met) MUST:
- Call the `usePurgeAllMemory` mutation
- Show a loading state on the button
- On success: close the modal, navigate to/show the empty memory state, show success toast
- On error: show error message in the modal

#### Scenario: S101 — Purge all memory via UI (happy path)

- GIVEN the user has 50 observations across all repos
- WHEN the user clicks "Purge All Memory"
- THEN a confirmation modal MUST appear showing "This will permanently delete ALL 50 observations"
- AND the "Purge All" button MUST show "Purge All (5s)"
- AND the text input MUST be empty
- WHEN 5 seconds elapse
- THEN the button text MUST change to "Purge All" (no countdown)
- AND the button MUST still be disabled (text not entered)
- WHEN the user types "DELETE ALL"
- THEN the "Purge All" button MUST become enabled
- WHEN the user clicks "Purge All"
- THEN all observations MUST be deleted
- AND a success message MUST be shown

#### Scenario: S102 — Countdown timer behavior

- GIVEN the Tier 3 confirmation modal just opened
- THEN the "Purge All" button MUST display "Purge All (5s)"
- AND after 1 second it MUST display "Purge All (4s)"
- AND after 2 seconds it MUST display "Purge All (3s)"
- AND after 3 seconds it MUST display "Purge All (2s)"
- AND after 4 seconds it MUST display "Purge All (1s)"
- AND after 5 seconds it MUST display "Purge All"

#### Scenario: S103 — Text correct but countdown not expired

- GIVEN the Tier 3 modal opened 2 seconds ago (3 seconds remaining)
- AND the user has typed "DELETE ALL"
- THEN the "Purge All" button MUST still be disabled
- AND the button MUST still show the countdown (e.g., "Purge All (3s)")

#### Scenario: S104 — Countdown expired but text doesn't match

- GIVEN the Tier 3 modal opened more than 5 seconds ago
- AND the user has typed "delete all" (wrong case)
- THEN the "Purge All" button MUST remain disabled

#### Scenario: S105 — Cancel purge and re-open resets countdown

- GIVEN the Tier 3 confirmation modal has been open for 4 seconds
- WHEN the user clicks "Cancel"
- THEN the modal MUST close
- WHEN the user clicks "Purge All Memory" again
- THEN a new modal MUST appear with the countdown restarted at 5 seconds

#### Scenario: S106 — Dismiss with Escape resets countdown

- GIVEN the Tier 3 confirmation modal is open
- WHEN the user presses Escape
- THEN the modal MUST close
- AND the countdown MUST reset for next open

---

### R36: Dashboard API Client — Mutation Hooks

Three new mutation hooks MUST be added to `apps/dashboard/src/lib/api.ts`:

#### R36.1: useDeleteObservation

```typescript
export function useDeleteObservation()
```

MUST:
- Send `DELETE /api/memory/observations/:id`
- Accept `{ observationId: number }` as the mutation variable
- On success: invalidate query keys `['memory', 'observations', *]` and `['memory', 'sessions', *]`
- Return the standard `useMutation` result

#### R36.2: useClearRepoMemory

```typescript
export function useClearRepoMemory()
```

MUST:
- Send `DELETE /api/memory/projects/:project/observations` (URL-encode the project)
- Accept `{ project: string }` as the mutation variable
- On success: invalidate query keys `['memory', 'observations', *]` and `['memory', 'sessions', *]`
- Return the standard `useMutation` result

#### R36.3: usePurgeAllMemory

```typescript
export function usePurgeAllMemory()
```

MUST:
- Send `DELETE /api/memory/observations`
- Accept no variables (or empty object)
- On success: invalidate ALL query keys starting with `['memory']`
- Return the standard `useMutation` result

#### Scenario: S107 — Cache invalidation after single delete

- GIVEN the user is viewing observations for session 5
- WHEN `useDeleteObservation` succeeds for observation 42
- THEN the query `['memory', 'observations', 5]` MUST be invalidated
- AND the observation list MUST refetch and no longer include observation 42

#### Scenario: S108 — Cache invalidation after clear repo

- GIVEN the user is viewing sessions for "acme/widgets"
- WHEN `useClearRepoMemory` succeeds for "acme/widgets"
- THEN all `['memory', 'sessions', 'acme/widgets']` queries MUST be invalidated
- AND all `['memory', 'observations', *]` queries MUST be invalidated
- AND the session list MUST refetch and show updated observation counts

#### Scenario: S109 — Cache invalidation after purge all

- GIVEN the user has data loaded for multiple repos
- WHEN `usePurgeAllMemory` succeeds
- THEN ALL `['memory']` queries MUST be invalidated

---

### R37: Dashboard UI — Loading States and Error Handling

All three destructive operations MUST display appropriate loading and error states.

During a mutation request:
- The confirm button MUST show a loading indicator (spinner or "Deleting..." text)
- The confirm button MUST be disabled to prevent double-submission
- The "Cancel" button SHOULD remain clickable (to allow aborting, though the request will still complete server-side)

On error:
- The modal MUST remain open
- An error message MUST be displayed within the modal
- The confirm button MUST return to its normal state (re-enabled)

On network error:
- The error message SHOULD indicate a connectivity issue (e.g., "Network error. Please check your connection and try again.")

#### Scenario: S110 — Loading state during delete

- GIVEN the user clicked "Delete" in the Tier 1 modal
- WHEN the API request is in flight
- THEN the "Delete" button MUST show a loading indicator
- AND the "Delete" button MUST be disabled

#### Scenario: S111 — Network error during delete

- GIVEN the user clicked "Delete" in the Tier 1 modal
- AND the network request fails (timeout, connection refused, etc.)
- THEN the modal MUST remain open
- AND an error message MUST be displayed
- AND the "Delete" button MUST return to its enabled state

#### Scenario: S112 — API error (404) during delete

- GIVEN the user clicked "Delete" for an observation that was already deleted (e.g., in another tab)
- AND the API returns 404
- THEN the modal MUST show an appropriate error message (e.g., "Observation not found — it may have already been deleted")
- AND after dismissing, the observation list SHOULD refetch

---

### R38: Dashboard UI — Responsive Design and Consistency

All new UI elements (delete buttons, modals, confirmation inputs) MUST:
- Be consistent with the existing dashboard design language (colors, typography, spacing, border-radius)
- Use the existing `Card` component pattern for modal containers
- Use the existing `cn()` utility for conditional class composition
- Work responsively on screens from 320px width up to 4K
- Support dark mode (the dashboard is dark-mode only currently)

The confirmation modals MUST:
- Be rendered via a portal or overlay pattern that covers the full viewport
- Have a semi-transparent backdrop
- Be vertically and horizontally centered
- Be closeable by clicking the backdrop (equivalent to "Cancel")

#### Scenario: S113 — Modal renders centered with backdrop

- GIVEN the user clicks any delete/clear/purge button
- WHEN the confirmation modal appears
- THEN it MUST be centered on screen
- AND a semi-transparent backdrop MUST cover the rest of the page
- AND clicking the backdrop MUST close the modal

---

### R39: Dashboard UI — Success Feedback

After a successful destructive operation, the UI MUST provide clear feedback:

- **Single delete**: A brief toast/notification saying "Observation deleted" (auto-dismiss after 3-5 seconds)
- **Clear repo**: A toast saying "Cleared {N} observations from {repoName}" (auto-dismiss after 3-5 seconds)
- **Purge all**: A toast saying "Purged {N} observations from all repositories" (auto-dismiss after 5 seconds)

The toast MUST NOT block interaction with the page.

#### Scenario: S114 — Toast after successful single delete

- GIVEN the user confirmed deletion of an observation
- AND the API returned success
- THEN a toast MUST appear saying "Observation deleted"
- AND the toast MUST auto-dismiss after 3-5 seconds

#### Scenario: S115 — Toast after successful purge all

- GIVEN the user confirmed purging all memory
- AND the API returned `{ cleared: 50 }`
- THEN a toast MUST appear saying "Purged 50 observations from all repositories"

---

### R40: Security — Installation Scoping

ALL delete/clear/purge operations MUST be scoped to the authenticated user's GitHub installation(s) at both the API and database layers.

The API layer MUST:
- Extract `user.installationIds` from the auth middleware context
- For single delete and clear-repo: look up the repository, verify `repo.installationId in user.installationIds`
- For purge-all: pass `user.installationIds` to the DB query

The DB layer MUST:
- Accept `installationId` as a parameter in all delete/clear query functions
- Use SQL JOINs or WHERE clauses to ensure only observations for repos belonging to that installation are affected

No user MUST be able to delete another user's memory, even by guessing observation IDs or project names.

#### Scenario: S116 — Cross-tenant isolation at API layer

- GIVEN user A is authenticated with installationIds [100]
- AND user B has observation id=42 belonging to installation 200
- WHEN user A sends `DELETE /api/memory/observations/42`
- THEN the API MUST return 404 (observation not found for this user)
- AND observation 42 MUST NOT be deleted

#### Scenario: S117 — Cross-tenant isolation at DB layer

- GIVEN `deleteMemoryObservation(db, 100, 42)` is called
- AND observation 42 belongs to installation 200
- THEN the SQL query MUST return 0 affected rows
- AND the function MUST return `false`

---

### Cross-Cutting Concerns (Dashboard Memory Management)

#### CC9: URL Encoding for Project Parameter

The `DELETE /api/memory/projects/:project/observations` endpoint uses the project name (e.g., "owner/repo") as a URL path parameter. Since this contains a slash, the client MUST URL-encode it (e.g., `acme%2Fwidgets`). The Hono router MUST decode it back to `acme/widgets`.

Special characters in organization or repository names (e.g., hyphens, dots, underscores) MUST be handled correctly. The only character requiring encoding is the forward slash separating owner and repo.

#### CC10: Concurrent Deletion

If the same observation/repo is deleted simultaneously from two browser tabs:
- The first request to arrive MUST succeed
- The second request MUST either succeed as a no-op (return `deleted: true` if idempotent, or `cleared: 0`) or return 404 for single observation deletes
- No server error (500) MUST be thrown

The TanStack Query `refetchOnWindowFocus` behavior SHOULD handle stale data when the user switches back to a tab where a deleted observation is still displayed.

#### CC11: Empty States

After clearing all observations for a repo or purging all memory, the UI MUST display an appropriate empty state rather than showing stale data or a blank page.

- After clearing a repo: the session list for that repo SHOULD show an empty message (e.g., "No memory sessions for this repository")
- After purging all: the Memory page SHOULD show a global empty state (e.g., "No memory yet. Memory builds as GHAGGA reviews your pull requests.")

#### CC12: PostgreSQL Triggers

Unlike SQLite (which requires explicit FTS5 delete triggers), PostgreSQL's `tsvector` search column is maintained by a database trigger (`tsvector_update_trigger`). Deleting rows from `memory_observations` MUST automatically clean up the search index. No manual FTS cleanup is needed.

#### CC13: No New Dependencies (Dashboard Memory Management)

This extension MUST NOT add any new npm dependencies to any package. All functionality uses:
- `drizzle-orm` (already in `packages/db`) for PostgreSQL queries
- `hono` (already in `apps/server`) for API routes
- `@tanstack/react-query` (already in `apps/dashboard`) for mutation hooks
- React (already in `apps/dashboard`) for UI components

---

### Edge Cases (Dashboard Memory Management)

#### E6: Deleting the last observation in a session

- GIVEN a session has exactly 1 observation
- WHEN that observation is deleted
- THEN the session MUST still exist in the database (sessions are not auto-deleted)
- AND the session MUST show 0 observations in the UI
- AND the session list MUST update the observation count

##### Scenario: S118

- GIVEN session 5 has 1 observation (id=42)
- WHEN the user deletes observation 42
- THEN the session list MUST still show session 5
- AND session 5 MUST display "0 observations"

#### E7: Clearing a repo that has no observations

- GIVEN a repository exists but has 0 observations
- WHEN the user clicks "Clear Memory" for that repo
- THEN the Tier 2 modal MAY show "This will delete all 0 observations"
- OR the "Clear Memory" button MAY be hidden/disabled when count is 0
- AND if the API is called, it MUST return `{ cleared: 0 }` without error

##### Scenario: S119

- GIVEN "acme/widgets" has 0 observations
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

#### E8: Purging when there's nothing to purge

- GIVEN the user has no observations across any repo
- WHEN the user triggers "Purge All Memory"
- THEN the API MUST return `{ cleared: 0 }` without error
- AND the UI MUST show a toast like "Purged 0 observations from all repositories" or a gentler message

##### Scenario: S120

- GIVEN the user has 0 total observations
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

#### E9: Concurrent deletion (two tabs)

- GIVEN the user has the Memory page open in two tabs
- AND both tabs show observation 42
- WHEN the user deletes observation 42 in Tab 1 (succeeds)
- AND then tries to delete observation 42 in Tab 2
- THEN Tab 2's API request MUST return 404
- AND Tab 2 MUST show an appropriate error message
- AND when Tab 2 refocuses or refetches, observation 42 MUST no longer appear

##### Scenario: S121

- GIVEN observation 42 was deleted in another tab
- WHEN `DELETE /api/memory/observations/42` is sent
- THEN the response MUST be `404 { error: "Observation not found" }`

#### E10: Project param with special characters in URL

- GIVEN a project name contains characters that need URL encoding (e.g., "my-org/my.repo-name")
- WHEN the client sends `DELETE /api/memory/projects/my-org%2Fmy.repo-name/observations`
- THEN the server MUST correctly decode the project parameter to "my-org/my.repo-name"
- AND the query MUST match the correct repository

##### Scenario: S122

- GIVEN "my-org/my.repo-name" belongs to the user's installation
- WHEN `DELETE /api/memory/projects/my-org%2Fmy.repo-name/observations` is sent
- THEN the server MUST find the repository "my-org/my.repo-name"
- AND the clear operation MUST succeed

---

### Acceptance Criteria (Dashboard Memory Management)

34. `deleteMemoryObservation(db, installationId, observationId)` in `packages/db/src/queries.ts` deletes a single observation scoped by installation, returns `boolean`
35. `clearMemoryObservationsByProject(db, installationId, project)` in `packages/db/src/queries.ts` clears all observations for a repo scoped by installation, returns count
36. `clearAllMemoryObservations(db, installationId)` in `packages/db/src/queries.ts` clears all observations for an installation, returns count
37. `DELETE /api/memory/observations/:id` returns 200/404/400/401/403 as specified
38. `DELETE /api/memory/projects/:project/observations` returns 200/404/401/403 as specified, handles URL-encoded project names
39. `DELETE /api/memory/observations` returns 200/401 as specified
40. All API endpoints enforce installation-scoped authorization (no IDOR)
41. `PostgresMemoryStorage.deleteObservation()` returns `boolean` (no longer throws)
42. `PostgresMemoryStorage.clearObservations()` returns count (no longer throws)
43. `PostgresMemoryStorage.listObservations()` returns `MemoryObservationDetail[]` (no longer throws)
44. `PostgresMemoryStorage.getObservation()` returns detail or null (no longer throws)
45. `PostgresMemoryStorage.getStats()` returns `MemoryStats` (no longer throws)
46. **Tier 1**: Trash icon on each `ObservationCard`, simple modal with "Cancel"/"Delete"
47. **Tier 2**: "Clear Memory" button, modal with text input matching exact repo name to enable confirm
48. **Tier 3**: "Purge All Memory" button, modal with "DELETE ALL" text input + 5-second countdown timer on confirm button; both conditions required
49. Countdown timer displays remaining seconds on the button, resets on modal close/reopen
50. TanStack Query mutations with proper cache invalidation for all 3 operations
51. Loading states during API requests (disabled buttons, spinners)
52. Error handling in modals (remain open on error, show message)
53. Success toast/notification after each operation
54. Empty state displayed after clearing/purging all observations
55. Responsive design consistent with existing dashboard (dark mode, existing component patterns)
56. No new npm dependencies added
57. All new DB queries, API endpoints, and UI components have tests
58. Existing tests continue passing

---

## Extension: Memory Detail View — Severity Expansion + Dashboard UI Enhancements

> **Origin**: Archived from `memory-detail-view` change (2026-03-07)
> **Depends on**: Dashboard Memory Management extension above (which implemented delete/clear/purge + ConfirmDialog + Toast)

This section defines two areas of change:

1. **Backend**: Expand the memory significance filter to include `medium` severity findings, add a `severity` column to the observation data model (both PostgreSQL and SQLite), and propagate severity through the persistence and query pipeline.

2. **Dashboard**: Enhance the Memory page with severity badges, PR links, an observation detail modal, stats bar, severity filter, and sort options — transforming the page from a basic observation browser into a comprehensive memory management interface.

All observations with `NULL` severity (pre-existing data) MUST be handled gracefully throughout.

---

### R41: Expand Significance Filter to Include Medium Severity

The `isSignificantFinding()` function in `packages/core/src/memory/persist.ts` MUST be updated to return `true` for `medium` severity findings in addition to `critical` and `high`.

The function MUST continue to return `false` for `low` and `info` severity findings.

#### Scenario: S123 — Medium severity finding is persisted

- GIVEN a review result contains a finding with `severity: 'medium'` and `category: 'performance'`
- WHEN `persistReviewObservations()` is called
- THEN the finding MUST be saved as a memory observation via `saveObservation()`
- AND the observation's content MUST include `[MEDIUM] performance`

#### Scenario: S124 — Low severity finding is still excluded

- GIVEN a review result contains only a finding with `severity: 'low'`
- WHEN `persistReviewObservations()` is called
- THEN no observations MUST be saved (aside from no session being created)
- AND `saveObservation()` MUST NOT be called

#### Scenario: S125 — Mixed severities: all three significant levels captured

- GIVEN a review result contains 3 findings: one `critical`, one `high`, one `medium`
- WHEN `persistReviewObservations()` is called
- THEN 3 finding observations MUST be saved (plus 1 summary observation)
- AND all 3 findings MUST pass the significance filter

---

### R42: Add `severity` Column to PostgreSQL Schema

A `severity` column MUST be added to the `memoryObservations` table in `packages/db/src/schema.ts`.

The column MUST:
- Be of type `varchar('severity', { length: 10 })`
- Be nullable (no `.notNull()`) for backward compatibility with existing observations
- Accept values: `'critical'`, `'high'`, `'medium'`, `'low'`, `'info'`, or `NULL`

A corresponding migration file `packages/db/drizzle/0006_add_severity_column.sql` MUST be created containing:
```sql
ALTER TABLE "memory_observations" ADD COLUMN "severity" varchar(10);
```

#### Scenario: S126 — New observation stored with severity

- GIVEN the `severity` column exists in `memory_observations`
- WHEN a new observation is inserted with `severity: 'medium'`
- THEN the `severity` column MUST contain `'medium'`

#### Scenario: S127 — Existing observations have NULL severity

- GIVEN the migration has been applied to a database with existing observations
- WHEN a SELECT query reads existing observations
- THEN the `severity` column MUST be `NULL` for pre-existing rows
- AND no error MUST occur

---

### R43: Add `severity` Column to SQLite Schema

The SQLite schema in `packages/core/src/memory/sqlite.ts` MUST be updated to include `severity TEXT` in the `CREATE TABLE IF NOT EXISTS memory_observations` statement.

For existing SQLite databases, an `ALTER TABLE memory_observations ADD COLUMN severity TEXT` statement MUST be executed during initialization. The implementation MUST handle the case where the column already exists (e.g., by catching the "duplicate column name" error or checking the schema first).

#### Scenario: S128 — New SQLite database includes severity column

- GIVEN a fresh SQLite database is created
- WHEN the schema initialization runs
- THEN the `memory_observations` table MUST include a `severity` column of type TEXT

#### Scenario: S129 — Existing SQLite database gets severity column via migration

- GIVEN an existing SQLite database WITHOUT a `severity` column
- WHEN the application initializes the database
- THEN an `ALTER TABLE` MUST add the `severity` column
- AND existing observations MUST NOT be modified

#### Scenario: S130 — Migration is idempotent for SQLite

- GIVEN the `severity` column already exists in the SQLite database
- WHEN the application initializes the database
- THEN no error MUST occur
- AND the schema MUST remain unchanged

---

### R44: Update `saveObservation` Interface and Implementations

The `saveObservation` method in the `MemoryStorage` interface (`packages/core/src/types.ts`) MUST accept an optional `severity` field:

```typescript
saveObservation(data: {
  sessionId?: number;
  project: string;
  type: string;
  title: string;
  content: string;
  topicKey?: string;
  filePaths?: string[];
  severity?: string;  // NEW
}): Promise<MemoryObservationRow>;
```

The PostgreSQL implementation in `packages/db/src/queries.ts` MUST:
- Include `severity` in the INSERT statement when provided
- Preserve existing `severity` value during topic-key upsert (update to new severity if provided)
- Include `severity` in the returned row

The SQLite implementation in `packages/core/src/memory/sqlite.ts` MUST:
- Include `severity` in the INSERT statement when provided
- Store `NULL` when severity is not provided

The `persistReviewObservations()` function in `packages/core/src/memory/persist.ts` MUST pass `finding.severity` to `saveObservation()` for each finding observation. The summary observation (PR review) MAY omit severity or use `null`.

#### Scenario: S131 — Severity persisted through pipeline

- GIVEN a review finding with `severity: 'high'`
- WHEN `persistReviewObservations()` calls `saveObservation()`
- THEN the `data` argument MUST include `severity: 'high'`
- AND the stored observation MUST have `severity: 'high'`

#### Scenario: S132 — Summary observation has no severity

- GIVEN a review with significant findings
- WHEN `persistReviewObservations()` saves the summary observation ("PR #N review: status")
- THEN the `data` argument SHOULD NOT include `severity` or SHOULD include `severity: undefined`
- AND the stored observation MUST have `severity: NULL`

#### Scenario: S133 — Topic-key upsert preserves/updates severity

- GIVEN an existing observation with `topicKey: 'auth-pattern'` and `severity: 'high'`
- WHEN a new observation with `topicKey: 'auth-pattern'` and `severity: 'medium'` is saved
- THEN the existing observation MUST be updated with `severity: 'medium'`

---

### R45: Update Type Definitions

The `MemoryObservationRow` interface in `packages/core/src/types.ts` MUST be extended with:
```typescript
severity: string | null;
```

The `MemoryObservationDetail` interface in `packages/core/src/types.ts` MUST be extended with:
```typescript
severity: string | null;
```

The `Observation` interface in `apps/dashboard/src/lib/types.ts` MUST be extended with:
```typescript
severity: string | null;
topicKey: string | null;
revisionCount: number;
updatedAt: string;
```

The `MemorySession` interface in `apps/dashboard/src/lib/types.ts` SHOULD be extended with:
```typescript
severityCounts?: Record<string, number>;  // e.g., { critical: 2, high: 5, medium: 3 }
```

#### Scenario: S134 — Dashboard receives severity in observation data

- GIVEN the API returns observations with the `severity` field
- WHEN the Dashboard renders observation cards
- THEN each observation object MUST have a `severity` property (string or null)

---

### R46: Update Queries to Include Severity

The `getObservationsBySession` function in `packages/db/src/queries.ts` MUST include the `severity` column in its SELECT results.

The `searchObservations` function in `packages/db/src/queries.ts` MUST include the `severity` column in its returned `MemoryObservationRow[]`.

The `getSessionsByProject` function in `packages/db/src/queries.ts` SHOULD be enhanced to return severity distribution per session. This MAY be implemented as:
- A subquery that counts observations by severity for each session
- A JSON aggregate column: `severityCounts`

The `mapToDetail` function in `packages/core/src/memory/sqlite.ts` MUST map the `severity` column to the `MemoryObservationDetail.severity` field.

#### Scenario: S135 — Observations returned with severity

- GIVEN a session has observations with severities: `critical`, `high`, `medium`, and `NULL`
- WHEN `getObservationsBySession(db, sessionId)` is called
- THEN each returned observation MUST include a `severity` field
- AND observations with severity MUST return the severity string
- AND observations without severity MUST return `null`

#### Scenario: S136 — Session severity distribution

- GIVEN a session has 2 `critical`, 3 `high`, and 1 `medium` observation
- WHEN `getSessionsByProject(db, project)` is called
- THEN the session entry SHOULD include severity counts: `{ critical: 2, high: 3, medium: 1 }`

#### Scenario: S137 — SQLite mapToDetail includes severity

- GIVEN a SQLite observation row with `severity: 'medium'`
- WHEN `mapToDetail()` is called
- THEN the returned `MemoryObservationDetail` MUST have `severity: 'medium'`

#### Scenario: S138 — SQLite mapToDetail handles NULL severity

- GIVEN a SQLite observation row with no `severity` column value (NULL)
- WHEN `mapToDetail()` is called
- THEN the returned `MemoryObservationDetail` MUST have `severity: null`

---

### R47: Dashboard — Severity Badge on ObservationCard

Each `ObservationCard` in `apps/dashboard/src/pages/Memory.tsx` MUST display a severity badge when the observation has a non-null severity.

The badge MUST:
- Use the existing `SeverityBadge` component from `apps/dashboard/src/components/SeverityBadge.tsx`
- Be positioned in the card header area, next to the observation type badge
- NOT be rendered when severity is `null`

#### Scenario: S139 — Severity badge displayed for observation with severity

- GIVEN an observation with `severity: 'high'`
- WHEN the `ObservationCard` renders
- THEN a severity badge with text "High" and orange styling MUST be visible
- AND the badge MUST use the `SeverityBadge` component

#### Scenario: S140 — No severity badge for NULL severity

- GIVEN an observation with `severity: null`
- WHEN the `ObservationCard` renders
- THEN no severity badge MUST be shown
- AND the card MUST still render correctly with the type badge only

---

### R48: Dashboard — PR Link on ObservationCard and SessionItem

Each `ObservationCard` SHOULD display a PR link badge (e.g., "PR #42") when the observation's session has a `prNumber`.

Each `SessionItem` MUST display a PR link (e.g., "PR #42") linking to `https://github.com/{project}/pull/{prNumber}` when `prNumber` is available.

#### Scenario: S141 — PR link displayed on SessionItem

- GIVEN a session with `project: 'acme/widgets'` and `prNumber: 42`
- WHEN the `SessionItem` renders
- THEN a clickable "PR #42" link MUST be visible
- AND clicking it MUST open `https://github.com/acme/widgets/pull/42` in a new tab

#### Scenario: S142 — No PR link when prNumber is absent

- GIVEN a session with `prNumber: null` or `prNumber: 0`
- WHEN the `SessionItem` renders
- THEN no PR link MUST be shown

---

### R49: Dashboard — Enhanced ObservationCard Display

Each `ObservationCard` MUST be enhanced with the following display improvements:

1. **Revision count badge**: When `revisionCount > 1`, display a badge like "3 revisions"
2. **File path chips**: Display file paths as styled chips/tags (not plain text)
3. **Content styling**: Observation content MUST use `font-mono` for code-like formatting with `whitespace-pre-wrap`
4. **Relative timestamps**: Display `createdAt` as relative time (e.g., "2 hours ago", "3 days ago") using `Intl.RelativeTimeFormat`

The card MUST remain clickable to open the observation detail modal (R50).

#### Scenario: S143 — Revision count badge shown for revised observations

- GIVEN an observation with `revisionCount: 5`
- WHEN the `ObservationCard` renders
- THEN a "5 revisions" badge MUST be visible

#### Scenario: S144 — No revision badge for single-revision observations

- GIVEN an observation with `revisionCount: 1`
- WHEN the `ObservationCard` renders
- THEN no revision count badge MUST be shown

#### Scenario: S145 — Relative timestamp display

- GIVEN an observation created 3 hours ago
- WHEN the `ObservationCard` renders
- THEN the timestamp MUST display as "3 hours ago" (or similar relative format)
- AND the full ISO timestamp SHOULD be available as a tooltip (via `title` attribute)

#### Scenario: S146 — File paths displayed as chips

- GIVEN an observation with `filePaths: ['src/auth.ts', 'src/middleware.ts']`
- WHEN the `ObservationCard` renders
- THEN "src/auth.ts" and "src/middleware.ts" MUST be displayed as styled chip elements
- AND the chips MUST use `font-mono` styling

---

### R50: Dashboard — Observation Detail Modal

A new observation detail modal MUST be created at `apps/dashboard/src/components/ObservationDetailModal.tsx`.

The modal MUST open when the user clicks on an `ObservationCard`.

The modal MUST display:
- Observation title (large heading)
- Severity badge (using `SeverityBadge` component, if severity is non-null)
- Type badge
- Full content with code-like formatting (`font-mono`, `whitespace-pre-wrap`)
- All file paths (each as a styled element)
- Topic key (if non-null), displayed with a label: "Topic: {topicKey}"
- Revision count (e.g., "Revision 3 of this topic")
- Created at timestamp (both relative and absolute)
- Updated at timestamp (both relative and absolute, if different from createdAt)

The modal MUST:
- Be rendered via a portal/overlay pattern (consistent with existing `ConfirmDialog`)
- Have a semi-transparent backdrop
- Be closeable by clicking the backdrop, pressing Escape, or clicking an X button
- Be vertically scrollable if content overflows
- Follow the dark theme design of the dashboard

#### Scenario: S147 — Detail modal opens on card click

- GIVEN the user is viewing observations for a session
- WHEN the user clicks on an `ObservationCard`
- THEN a detail modal MUST open with the full observation details
- AND the modal MUST be centered on screen with a backdrop

#### Scenario: S148 — Detail modal displays all fields

- GIVEN an observation with:
  - `severity: 'critical'`
  - `type: 'bugfix'`
  - `title: 'Null pointer in auth middleware'`
  - `content: '[CRITICAL] bug\nFile: src/auth.ts:42\nIssue: Null pointer...'`
  - `filePaths: ['src/auth.ts']`
  - `topicKey: 'auth-null-check'`
  - `revisionCount: 3`
  - `createdAt: '2026-03-01T10:00:00Z'`
  - `updatedAt: '2026-03-05T14:30:00Z'`
- WHEN the detail modal is open for this observation
- THEN all fields MUST be visible with appropriate formatting
- AND the severity badge MUST be red ("Critical")
- AND the topic key MUST be displayed as "Topic: auth-null-check"
- AND the revision count MUST be displayed as "Revision 3 of this topic"

#### Scenario: S149 — Detail modal handles NULL fields gracefully

- GIVEN an observation with `severity: null`, `topicKey: null`, `revisionCount: 1`
- WHEN the detail modal is open for this observation
- THEN no severity badge MUST be shown
- AND no topic key section MUST be shown
- AND no revision information MUST be shown (or it SHOULD show "1 revision")

#### Scenario: S150 — Close detail modal with Escape

- GIVEN the observation detail modal is open
- WHEN the user presses the Escape key
- THEN the modal MUST close
- AND the observations list MUST be visible again

#### Scenario: S151 — Close detail modal with backdrop click

- GIVEN the observation detail modal is open
- WHEN the user clicks on the backdrop (outside the modal content)
- THEN the modal MUST close

---

### R51: Dashboard — Stats Bar

A stats bar MUST be displayed at the top of the observations area in the Memory page.

The stats bar MUST show:
- **Total count**: "N observations" where N is the total count of observations in the current view
- **Severity breakdown**: Color-coded count chips for each severity level present (e.g., red "3 critical", orange "5 high", yellow "2 medium")
- **Type breakdown**: Count chips for each observation type present (e.g., "4 pattern", "2 bugfix", "1 learning")

The stats bar MUST update dynamically when filters (severity filter, type filter) change — it SHOULD reflect the filtered subset, not the total.

#### Scenario: S152 — Stats bar displays counts

- GIVEN the current view has 10 observations: 2 critical, 3 high, 5 medium; 4 pattern, 3 bugfix, 3 learning
- WHEN the stats bar renders
- THEN it MUST display "10 observations"
- AND severity chips: "2 critical" (red), "3 high" (orange), "5 medium" (yellow)
- AND type chips: "4 pattern", "3 bugfix", "3 learning"

#### Scenario: S153 — Stats bar updates with filters

- GIVEN the severity filter is set to "Critical"
- AND 2 of 10 observations are critical
- WHEN the stats bar renders
- THEN it MUST display "2 observations"
- AND only the "2 critical" severity chip MUST be shown

---

### R52: Dashboard — Severity Filter

A severity filter dropdown MUST be added to the Memory page alongside the existing type filter.

The filter MUST:
- Display options: "All severities" (default), "Critical", "High", "Medium", "Low", "Info"
- Filter the observation list client-side
- Persist the selected value while the page is active (reset on navigation away)
- Work independently of and in combination with the existing type filter

#### Scenario: S154 — Filter by single severity

- GIVEN the observations list contains observations with critical, high, and medium severities
- WHEN the user selects "High" from the severity filter
- THEN only observations with `severity: 'high'` MUST be displayed
- AND the stats bar MUST update to reflect the filtered subset

#### Scenario: S155 — Filter shows observations with NULL severity

- GIVEN some observations have `severity: null`
- WHEN the "All severities" filter is selected (default)
- THEN all observations MUST be shown, including those with NULL severity

#### Scenario: S156 — Combined severity + type filter

- GIVEN observations exist with various severities and types
- WHEN the user selects severity "Critical" AND type "bugfix"
- THEN only observations matching BOTH criteria MUST be displayed

---

### R53: Dashboard — Sort Options

Sort options MUST be provided for the observation list in the Memory page.

The available sort options MUST be:
- **Newest first** (default): Sort by `createdAt` descending
- **Oldest first**: Sort by `createdAt` ascending
- **Severity**: Sort by severity level descending (critical > high > medium > low > info > null)
- **Most revised**: Sort by `revisionCount` descending

The sort MUST be applied client-side after filtering.

#### Scenario: S157 — Sort by severity

- GIVEN observations with severities: medium, critical, null, high
- WHEN the user selects "Severity" sort
- THEN the observations MUST be ordered: critical, high, medium, null

#### Scenario: S158 — Sort by most revised

- GIVEN observations with revision counts: 1, 5, 3, 2
- WHEN the user selects "Most revised" sort
- THEN the observations MUST be ordered: 5, 3, 2, 1

#### Scenario: S159 — Default sort is newest first

- GIVEN the user has not changed the sort option
- THEN observations MUST be sorted by `createdAt` descending (newest first)

---

### R54: Dashboard — SessionItem Enhancements

Each `SessionItem` in the Memory page MUST be enhanced with:

1. **PR link**: Clickable link to the GitHub PR (R48)
2. **Severity summary**: Small colored dots or count text showing the distribution of severities in that session (e.g., "2● 3● 1●" with critical=red, high=orange, medium=yellow dots)

#### Scenario: S160 — Session shows severity summary

- GIVEN a session with observations: 1 critical, 2 high, 3 medium
- WHEN the `SessionItem` renders
- THEN severity summary indicators MUST be visible
- AND they MUST use the correct colors (red for critical, orange for high, yellow for medium)

#### Scenario: S161 — Session with no severity data

- GIVEN a session where all observations have `severity: null` (pre-existing data)
- WHEN the `SessionItem` renders
- THEN no severity summary MUST be shown (or a neutral "no severity data" indicator)

---

### R55: Dashboard — Relative Time Formatting

Relative time formatting MUST be implemented using the browser's built-in `Intl.RelativeTimeFormat` API.

A utility function MUST be created (e.g., `formatRelativeTime(date: string): string`) that:
- Accepts an ISO 8601 date string
- Returns a human-readable relative time string (e.g., "2 hours ago", "3 days ago", "just now")
- Handles edge cases: future dates, very old dates (> 1 year)

No external date libraries (moment.js, dayjs, date-fns) MUST be added.

#### Scenario: S162 — Recent timestamp

- GIVEN a timestamp from 45 minutes ago
- WHEN `formatRelativeTime()` is called
- THEN it MUST return "45 minutes ago" (or similar)

#### Scenario: S163 — Old timestamp

- GIVEN a timestamp from 30 days ago
- WHEN `formatRelativeTime()` is called
- THEN it MUST return "30 days ago" or "1 month ago" (either is acceptable)

---

### Cross-Cutting Concerns (Memory Detail View)

#### CC14: Backward Compatibility with NULL Severity

All code paths that read observations MUST handle `severity: null` gracefully:
- Dashboard components: conditional rendering (show badge only if severity is non-null)
- Sort by severity: NULL values sort last
- Filter by severity: "All severities" includes NULL severity observations
- Stats bar: observations with NULL severity are counted but not included in severity breakdown chips

#### CC15: Severity Type Safety

The `SeverityBadge` component accepts `Finding['severity']` (typed as `'critical' | 'high' | 'medium' | 'low' | 'info'`), but observation severity is `string | null`. A type guard MUST be used before passing severity to `SeverityBadge`:

```typescript
const validSeverities = ['critical', 'high', 'medium', 'low', 'info'] as const;
function isValidSeverity(s: string | null): s is Finding['severity'] {
  return s != null && validSeverities.includes(s as any);
}
```

#### CC16: No New Dependencies

This change MUST NOT add any new npm dependencies. All functionality uses existing packages and browser APIs:
- `Intl.RelativeTimeFormat` for relative time formatting
- Existing `SeverityBadge` component for severity display
- Existing Tailwind CSS for all styling
- Existing `cn()` utility for conditional classes

#### CC17: Dark Theme Consistency

All new UI elements MUST follow the existing dark theme design:
- Background: `bg-gray-900`, `bg-gray-800` for cards
- Text: `text-gray-100`, `text-gray-400` for secondary
- Borders: `border-gray-700`
- Severity colors from existing `SeverityBadge` (red/orange/yellow/blue/gray with opacity)

#### CC18: Modal Pattern Consistency

The observation detail modal MUST follow the same portal/overlay pattern established by the existing `ConfirmDialog` component:
- Portal rendering to `document.body`
- Backdrop with `bg-black/50` (or similar)
- Centered with `flex items-center justify-center`
- Escape key and backdrop click to close
- Scroll handling for long content

---

### Edge Cases (Memory Detail View)

#### E11: Observation with very long content

- GIVEN an observation with content exceeding 5000 characters
- WHEN the detail modal is open
- THEN the modal MUST be scrollable
- AND the content MUST NOT overflow the viewport

##### Scenario: S164

- GIVEN an observation with 10,000 character content
- WHEN the detail modal is rendered
- THEN vertical scrolling MUST be available within the modal

#### E12: Observation with many file paths

- GIVEN an observation with 20+ file paths
- WHEN the ObservationCard renders
- THEN file paths SHOULD be truncated (e.g., show first 3 + "and 17 more")
- AND the detail modal MUST show all file paths

##### Scenario: S165

- GIVEN an observation with 25 file paths
- WHEN the ObservationCard renders
- THEN it SHOULD display at most 5 file paths with a "+20 more" indicator

#### E13: Session with 0 observations (after deletion)

- GIVEN a session where all observations have been deleted
- WHEN the SessionItem renders
- THEN it MUST show "0 observations" and no severity summary

##### Scenario: S166

- GIVEN a session with 0 observations
- WHEN the stats bar renders for that session's view
- THEN it MUST show "0 observations" with no severity or type chips

#### E14: All observations have NULL severity

- GIVEN a project where all observations pre-date the severity feature
- WHEN the Memory page renders
- THEN no severity badges MUST be shown on any cards
- AND the severity filter SHOULD still be available but filtering to any specific severity yields empty results
- AND the stats bar MUST NOT show any severity chips

##### Scenario: S167

- GIVEN 10 observations all with `severity: null`
- WHEN the severity filter is set to "Critical"
- THEN 0 observations MUST be displayed
- AND the stats bar MUST show "0 observations"

---

### Acceptance Criteria (Memory Detail View)

59. `isSignificantFinding()` returns `true` for `'medium'` severity
60. `severity` varchar(10) nullable column exists in PostgreSQL `memory_observations` table
61. `severity` TEXT nullable column exists in SQLite `memory_observations` table
62. Migration `0006_add_severity_column.sql` applies cleanly and is idempotent
63. SQLite migration adds `severity` column to existing databases without error
64. `saveObservation()` accepts and persists optional `severity` field
65. `persistReviewObservations()` passes `finding.severity` to `saveObservation()` for each finding
66. `MemoryObservationRow` and `MemoryObservationDetail` include `severity: string | null`
67. Dashboard `Observation` type includes `severity`, `topicKey`, `revisionCount`, `updatedAt`
68. `getObservationsBySession` returns observations with `severity` field
69. `getSessionsByProject` returns severity distribution per session
70. `SeverityBadge` displayed on `ObservationCard` when severity is non-null
71. No severity badge shown when severity is `null`
72. PR link displayed on `SessionItem` when `prNumber` is available
73. Revision count badge shown when `revisionCount > 1`
74. File paths displayed as styled chips on `ObservationCard`
75. Content uses `font-mono` formatting
76. Relative timestamps using `Intl.RelativeTimeFormat` (no external date library)
77. Observation detail modal opens on card click with all fields
78. Detail modal closes with Escape, backdrop click, or X button
79. Stats bar displays total count, severity breakdown, and type breakdown
80. Severity filter dropdown works independently and with type filter
81. Sort options: newest first, oldest first, severity, most revised
82. NULL severity handled gracefully throughout (no badge, sorts last, "All" filter includes it)
83. Dark theme consistency maintained
84. No new npm dependencies
85. All new code has tests
86. Existing tests continue passing

---
---

## Extension: Engram Memory Adapter — Shared Memory Across the Developer Ecosystem

> **Origin**: Archived from `engram-adapter` change (2026-03-07)
> **Depends on**: Memory Management extension above (which added `MemoryStorage` management methods + CLI commands)

This section defines a third `MemoryStorage` adapter — `EngramMemoryStorage` — that communicates with Engram's HTTP API, enabling GHAGGA to participate in the shared memory ecosystem used by Claude Code, OpenCode, Gemini CLI, GGA, and other MCP-compatible tools. The adapter lives in `packages/core/src/memory/engram.ts`, is selected via `--memory-backend engram` or `GHAGGA_MEMORY_BACKEND=engram`, and degrades gracefully to SQLite when Engram is unreachable. CLI integration is defined in R6.6–R6.8 above.

---

### Requirements

#### R56: EngramMemoryStorage Implementation

The system MUST provide an `EngramMemoryStorage` class in `packages/core/src/memory/engram.ts` that implements the `MemoryStorage` interface by communicating with Engram's HTTP API.

The class MUST use Node.js built-in `fetch` (no new dependencies). It MUST NOT require any changes to the `MemoryStorage` interface — it implements the existing contract as-is.

##### Scenario: Instantiation with healthy Engram server

- GIVEN Engram is running at `http://localhost:7437`
- AND `GET /api/stats` returns a 200 response
- WHEN `EngramMemoryStorage.create({ baseUrl: 'http://localhost:7437', fallbackToSqlite: true, sqlitePath: '/path/to/memory.db' })` is called
- THEN it MUST return an `EngramMemoryStorage` instance
- AND the instance MUST be ready for all `MemoryStorage` operations

##### Scenario: Instantiation with unreachable Engram server and fallback enabled

- GIVEN Engram is not running (connection refused on `http://localhost:7437`)
- AND `fallbackToSqlite` is `true`
- AND `sqlitePath` is provided
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN a warning MUST be logged: `[ghagga] Engram not available at <baseUrl>: <error message>`
- AND a second warning MUST be logged: `[ghagga] Falling back to SQLite memory`
- AND the method MUST return a `SqliteMemoryStorage` instance (not `EngramMemoryStorage`)

##### Scenario: Instantiation with unreachable Engram server and fallback disabled

- GIVEN Engram is not running
- AND `fallbackToSqlite` is `false`
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN a warning MUST be logged
- AND the method MUST return `undefined` (memory disabled)

##### Scenario: Instantiation with Engram returning non-200 on health check

- GIVEN Engram is running but `GET /api/stats` returns HTTP 500
- WHEN `EngramMemoryStorage.create(...)` is called
- THEN it MUST treat this as Engram unavailable
- AND follow the fallback logic (same as unreachable server)

---

#### R57: Engram HTTP API Mapping

Each `MemoryStorage` method MUST map to the corresponding Engram HTTP endpoint as specified below. All HTTP calls MUST include a configurable timeout (default: 5 seconds).

##### R57.1: searchObservations

`searchObservations(project, query, options?)` MUST send `GET /api/search` with query parameters `q=<query>&limit=<limit>`.

Results MUST be filtered client-side to include only observations where `project` matches the provided project parameter (extracted from structured content metadata or Engram's `project` field).

When `options.type` is provided, results MUST be further filtered client-side by observation type.

##### Scenario: Search with results from mixed sources

- GIVEN Engram contains 5 observations: 3 saved by GHAGGA for project "acme/widgets", 1 saved by Claude Code for project "acme/widgets", 1 saved by GHAGGA for project "acme/gadgets"
- WHEN `searchObservations("acme/widgets", "auth", { limit: 10 })` is called
- THEN Engram's `/api/search?q=auth&limit=10` MUST be called
- AND results MUST be filtered to include only observations where project = "acme/widgets"
- AND both GHAGGA-origin and Claude Code-origin observations MUST be included (4 max)
- AND the "acme/gadgets" observation MUST NOT be included
- AND each returned row MUST conform to the `MemoryObservationRow` interface

##### Scenario: Search with type filter

- GIVEN Engram contains observations of types "pattern", "bugfix", "learning" for project "acme/widgets"
- WHEN `searchObservations("acme/widgets", "auth", { limit: 10, type: "pattern" })` is called
- THEN only observations where `type = "pattern"` MUST be returned

##### Scenario: Search returns empty results

- GIVEN Engram has no observations matching the query
- WHEN `searchObservations("acme/widgets", "xyznonexistent")` is called
- THEN an empty array MUST be returned

##### Scenario: Search with Engram HTTP error

- GIVEN Engram returns HTTP 500 on the search request
- WHEN `searchObservations(...)` is called
- THEN a warning MUST be logged
- AND an empty array MUST be returned (graceful degradation)
- AND the review MUST NOT be blocked

##### R57.2: saveObservation

`saveObservation(data)` MUST send `POST /api/save` with the mapped body.

The request body MUST include:
- `type`: mapped directly from `data.type`
- `title`: mapped directly from `data.title`
- `content`: mapped directly from `data.content`
- `topic_key`: mapped from `data.topicKey` (field rename)
- `project`: mapped directly from `data.project`
- `scope`: set to `data.project` (reuse project as scope)

Fields without native Engram equivalents MUST be encoded in a structured metadata section appended to the `content` field or passed through Engram's metadata capability:
- `severity`: MUST be preserved (via metadata or structured content)
- `filePaths`: MUST be preserved (via metadata or structured content)
- `sessionId`: MUST be preserved (via metadata)

The response MUST be mapped back to a `MemoryObservationRow`.

##### Scenario: Save a GHAGGA observation to Engram

- GIVEN Engram is running and healthy
- WHEN `saveObservation({ project: "acme/widgets", type: "pattern", title: "Auth config", content: "OAuth patterns observed", topicKey: "pr-42-review", filePaths: ["src/auth.ts"], severity: "medium" })` is called
- THEN `POST /api/save` MUST be called with a body containing `type: "pattern"`, `title: "Auth config"`, `content` containing "OAuth patterns observed", and `topic_key: "pr-42-review"`
- AND `severity` and `filePaths` MUST be preserved in the saved data
- AND `project` MUST be set to "acme/widgets"
- AND the returned `MemoryObservationRow` MUST have `id`, `type`, `title`, `content`, `filePaths`, and `severity` populated

##### Scenario: Save with Engram HTTP error

- GIVEN Engram returns HTTP 500 on the save request
- WHEN `saveObservation(...)` is called
- THEN a warning MUST be logged with the error details
- AND the method MUST return a synthetic `MemoryObservationRow` with `id: -1` (indicating failure)
- AND the review MUST NOT be blocked

##### Scenario: Save observation without optional fields

- GIVEN `topicKey`, `filePaths`, `severity`, and `sessionId` are all omitted
- WHEN `saveObservation({ project: "acme/widgets", type: "learning", title: "TIL", content: "Today I learned..." })` is called
- THEN the request MUST succeed with only the required fields
- AND optional metadata fields MUST be absent or null in the request

##### R57.3: createSession

`createSession(data)` MUST send `POST /api/sessions` with body `{ project: data.project }`.

The GHAGGA `prNumber` field SHOULD be included in the session metadata if Engram supports metadata on sessions.

The response MUST return `{ id: number }` mapped from Engram's session ID.

##### Scenario: Create a review session

- GIVEN Engram is running
- WHEN `createSession({ project: "acme/widgets", prNumber: 42 })` is called
- THEN `POST /api/sessions` MUST be called with `{ project: "acme/widgets" }`
- AND the response MUST include a numeric session ID
- AND `{ id: <sessionId> }` MUST be returned

##### Scenario: Create session with Engram error

- GIVEN Engram returns HTTP 500
- WHEN `createSession(...)` is called
- THEN a warning MUST be logged
- AND `{ id: -1 }` MUST be returned (indicating failure)

##### R57.4: endSession

`endSession(sessionId, summary)` MUST send `POST /api/sessions/<sessionId>/summary` with body `{ summary }`.

##### Scenario: End a review session

- GIVEN a session with ID 7 was previously created
- WHEN `endSession(7, "Review complete: 3 patterns, 1 bugfix")` is called
- THEN `POST /api/sessions/7/summary` MUST be called with body `{ summary: "Review complete: 3 patterns, 1 bugfix" }`

##### Scenario: End session with invalid session ID

- GIVEN the session ID -1 was returned from a failed createSession
- WHEN `endSession(-1, "...")` is called
- THEN the call MUST be a no-op (skip the HTTP request)
- AND no error MUST be thrown

##### Scenario: End session with Engram error

- GIVEN Engram returns HTTP 404 for the session ID
- WHEN `endSession(sessionId, summary)` is called
- THEN a warning MUST be logged
- AND no error MUST be thrown

##### R57.5: getObservation

`getObservation(id)` MUST send `GET /api/observations/<id>`.

The Engram response MUST be mapped to `MemoryObservationDetail`.

##### Scenario: Get existing observation

- GIVEN Engram has observation ID 42 saved by GHAGGA with structured content
- WHEN `getObservation(42)` is called
- THEN `GET /api/observations/42` MUST be called
- AND the response MUST be mapped to a `MemoryObservationDetail` with all fields populated
- AND `filePaths` and `severity` MUST be extracted from structured content

##### Scenario: Get non-GHAGGA observation

- GIVEN Engram has observation ID 99 saved by Claude Code with plain text content
- WHEN `getObservation(99)` is called
- THEN the content MUST be treated as plain text (JSON parse fails gracefully)
- AND `type` MUST default to the Engram observation's type or `"observation"`
- AND `filePaths` MUST be `null`
- AND `severity` MUST be `null`
- AND `revisionCount` MUST be `1`

##### Scenario: Get non-existent observation

- GIVEN Engram returns HTTP 404 for observation ID 999
- WHEN `getObservation(999)` is called
- THEN `null` MUST be returned

##### R57.6: deleteObservation

`deleteObservation(id)` MUST send `DELETE /api/observations/<id>`.

##### Scenario: Delete existing observation

- GIVEN Engram has observation ID 42
- WHEN `deleteObservation(42)` is called
- THEN `DELETE /api/observations/42` MUST be called
- AND `true` MUST be returned

##### Scenario: Delete non-existent observation

- GIVEN Engram returns HTTP 404 for observation ID 999
- WHEN `deleteObservation(999)` is called
- THEN `false` MUST be returned

##### R57.7: listObservations

`listObservations(options?)` MUST send `GET /api/search` with appropriate filters to retrieve observations.

Results MUST be filtered client-side by `project` and `type` when those options are provided. Pagination (`limit`, `offset`) MUST be applied client-side if Engram's search API does not support offset natively.

##### Scenario: List all observations

- GIVEN Engram contains 30 observations across multiple projects
- WHEN `listObservations({ limit: 20, offset: 0 })` is called
- THEN at most 20 `MemoryObservationDetail` records MUST be returned
- AND results MUST be ordered newest first

##### Scenario: List with project filter

- GIVEN Engram contains observations for "acme/widgets" and "acme/gadgets"
- WHEN `listObservations({ project: "acme/widgets", limit: 10 })` is called
- THEN only observations for "acme/widgets" MUST be returned

##### R57.8: getStats

`getStats()` MUST send `GET /api/stats` and map the response to `MemoryStats`.

The Engram stats response MUST be transformed to include `totalObservations`, `byType`, `byProject`, `oldestObservation`, and `newestObservation`.

If Engram's stats endpoint does not provide all fields natively, the adapter MAY make additional requests or return partial data with sensible defaults.

##### Scenario: Get stats from populated Engram

- GIVEN Engram has 150 observations across 3 projects and 4 types
- WHEN `getStats()` is called
- THEN `GET /api/stats` MUST be called
- AND the returned `MemoryStats` MUST have `totalObservations >= 150`
- AND `byType` and `byProject` MUST be populated

##### Scenario: Get stats from empty Engram

- GIVEN Engram has no observations
- WHEN `getStats()` is called
- THEN `totalObservations` MUST be `0`
- AND `byType` and `byProject` MUST be empty objects
- AND `oldestObservation` and `newestObservation` MUST be `null`

##### R57.9: clearObservations

`clearObservations(options?)` MUST throw an `Error` with message: `'clearObservations not supported with Engram backend. Use engram CLI directly.'`

Engram's HTTP API does not provide a bulk delete endpoint. Users MUST use `engram tui` or `engram` CLI for bulk management.

##### Scenario: Attempt to clear observations

- GIVEN the Engram adapter is active
- WHEN `clearObservations()` is called
- THEN an `Error` MUST be thrown with message `'clearObservations not supported with Engram backend. Use engram CLI directly.'`

##### Scenario: Attempt to clear observations scoped to project

- GIVEN the Engram adapter is active
- WHEN `clearObservations({ project: "acme/widgets" })` is called
- THEN the same `Error` MUST be thrown (no support regardless of options)

##### R57.10: close

`close()` MUST be a no-op. HTTP is stateless; there are no resources to release.

##### Scenario: Close the adapter

- GIVEN an active `EngramMemoryStorage` instance
- WHEN `close()` is called
- THEN no error MUST be thrown
- AND no HTTP request MUST be made

---

#### R58: Schema Mapping Layer

The adapter MUST include a bidirectional mapping layer that translates between GHAGGA's memory model and Engram's observation model.

##### R58.1: GHAGGA-to-Engram Mapping (on save)

When saving, the adapter MUST map GHAGGA fields to Engram fields:

| GHAGGA Field | Engram Field | Mapping |
|---|---|---|
| `type` | `type` | Direct |
| `title` | `title` | Direct |
| `content` | `content` | Wrapped in structured JSON with `source`, `body`, `severity`, `filePaths`, and `project` |
| `topicKey` | `topic_key` | Rename |
| `project` | `project` | Direct |
| `filePaths` | (in content) | Encoded in structured content JSON |
| `severity` | (in content) | Encoded in structured content JSON |

The structured content JSON MUST follow the format:

```json
{
  "source": "ghagga",
  "title": "<title>",
  "body": "<original content>",
  "severity": "<severity or null>",
  "filePaths": ["<paths>"],
  "project": "<project>"
}
```

##### R58.2: Engram-to-GHAGGA Mapping (on read)

When reading, the adapter MUST attempt to parse the `content` field as JSON. If parsing succeeds and the JSON has `source: "ghagga"`, the adapter MUST extract `title`, `body`, `severity`, `filePaths`, and `project` from the structured content.

If JSON parsing fails (content from another tool like Claude Code or GGA), the adapter MUST:
- Use the raw content as-is for `content`
- Extract `title` from the Engram observation's title field, or fall back to the first 80 characters of content
- Set `filePaths` to `null`
- Set `severity` to `null`
- Set `revisionCount` to `1` (Engram does not track revisions)
- Derive `project` from Engram's `project` field or metadata, defaulting to `"unknown"`

##### Scenario: Round-trip GHAGGA observation through Engram

- GIVEN a GHAGGA observation is saved with `severity: "high"`, `filePaths: ["src/auth.ts", "lib/pool.ts"]`, and `content: "OAuth refresh token not rotated"`
- WHEN the same observation is read back from Engram
- THEN `severity` MUST be `"high"`
- AND `filePaths` MUST be `["src/auth.ts", "lib/pool.ts"]`
- AND `content` MUST be `"OAuth refresh token not rotated"`

##### Scenario: Read non-GHAGGA observation from Engram

- GIVEN an observation in Engram was saved by Claude Code with plain text content "Always use parameterized queries for SQL"
- WHEN the adapter reads this observation
- THEN `content` MUST be `"Always use parameterized queries for SQL"`
- AND `type` MUST be the Engram observation's type or `"observation"`
- AND `filePaths` MUST be `null`
- AND `severity` MUST be `null`

##### Scenario: Read observation with malformed JSON content

- GIVEN an observation in Engram has content `"{ invalid json"`
- WHEN the adapter reads this observation
- THEN the adapter MUST NOT throw
- AND the raw content MUST be used as-is
- AND default mappings MUST be applied for `filePaths`, `severity`, etc.

---

#### R59: HTTP Timeout and Error Resilience

All HTTP requests to Engram MUST use a configurable timeout. Individual method failures MUST NOT propagate as thrown exceptions (except `clearObservations` which intentionally throws).

##### R59.1: Timeout Configuration

The timeout MUST default to 5 seconds. It MUST be configurable via `GHAGGA_ENGRAM_TIMEOUT` environment variable (value in seconds).

##### R59.2: Error Handling Policy

Every HTTP request MUST be wrapped in error handling. On any HTTP or network error:
- A warning MUST be logged with the method name, URL, and error message
- The method MUST return a safe default value:
  - `searchObservations` -> `[]`
  - `saveObservation` -> synthetic row with `id: -1`
  - `createSession` -> `{ id: -1 }`
  - `endSession` -> void (no-op)
  - `getObservation` -> `null`
  - `deleteObservation` -> `false`
  - `listObservations` -> `[]`
  - `getStats` -> `{ totalObservations: 0, byType: {}, byProject: {}, oldestObservation: null, newestObservation: null }`

##### Scenario: HTTP timeout on save

- GIVEN Engram takes longer than 5 seconds to respond to `POST /api/save`
- WHEN `saveObservation(...)` is called
- THEN the request MUST be aborted after the timeout
- AND a warning MUST be logged: `[ghagga] Engram saveObservation timed out after 5s`
- AND a synthetic row with `id: -1` MUST be returned
- AND the review MUST continue normally

##### Scenario: Network error on search

- GIVEN Engram's host is unreachable (DNS resolution failure)
- WHEN `searchObservations(...)` is called
- THEN a warning MUST be logged
- AND an empty array MUST be returned
- AND the review MUST continue without memory context

##### Scenario: Custom timeout via environment variable

- GIVEN `GHAGGA_ENGRAM_TIMEOUT=10` is set
- WHEN any HTTP request is made to Engram
- THEN the timeout MUST be 10 seconds (not the default 5)

---

#### R60: Engram Source Tagging

All observations saved by GHAGGA to Engram MUST be identifiable as originating from GHAGGA.

The structured content JSON MUST include `"source": "ghagga"`. This enables other tools (Engram TUI, Claude Code, GGA) to identify and filter GHAGGA-origin observations.

##### Scenario: GHAGGA observation visible in Engram TUI

- GIVEN a review is run with `--memory-backend engram`
- AND the review produces 3 observations
- WHEN the user opens `engram tui`
- THEN all 3 observations MUST be visible
- AND each MUST be identifiable as from GHAGGA (via structured content with `source: "ghagga"`)

##### Scenario: Filter GHAGGA observations in Engram search

- GIVEN Engram contains observations from GHAGGA, Claude Code, and GGA
- WHEN `GET /api/search?q=ghagga` is called
- THEN GHAGGA observations MUST match (the content contains `"source": "ghagga"`)

---

### Cross-Cutting Concerns (Engram Adapter)

#### CC19: CLI-Only Availability

The Engram adapter MUST only be available in CLI mode. The SaaS server (`apps/server/`) MUST always use `PostgresMemoryStorage`. The GitHub Action (`apps/action/`) MUST always use `SqliteMemoryStorage`. The Engram backend option MUST NOT be exposed in server or action configuration.

#### CC20: No New Dependencies (Engram Adapter)

The `EngramMemoryStorage` class MUST use Node.js built-in `fetch` for HTTP communication. No new npm dependencies MUST be added to `packages/core` or `apps/cli`.

#### CC21: Runtime-Only Dependency

Engram is a runtime dependency only when `--memory-backend engram` is selected. It MUST NOT be required at build time, install time, or test time. The adapter class MUST be importable and type-checkable without Engram running.

#### CC22: Memory Management Commands

The existing `ghagga memory list/search/show/delete/stats/clear` commands (R16-R22) are scoped to SQLite only. When the Engram backend is selected for reviews, memory management MUST still use the local SQLite database. Users MUST use `engram tui` or `engram` CLI for managing Engram observations directly. This separation is intentional: management commands operate on the local cache, reviews can optionally use the shared Engram store.

---

### Acceptance Criteria (Engram Adapter)

87. `EngramMemoryStorage` implements all `MemoryStorage` interface methods
88. `ghagga review . --memory-backend engram` uses the Engram adapter when Engram is running
89. `ghagga review . --memory-backend engram` falls back to SQLite when Engram is not running, with a warning message
90. `GHAGGA_MEMORY_BACKEND=engram ghagga review .` works via environment variable
91. Observations saved via GHAGGA appear in `engram tui` with `source: ghagga` metadata
92. Observations from Claude Code / GGA in Engram are returned by GHAGGA's memory search
93. Schema mapping correctly encodes/decodes severity, filePaths, and project in structured content
94. Non-GHAGGA observations in Engram (plain text content) are handled gracefully with default mappings
95. Individual Engram API failures log warnings but never block the review
96. Default behavior (`--memory-backend sqlite` or no flag) is completely unchanged
97. No new npm dependencies added
98. All existing tests pass without modification
99. `clearObservations()` throws a descriptive error directing users to Engram CLI
100. 149 new tests pass with 91.61% Stryker mutation score
