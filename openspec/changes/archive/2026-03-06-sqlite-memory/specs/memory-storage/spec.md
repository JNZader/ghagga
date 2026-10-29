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

| Interface Method     | Delegates To                                        |
| -------------------- | --------------------------------------------------- |
| `searchObservations` | `ghagga-db.searchObservations`                      |
| `saveObservation`    | `ghagga-db.saveObservation`                         |
| `createSession`      | `ghagga-db.createMemorySession`                     |
| `endSession`         | `ghagga-db.endMemorySession`                        |
| `close`              | No-op (PostgreSQL connection is managed externally) |

The constructor MUST accept the Drizzle `Database` instance (the existing `db` parameter used throughout the server).

The returned `MemoryObservationRow` MUST match the interface shape: `{ id, type, title, content, filePaths }`. The adapter MUST map from the full Drizzle row to this subset.

### R5: FTS5 Search Parity

#### R5.1: Keyword Matching

`SqliteMemoryStorage.searchObservations` MUST use the FTS5 virtual table to perform keyword matching against the `title` and `content` columns. The query string (space-separated keywords) MUST be converted to FTS5 match syntax (e.g., `"auth pool config"` becomes an FTS5 query matching rows containing any of those terms).

#### R5.2: BM25 Ranking

Results SHOULD be ranked by FTS5's built-in `bm25()` ranking function so that more relevant observations appear first.

#### R5.3: Project Scoping

Search results MUST be filtered to observations matching the given `project` parameter. Observations from other projects MUST NOT appear in results.

#### R5.4: Type Filtering

When `options.type` is provided, results MUST be further filtered to observations matching that type.

#### R5.5: Limit

Results MUST be capped at `options.limit` (defaulting to 10 if not specified), matching the PostgreSQL implementation's default.

#### R5.6: Parity Expectations

Exact search parity with PostgreSQL `tsvector` (English dictionary with stemming) is NOT required. FTS5 with the default `unicode61` tokenizer does not perform stemming. For the domain of code review observations (keywords like "auth", "pool", "config", "security"), exact keyword matching is sufficient.

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
