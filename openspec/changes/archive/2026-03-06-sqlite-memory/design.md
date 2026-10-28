# Design: SQLite Memory for CLI and Action

## Technical Approach

The memory system is currently hard-coupled to PostgreSQL via direct `ghagga-db` imports in `packages/core/src/memory/search.ts` and `packages/core/src/memory/persist.ts`. This design introduces a **strategy pattern**: a `MemoryStorage` interface in core that both consumers (`search.ts`, `persist.ts`) depend on, with two concrete adapters injected at the call site:
- **`SqliteMemoryStorage`** (in `packages/core`) — uses sql.js (pure WASM SQLite) with FTS5 for full-text search. Used by CLI and Action.
- **`PostgresMemoryStorage`** (in `apps/server`) — thin adapter wrapping existing `ghagga-db` query functions. Used by SaaS.

The `ReviewInput.db` field (typed `unknown`) is replaced by `ReviewInput.memoryStorage` (typed `MemoryStorage | undefined`). Core loses its `ghagga-db` dependency entirely. Each distribution mode constructs the appropriate adapter and injects it.

This maps directly to the proposal's approach and satisfies all requirements in `specs/memory-storage/spec.md` (R1–R10).

---

## Architecture Decisions

### Decision 1: sql.js Over better-sqlite3

**Choice**: Use `sql.js` (`^1.11.0`), a pure WASM compilation of SQLite.

**Alternatives considered**:
- `better-sqlite3` — native C++ addon, fastest Node.js SQLite driver. Requires `node-gyp` compilation and breaks with `@vercel/ncc` bundling (which the Action uses at `apps/action/package.json:7`).
- `libsql` / `@libsql/client` — WASM-capable but heavier dependency, designed for Turso cloud sync (unnecessary).

**Rationale**: The Action bundles everything into a single `dist/index.js` via `ncc build` (see `apps/action/package.json:7`). Native addons cannot be inlined. sql.js is pure WASM (~1MB binary), has zero native deps, ships SQLite 3.46+ (supports `RETURNING`, FTS5), and is battle-tested (Observable, Datasette, 5k+ GitHub stars). The CLI also benefits from zero-compilation installs.

### Decision 2: FTS5 with Default Tokenizer (No Porter Stemmer)

**Choice**: Use FTS5's default `unicode61` tokenizer without stemming.

**Alternatives considered**:
- FTS5 with `porter` tokenizer — adds stemming (e.g., "running" → "run"), closer to PostgreSQL's `english` tsvector dictionary.
- External stemmer library + manual tokenization.

**Rationale**: The PostgreSQL path uses `to_tsquery('english', ...)` with stemming (see `packages/db/src/queries.ts:468`). However, GHAGGA's memory observations use domain-specific keywords from code review context: "auth", "pool", "config", "security", "pattern". These are root forms that don't benefit from stemming. The spec (R5.6) explicitly states exact parity is NOT required. The `porter` tokenizer can be added later as a non-breaking change to the FTS5 `CREATE VIRTUAL TABLE` definition.

### Decision 3: MemoryStorage Interface in `types.ts` (Not Separate File)

**Choice**: Define `MemoryStorage` and `MemoryObservationRow` interfaces in `packages/core/src/types.ts`, alongside the existing `MemoryObservation` type (line 273) and `ReviewInput` (line 53).

**Alternatives considered**:
- New file `packages/core/src/memory/types.ts` — isolates memory types but splits related types across files.

**Rationale**: `types.ts` already contains `MemoryObservation` (line 273), `ObservationType` (line 264), and `ReviewInput` (line 53, which references `db`). Adding the interface here keeps all cross-cutting types in one place, following the existing convention. `ReviewInput` directly references `MemoryStorage`, so co-locating avoids circular imports.

### Decision 4: SqliteMemoryStorage in Core (Not in a Separate Package)

**Choice**: Place `SqliteMemoryStorage` in `packages/core/src/memory/sqlite.ts` and add `sql.js` as a dependency of `packages/core`.

**Alternatives considered**:
- New package `packages/sqlite-memory` — isolates the SQLite dep but adds a workspace package, turborepo config, and build step for a single-file module.
- Place in `apps/cli/src/` and `apps/action/src/` (duplicate) — violates DRY.

**Rationale**: The `SqliteMemoryStorage` is needed by both CLI and Action. Placing it in core means both consumers get it transitively. Adding `sql.js` (~1MB WASM) to core's dependencies is acceptable: it's only loaded at runtime when `SqliteMemoryStorage.create()` is called. The SaaS server never calls it (it uses `PostgresMemoryStorage`). Tree-shaking in the server's build excludes unused code.

### Decision 5: Async Factory Pattern for sql.js WASM Loading

**Choice**: Use a static async factory method `SqliteMemoryStorage.create(filePath)` instead of a constructor.

**Alternatives considered**:
- Async constructor (not possible in TypeScript/JavaScript).
- Lazy initialization on first method call — adds complexity to every method.

**Rationale**: sql.js requires async WASM initialization (`initSqlJs()` returns a Promise). A constructor cannot be async. The factory pattern is idiomatic TypeScript and matches the spec (R3.7). The constructor is private; consumers always go through `create()`.

### Decision 6: Action Cache Key Strategy — Immutable Keys, First-Writer-Wins

**Choice**: Use `@actions/cache` with key `ghagga-memory-{owner/repo}` (exact match). Accept that concurrent PRs may produce slightly stale snapshots.

**Alternatives considered**:
- Cache key with SHA or run ID suffix — would create a unique key per run, causing unbounded cache growth and losing cross-run persistence.
- Using `restore-keys` prefix matching with a date/SHA suffix — more complex, risk of restoring very stale data.

**Rationale**: `@actions/cache` keys are immutable: once saved, the same key cannot be overwritten. On concurrent PRs, the first job to call `saveCache` wins; subsequent jobs in the same key window reuse the prior snapshot. This means a concurrent PR may miss a few observations from a parallel PR — acceptable for a progressive intelligence system where marginal data loss has no correctness impact. The key is simple, deterministic, and matches the spec (R7.2). `@actions/cache` is already a dependency of the Action (`apps/action/package.json:17`).

### Decision 7: PostgresMemoryStorage in `apps/server` (Not in `packages/db`)

**Choice**: Place `PostgresMemoryStorage` in `apps/server/src/memory/postgres.ts`.

**Alternatives considered**:
- Add to `packages/db` — would couple the interface definition (in core) back to db.
- Add to `packages/core` — would re-introduce the ghagga-db dependency.

**Rationale**: The adapter imports from both `ghagga-core` (for the `MemoryStorage` interface) and `ghagga-db` (for the query functions). Only `apps/server` has both dependencies. Placing it in the server keeps the dependency graph clean: `core → (no db)`, `server → core + db`.

### Decision 8: Fire-and-Forget Persist Pattern Preserved

**Choice**: Keep the existing fire-and-forget pattern in `pipeline.ts:256-269` for memory persistence. The `persistReviewObservations` call remains non-awaited with a `.catch()`.

**Alternatives considered**:
- Await the persist call — would block the pipeline response for a non-critical operation.
- Move persist entirely out of core (to each distribution mode) — would duplicate the persist-if-memory-enabled logic.

**Rationale**: The current pattern (`pipeline.ts:256-269`) deliberately does not await memory persistence to avoid blocking the review response. This is correct for the SaaS path (PostgreSQL is fast, but the client shouldn't wait). For SQLite, the fire-and-forget is slightly nuanced: `close()` must be called _after_ the persist completes to flush to disk. The CLI and Action callers handle this by awaiting the pipeline, then calling `storage.close()`. The non-awaited persist in the pipeline is fine because the pipeline's internal persist writes to the in-memory sql.js database (fast, synchronous-equivalent), and the actual disk flush happens in `close()` at the call site.

**Important**: The CLI and Action MUST ensure they call `memoryStorage.close()` _after_ awaiting `reviewPipeline()`. Since the persist is fire-and-forget inside the pipeline, we need a small change: the pipeline should track the persist promise and expose it, or the persist should be awaited. The simplest approach: **change the pipeline to `await` the persist call when `memoryStorage` is provided**. This is a minimal behavioral change — for PostgreSQL it adds negligible latency (the persist is fast), and for SQLite it ensures the in-memory DB is populated before `close()` exports it.

---

## Data Flow

### SaaS Mode (PostgreSQL — unchanged behavior)

```
Webhook/Inngest
      │
      ├─ createDatabaseFromEnv() → Drizzle DB instance
      ├─ new PostgresMemoryStorage(db)
      │
      ▼
  reviewPipeline({ memoryStorage: pgStorage, ... })
      │
      ├── Step 5: searchMemorySafe()
      │      └── pgStorage.searchObservations()
      │             └── ghagga-db.searchObservations(db, ...)
      │                    └── PostgreSQL tsvector query
      │
      ├── Step 6: Agent execution (memoryContext injected)
      │
      └── Step 8: persistReviewObservations(pgStorage, ...)
             ├── pgStorage.createSession() → ghagga-db.createMemorySession()
             ├── pgStorage.saveObservation() → ghagga-db.saveObservation()
             └── pgStorage.endSession()    → ghagga-db.endMemorySession()
```

### CLI Mode (SQLite)

```
ghagga review .
      │
      ├── Resolve project ID from `git remote get-url origin`
      │      → normalize to "owner/repo" (or "local/unknown")
      │
      ├── SqliteMemoryStorage.create("~/.config/ghagga/memory.db")
      │      ├── initSqlJs()              ← async WASM load
      │      ├── Read file if exists       ← fs.readFileSync
      │      ├── new Database(buffer)      ← sql.js in-memory DB
      │      └── Run schema DDL            ← CREATE TABLE IF NOT EXISTS + FTS5
      │
      ▼
  reviewPipeline({ memoryStorage: sqliteStorage, enableMemory: true, ... })
      │
      ├── Step 5: searchMemorySafe()
      │      └── sqliteStorage.searchObservations("owner/repo", query, {limit:3})
      │             └── SELECT ... FROM memory_observations_fts
      │                 WHERE memory_observations_fts MATCH ?
      │                 JOIN memory_observations ON rowid = id
      │                 WHERE project = ? ORDER BY bm25() LIMIT ?
      │
      ├── Step 6: Agent execution (memoryContext injected)
      │
      └── Step 8: persistReviewObservations(sqliteStorage, ...)
             ├── sqliteStorage.createSession()  ← INSERT INTO memory_sessions
             ├── sqliteStorage.saveObservation() ← dedup + INSERT/UPDATE
             └── sqliteStorage.endSession()      ← UPDATE memory_sessions
      │
      ▼
  sqliteStorage.close()
      ├── db.export()                 ← Uint8Array of full DB
      └── fs.writeFileSync(filePath)  ← Persist to ~/.config/ghagga/memory.db
```

### Action Mode (SQLite + @actions/cache)

```
GHAGGA Action starts
      │
      ├── Read input: enable-memory (default: true)
      │
      ├── [if enabled] cache.restoreCache(["/tmp/ghagga-memory.db"],
      │                    "ghagga-memory-owner/repo",
      │                    ["ghagga-memory-owner/repo"])
      │      └── Cache hit: file restored to /tmp/ghagga-memory.db
      │      └── Cache miss: no file, SqliteMemoryStorage creates fresh DB
      │
      ├── SqliteMemoryStorage.create("/tmp/ghagga-memory.db")
      │
      ▼
  reviewPipeline({ memoryStorage: sqliteStorage, enableMemory: true, ... })
      │
      ├── Step 5: search ← FTS5 query against cached observations
      ├── Step 6: agent  ← memoryContext injected
      └── Step 8: persist ← new observations saved to in-memory DB
      │
      ▼
  sqliteStorage.close()
      └── Writes DB to /tmp/ghagga-memory.db
      │
      ▼
  cache.saveCache(["/tmp/ghagga-memory.db"], "ghagga-memory-owner/repo")
      └── Uploaded for next run (7-day TTL on inactivity)
```

---

## File Changes

| File                                       | Action | Description                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`               | Modify | Add `MemoryStorage` interface, `MemoryObservationRow` interface. Replace `db?: unknown` with `memoryStorage?: MemoryStorage` on `ReviewInput`.                                                                                                                                                                               |
| `packages/core/src/memory/sqlite.ts`       | Create | `SqliteMemoryStorage` class: async factory, schema init, FTS5 setup, content-hash dedup, topicKey upsert, BM25 search, file persistence, `close()`.                                                                                                                                                                          |
| `packages/core/src/memory/search.ts`       | Modify | Remove `import { searchObservations } from 'ghagga-db'`. Change `db: unknown` param to `storage: MemoryStorage`. Call `storage.searchObservations()`.                                                                                                                                                                        |
| `packages/core/src/memory/persist.ts`      | Modify | Remove `import { saveObservation, createMemorySession, endMemorySession } from 'ghagga-db'`. Change `db: unknown` to `storage: MemoryStorage`. Call `storage.createSession()`, `storage.saveObservation()`, `storage.endSession()`.                                                                                          |
| `packages/core/src/pipeline.ts`            | Modify | Replace `input.db` with `input.memoryStorage` in `searchMemorySafe` (line 369), persist step (line 256), and null guards. Await the persist call to ensure in-memory DB is populated before `close()`.                                                                                                                       |
| `packages/core/package.json`               | Modify | Remove `"ghagga-db": "workspace:^"` from dependencies. Add `"sql.js": "^1.11.0"`.                                                                                                                                                                                                                                            |
| `packages/core/src/memory/search.test.ts`  | Modify | Replace `vi.mock('ghagga-db', ...)` with a mock `MemoryStorage` object. Update all test expectations from `mockSearchObservations(db, ...)` to `storage.searchObservations(...)`.                                                                                                                                            |
| `packages/core/src/memory/persist.test.ts` | Modify | Replace `vi.mock('ghagga-db', ...)` with a mock `MemoryStorage` object. Update test expectations to use interface method calls.                                                                                                                                                                                              |
| `packages/core/src/memory/sqlite.test.ts`  | Create | Unit tests for `SqliteMemoryStorage`: schema init, CRUD, dedup, topicKey upsert, FTS5 search, BM25 ordering, session lifecycle, file persistence, close behavior. Uses real sql.js (in-memory, no file I/O).                                                                                                                 |
| `apps/server/src/memory/postgres.ts`       | Create | `PostgresMemoryStorage` class: wraps `ghagga-db.searchObservations`, `saveObservation`, `createMemorySession`, `endMemorySession`. Constructor takes Drizzle `Database`. Maps full Drizzle row to `MemoryObservationRow`.`close()` is a no-op.                                                                               |
| `apps/server/src/memory/postgres.test.ts`  | Create | Unit tests for `PostgresMemoryStorage`: delegation to ghagga-db functions, row mapping, close no-op.                                                                                                                                                                                                                         |
| `apps/server/src/inngest/review.ts`        | Modify | Replace `db` variable usage (line 241–276) with `new PostgresMemoryStorage(db)`. Pass `memoryStorage` instead of `db` to `reviewPipeline`.                                                                                                                                                                                   |
| `apps/cli/src/commands/review.ts`          | Modify | Import `SqliteMemoryStorage`. Add `memory: boolean` to `ReviewOptions` (default `true`). Create storage at `getConfigDir()/memory.db`. Derive project ID from `git remote get-url origin`. Set `enableMemory: true`, `memoryStorage: storage`. Call `storage.close()` after pipeline. Add `--no-memory` Commander.js option. |
| `apps/cli/src/lib/git.ts`                  | Create | Utility `resolveProjectId(repoPath): string` — runs `git remote get-url origin`, normalizes to `owner/repo`. Falls back to `"local/unknown"`.                                                                                                                                                                                |
| `apps/action/src/index.ts`                 | Modify | Import `SqliteMemoryStorage`, `@actions/cache`. Add `enable-memory` input parsing. Restore cache before pipeline, create storage, set `enableMemory: true`, `memoryStorage: storage`. After pipeline, call `storage.close()`, save cache.                                                                                    |
| `apps/action/action.yml`                   | Modify | Add `enable-memory` input (description, default: `'true'`).                                                                                                                                                                                                                                                                  |
| `action.yml` (root)                        | Modify | Add `enable-memory` input (mirrors `apps/action/action.yml`).                                                                                                                                                                                                                                                                |
| `apps/action/package.json`                 | Modify | Add `"sql.js": "^1.11.0"` to dependencies (already has `@actions/cache`).                                                                                                                                                                                                                                                    |

---

## Interfaces / Contracts

### MemoryStorage Interface (in `packages/core/src/types.ts`)

```typescript
/**
 * Abstract storage backend for the memory system.
 * Implemented by SqliteMemoryStorage (CLI/Action) and PostgresMemoryStorage (SaaS).
 */
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

  /** Release resources. SQLite: export to disk. PostgreSQL: no-op. */
  close(): Promise<void>;
}

/**
 * Subset of observation columns returned to consumers.
 * Both adapters map their full row type to this shape.
 */
export interface MemoryObservationRow {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
}
```

### Updated ReviewInput (in `packages/core/src/types.ts`)

```typescript
export interface ReviewInput {
  // ... existing fields unchanged ...

  /**
   * Memory storage backend for search and persist operations.
   * Undefined when memory is disabled or unavailable — pipeline degrades gracefully.
   */
  memoryStorage?: MemoryStorage;

  // Remove: db?: unknown;

  // ... rest unchanged ...
}
```

### SqliteMemoryStorage Class (in `packages/core/src/memory/sqlite.ts`)

```typescript
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryStorage, MemoryObservationRow } from '../types.js';

const SCHEMA_SQL = `
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

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts
    USING fts5(title, content, content='memory_observations', content_rowid='id');

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
`;

const DEDUP_WINDOW_MINUTES = 15;

/**
 * SQLite-backed memory storage using sql.js (pure WASM).
 *
 * Thread safety: This class is NOT thread-safe. It operates as an in-memory
 * database with manual file persistence via close(). Designed for single-process
 * environments (CLI, GitHub Action).
 */
export class SqliteMemoryStorage implements MemoryStorage {
  private constructor(
    private db: SqlJsDatabase,
    private filePath: string,
  ) {}

  /**
   * Async factory — handles WASM initialization and file loading.
   * If filePath exists, loads the existing DB. Otherwise, creates a fresh one.
   */
  static async create(filePath: string): Promise<SqliteMemoryStorage> {
    const SQL = await initSqlJs();

    let db: SqlJsDatabase;
    if (existsSync(filePath)) {
      const buffer = readFileSync(filePath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    db.run(SCHEMA_SQL);

    return new SqliteMemoryStorage(db, filePath);
  }

  async searchObservations(
    project: string,
    query: string,
    options: { limit?: number; type?: string } = {},
  ): Promise<MemoryObservationRow[]> {
    const { limit = 10, type } = options;

    // Convert space-separated keywords to FTS5 OR query
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' OR ');

    if (!ftsQuery) return [];

    let sql = `
      SELECT o.id, o.type, o.title, o.content, o.file_paths
      FROM memory_observations o
      JOIN memory_observations_fts fts ON fts.rowid = o.id
      WHERE fts MATCH ?
        AND o.project = ?
    `;
    const params: (string | number)[] = [ftsQuery, project];

    if (type) {
      sql += ' AND o.type = ?';
      params.push(type);
    }

    sql += ' ORDER BY bm25(memory_observations_fts) LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    const rows: MemoryObservationRow[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        id: row['id'] as number,
        type: row['type'] as string,
        title: row['title'] as string,
        content: row['content'] as string,
        filePaths: row['file_paths'] ? JSON.parse(row['file_paths'] as string) : null,
      });
    }
    stmt.free();

    return rows;
  }

  async saveObservation(data: {
    sessionId?: number;
    project: string;
    type: string;
    title: string;
    content: string;
    topicKey?: string;
    filePaths?: string[];
  }): Promise<MemoryObservationRow> {
    const contentHash = createHash('sha256')
      .update(`${data.type}:${data.title}:${data.content}`)
      .digest('hex');

    // Dedup: check for same content hash within 15-minute window
    const dedupRows = this.db.exec(
      `
      SELECT id, type, title, content, file_paths FROM memory_observations
      WHERE content_hash = ? AND project = ?
        AND created_at > datetime('now', '-${DEDUP_WINDOW_MINUTES} minutes')
      LIMIT 1
    `,
      [contentHash, data.project],
    );

    if (dedupRows.length > 0 && dedupRows[0]!.values.length > 0) {
      const row = dedupRows[0]!.values[0]!;
      return {
        id: row[0] as number,
        type: row[1] as string,
        title: row[2] as string,
        content: row[3] as string,
        filePaths: row[4] ? JSON.parse(row[4] as string) : null,
      };
    }

    // TopicKey upsert
    if (data.topicKey) {
      const existingByTopic = this.db.exec(
        `
        SELECT id FROM memory_observations
        WHERE topic_key = ? AND project = ?
        LIMIT 1
      `,
        [data.topicKey, data.project],
      );

      if (existingByTopic.length > 0 && existingByTopic[0]!.values.length > 0) {
        const existingId = existingByTopic[0]!.values[0]![0] as number;
        const filePathsJson = JSON.stringify(data.filePaths ?? []);

        const updated = this.db.exec(
          `
          UPDATE memory_observations
          SET content = ?, title = ?, content_hash = ?, file_paths = ?,
              revision_count = revision_count + 1,
              updated_at = datetime('now')
          WHERE id = ?
          RETURNING id, type, title, content, file_paths
        `,
          [data.content, data.title, contentHash, filePathsJson, existingId],
        );

        const row = updated[0]!.values[0]!;
        return {
          id: row[0] as number,
          type: row[1] as string,
          title: row[2] as string,
          content: row[3] as string,
          filePaths: row[4] ? JSON.parse(row[4] as string) : null,
        };
      }
    }

    // New observation
    const filePathsJson = JSON.stringify(data.filePaths ?? []);
    const inserted = this.db.exec(
      `
      INSERT INTO memory_observations
        (session_id, project, type, title, content, topic_key, file_paths, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, type, title, content, file_paths
    `,
      [
        data.sessionId ?? null,
        data.project,
        data.type,
        data.title,
        data.content,
        data.topicKey ?? null,
        filePathsJson,
        contentHash,
      ],
    );

    const row = inserted[0]!.values[0]!;
    return {
      id: row[0] as number,
      type: row[1] as string,
      title: row[2] as string,
      content: row[3] as string,
      filePaths: row[4] ? JSON.parse(row[4] as string) : null,
    };
  }

  async createSession(data: { project: string; prNumber?: number }): Promise<{ id: number }> {
    const result = this.db.exec(
      `
      INSERT INTO memory_sessions (project, pr_number)
      VALUES (?, ?)
      RETURNING id
    `,
      [data.project, data.prNumber ?? null],
    );

    return { id: result[0]!.values[0]![0] as number };
  }

  async endSession(sessionId: number, summary: string): Promise<void> {
    this.db.run(
      `
      UPDATE memory_sessions
      SET ended_at = datetime('now'), summary = ?
      WHERE id = ?
    `,
      [summary, sessionId],
    );
  }

  async close(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data = this.db.export();
    writeFileSync(this.filePath, Buffer.from(data));
    this.db.close();
  }
}
```

### PostgresMemoryStorage Class (in `apps/server/src/memory/postgres.ts`)

```typescript
import type { MemoryStorage, MemoryObservationRow } from 'ghagga-core';
import {
  searchObservations,
  saveObservation,
  createMemorySession,
  endMemorySession,
} from 'ghagga-db';
import type { Database } from 'ghagga-db';

/**
 * PostgreSQL-backed memory storage.
 * Thin adapter wrapping existing ghagga-db query functions.
 */
export class PostgresMemoryStorage implements MemoryStorage {
  constructor(private db: Database) {}

  async searchObservations(
    project: string,
    query: string,
    options?: { limit?: number; type?: string },
  ): Promise<MemoryObservationRow[]> {
    const rows = await searchObservations(this.db, project, query, options);
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      filePaths: row.filePaths ?? null,
    }));
  }

  async saveObservation(data: {
    sessionId?: number;
    project: string;
    type: string;
    title: string;
    content: string;
    topicKey?: string;
    filePaths?: string[];
  }): Promise<MemoryObservationRow> {
    const row = await saveObservation(this.db, data);
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      filePaths: row.filePaths ?? null,
    };
  }

  async createSession(data: { project: string; prNumber?: number }): Promise<{ id: number }> {
    const session = await createMemorySession(this.db, data);
    return { id: session.id };
  }

  async endSession(sessionId: number, summary: string): Promise<void> {
    await endMemorySession(this.db, sessionId, summary);
  }

  async close(): Promise<void> {
    // No-op — PostgreSQL connection lifecycle is managed externally
  }
}
```

### Git Remote Resolver (in `apps/cli/src/lib/git.ts`)

```typescript
import { execSync } from 'node:child_process';

/**
 * Resolve the project identifier from the git remote origin.
 * Normalizes various URL formats to "owner/repo".
 * Falls back to "local/unknown" if no remote is configured.
 */
export function resolveProjectId(repoPath: string): string {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();

    return normalizeRemoteUrl(remoteUrl);
  } catch {
    return 'local/unknown';
  }
}

/**
 * Normalize a git remote URL to "owner/repo" format.
 *
 * Handles:
 *   https://github.com/owner/repo.git  → owner/repo
 *   git@github.com:owner/repo.git      → owner/repo
 *   ssh://git@github.com/owner/repo    → owner/repo
 *   https://gitlab.com/owner/repo.git  → owner/repo
 */
export function normalizeRemoteUrl(url: string): string {
  let cleaned = url;

  // Strip .git suffix
  cleaned = cleaned.replace(/\.git$/, '');

  // SSH format: git@host:owner/repo
  const sshMatch = cleaned.match(/^[\w-]+@[\w.-]+:(.+)$/);
  if (sshMatch) return sshMatch[1]!;

  // HTTPS / SSH protocol: extract path after host
  try {
    const parsed = new URL(cleaned);
    // Remove leading slash
    return parsed.pathname.replace(/^\//, '');
  } catch {
    // Not a valid URL — return as-is or fallback
    return 'local/unknown';
  }
}
```

### Refactored search.ts Signature

```typescript
// Before:
export async function searchMemoryForContext(
  db: unknown,
  project: string,
  fileList: string[],
): Promise<string | null>;

// After:
import type { MemoryStorage } from '../types.js';

export async function searchMemoryForContext(
  storage: MemoryStorage,
  project: string,
  fileList: string[],
): Promise<string | null>;
```

### Refactored persist.ts Signature

```typescript
// Before:
export async function persistReviewObservations(
  db: unknown,
  project: string,
  prNumber: number,
  result: ReviewResult,
): Promise<void>;

// After:
import type { MemoryStorage } from '../types.js';

export async function persistReviewObservations(
  storage: MemoryStorage,
  project: string,
  prNumber: number,
  result: ReviewResult,
): Promise<void>;
```

### Refactored pipeline.ts Key Sections

```typescript
// searchMemorySafe — line ~365
async function searchMemorySafe(input: ReviewInput, fileList: string[]): Promise<string | null> {
  if (!input.settings.enableMemory || !input.memoryStorage || !input.context) {
    return null;
  }
  try {
    return await searchMemoryForContext(input.memoryStorage, input.context.repoFullName, fileList);
  } catch (error) {
    /* ... existing handling ... */
  }
}

// Step 8 persist — line ~255
if (input.settings.enableMemory && input.memoryStorage && input.context) {
  await persistReviewObservations(
    input.memoryStorage,
    input.context.repoFullName,
    input.context.prNumber,
    result,
  ).catch((error: unknown) => {
    console.warn(
      '[ghagga] Memory persist failed (non-fatal):',
      error instanceof Error ? error.message : String(error),
    );
  });
}
```

---

## Testing Strategy

| Layer           | What to Test                                                                                                                                                                                                                                                             | Approach                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**        | `SqliteMemoryStorage` — schema init, `saveObservation` (insert, dedup, topicKey upsert), `searchObservations` (FTS5 match, BM25 ordering, project scoping, type filter, limit), `createSession`/`endSession`, `close` (exports to buffer), file_paths JSON serialization | `packages/core/src/memory/sqlite.test.ts` — use real sql.js with in-memory DB (no file I/O). Fast, deterministic. Mock `fs` for close/create file operations. Target: >80% mutation score (Stryker).                                                                   |
| **Unit**        | `PostgresMemoryStorage` — delegation to ghagga-db functions, row mapping to `MemoryObservationRow`, `close()` is no-op                                                                                                                                                   | `apps/server/src/memory/postgres.test.ts` — mock all `ghagga-db` imports. Verify each method delegates correctly and maps the response shape.                                                                                                                          |
| **Unit**        | `search.ts` refactor — `storage.searchObservations()` called instead of direct import, null-guard on `!storage`, error handling                                                                                                                                          | Update `packages/core/src/memory/search.test.ts` — replace `vi.mock('ghagga-db')` with a mock `MemoryStorage` object passed as `storage` argument.                                                                                                                     |
| **Unit**        | `persist.ts` refactor — `storage.createSession()`, `storage.saveObservation()`, `storage.endSession()` called instead of direct imports                                                                                                                                  | Update `packages/core/src/memory/persist.test.ts` — replace `vi.mock('ghagga-db')` with a mock `MemoryStorage` object.                                                                                                                                                 |
| **Unit**        | `pipeline.ts` — `input.memoryStorage` used in `searchMemorySafe` and persist step; graceful degradation when `undefined`                                                                                                                                                 | Existing pipeline tests updated: replace `db: mockDb` with `memoryStorage: mockStorage`. Add explicit test for `memoryStorage: undefined` path.                                                                                                                        |
| **Unit**        | `resolveProjectId` / `normalizeRemoteUrl` — URL normalization for HTTPS, SSH, ssh://, missing remote fallback                                                                                                                                                            | `apps/cli/src/lib/git.test.ts` — unit tests with `vi.mock('node:child_process')`. Test all URL formats from spec S23.                                                                                                                                                  |
| **Integration** | CLI review with SQLite memory — end-to-end flow from creation through search and persist, file persistence between "runs"                                                                                                                                                | `apps/cli/src/commands/review.test.ts` — integration test that creates `SqliteMemoryStorage`, runs a mock pipeline, verifies observations persist, creates second storage instance from same file, verifies search returns previous observations. Uses temp directory. |
| **Integration** | Action cache lifecycle — cache restore → review → close → cache save                                                                                                                                                                                                     | `apps/action/src/index.test.ts` — mock `@actions/cache` and verify `restoreCache`/`saveCache` calls with correct key and paths. Verify `SqliteMemoryStorage.create` is called after restore.                                                                           |
| **Integration** | ncc bundle includes sql.js WASM                                                                                                                                                                                                                                          | CI step: `ncc build`, verify `dist/` contains the WASM asset. Run `node dist/index.js` with minimal inputs to verify WASM loads.                                                                                                                                       |
| **Mutation**    | SqliteMemoryStorage — all new code                                                                                                                                                                                                                                       | Stryker with `vitest-runner`. Target: >80% mutation score. Critical mutants: dedup window check, topicKey upsert logic, FTS5 query construction, RETURNING clause parsing.                                                                                             |

---

## Migration / Rollout

### No Data Migration Required

- **SaaS/PostgreSQL**: The `PostgresMemoryStorage` adapter wraps the same `ghagga-db` functions (`searchObservations`, `saveObservation`, `createMemorySession`, `endMemorySession`) with zero behavioral changes. The PostgreSQL schema, tsvector index, and triggers are untouched. SaaS users experience no difference.
- **CLI**: Memory is new for CLI users. `SqliteMemoryStorage.create()` creates a fresh database on first use. No existing data to migrate.
- **Action**: Memory is new for Action users. First run creates a fresh database; `@actions/cache` persists it for subsequent runs. No existing data to migrate.

### Rollout Sequence

1. **Merge to main** — all changes in a single feature branch.
2. **Server deploys automatically** (Render auto-deploy on push). The `PostgresMemoryStorage` wrapper activates immediately. No user-visible change.
3. **`ghagga-core` published to npm** — CLI users get memory on next `npm update`. First run creates `~/.config/ghagga/memory.db`.
4. **Action users get memory** on next workflow run after the release tag is updated. First run creates fresh DB + cache.

### Backward Compatibility

- `ReviewInput.db` field is removed. This is a **breaking change** for consumers of the `ghagga-core` npm package that pass `db`. Since `db` was typed `unknown` and only used by the internal SaaS server, no external consumers are affected. The SaaS server is updated in the same commit.
- The `enableMemory: false` setting continues to work exactly as before — both search and persist are skipped.
- CLI `--no-memory` flag provides explicit opt-out.
- Action `enable-memory: false` input provides explicit opt-out.

### WASM Bundling for Action

The sql.js WASM binary (~1MB) must be bundled with `@vercel/ncc`. Two approaches, tried in order:
1. **Default resolution**: `ncc` may inline the WASM as a base64 asset in the bundle. Test with `ncc build` and verify the WASM loads at runtime.
2. **Fallback — `locateFile`**: If ncc cannot inline WASM, configure sql.js's `locateFile` option to load from a known sibling path. Copy the WASM file to `dist/` as a post-build step:

   ```typescript
   const SQL = await initSqlJs({
     locateFile: (file: string) => path.join(__dirname, file),
   });
   ```

   And add to `apps/action/package.json`:

   ```json
   "build": "ncc build src/index.ts -o dist --source-map --license licenses.txt -t && cp node_modules/sql.js/dist/sql-wasm.wasm dist/"
   ```

---

## Open Questions

- [x] **FTS5 query syntax**: Should keywords be joined with `OR` (match any) or `AND` (match all)? → **Resolved**: Use `OR` — matches the PostgreSQL behavior where `'auth' & 'pool'` returns rows matching _any_ term (tsquery `&` means AND, but the search function wraps individual words). After reviewing `queries.ts:462`, PostgreSQL uses `&` (AND). However, for memory search where we want broad recall with few terms, `OR` provides better coverage. The BM25 ranking naturally boosts multi-keyword matches to the top. Decision: **use `OR` for recall, rely on BM25 ranking**.

- [ ] **ncc + sql.js WASM**: Needs empirical validation during implementation. The `locateFile` fallback path is designed and ready if direct bundling fails. This should be tested in the first task.

- [ ] **Pipeline persist await**: The current fire-and-forget pattern (line 256–269) needs to change to `await` for SQLite correctness. Verify this doesn't add noticeable latency to the SaaS path. PostgreSQL persist is typically <50ms — acceptable to await.
