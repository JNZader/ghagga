# Design: Memory Management — CLI Commands for Inspecting, Searching, and Pruning Memory

## Technical Approach

This change extends the GHAGGA memory system with inspection and management capabilities. The implementation adds five new methods to the `MemoryStorage` interface (R1), two new types (R2), an FTS5 delete trigger (R3), and a `ghagga memory` CLI command group with six subcommands (R6–R12).

The approach is layered:
1. **Core layer** (`packages/core`): Extend the interface and types, implement SQL methods in `SqliteMemoryStorage`, add the missing FTS5 delete trigger to `SCHEMA_SQL`, stub methods in `PostgresMemoryStorage`.
2. **CLI layer** (`apps/cli`): Register a `memory` command group with Commander.js, implement six subcommand handlers that open `SqliteMemoryStorage`, query/mutate, format output, and close.

All six commands follow a consistent lifecycle: check DB existence → open storage → execute → close (in `finally`) → print output. No new npm dependencies are needed — everything uses Node.js built-ins and existing packages.

This maps directly to the proposal's approach sections 1–6 and satisfies all requirements R1–R15 and cross-cutting concerns CC1–CC5 in the spec.

---

## Architecture Decisions

### AD1: Command File Structure — Subdirectory with Barrel

**Choice**: Create a `apps/cli/src/commands/memory/` directory with one file per subcommand (`list.ts`, `search.ts`, `show.ts`, `delete.ts`, `stats.ts`, `clear.ts`), a shared `utils.ts`, and an `index.ts` barrel that exports the Commander.js `memoryCommand` group.

**Alternatives considered**:
- Single `commands/memory.ts` file containing all six subcommands and helpers (~400–500 lines). This is what the proposal suggests, following the `review.ts` pattern.

**Rationale**: The proposal's single-file approach works for `review.ts` because it's one command with helpers. Six distinct subcommands in one file would exceed 500 lines and make code navigation difficult. Each subcommand has its own options, argument parsing, and output formatting — they're independent concerns. The subdirectory approach keeps files under 100 lines each while the `index.ts` barrel presents the same import surface to `apps/cli/src/index.ts`:

```typescript
// apps/cli/src/index.ts — identical import regardless of internal structure
import { memoryCommand } from './commands/memory/index.js';
program.addCommand(memoryCommand);
```

The existing CLI commands (`login.ts`, `logout.ts`, `status.ts`, `review.ts`) are all single files because they're single commands. A command _group_ with six subcommands is a different beast — the subdirectory pattern is the right escalation.

### AD2: Shared Utilities — `utils.ts` in the Memory Command Directory

**Choice**: Create `apps/cli/src/commands/memory/utils.ts` containing three shared helpers:
1. **`openMemoryOrExit(configDir: string): Promise<{ storage: SqliteMemoryStorage; dbPath: string }>`** — Checks `existsSync(dbPath)`, prints the "no database" message and exits with code 0 if missing, otherwise opens `SqliteMemoryStorage.create(dbPath)` and returns both the storage instance and the resolved path.

2. **`confirmOrExit(message: string, force: boolean): Promise<void>`** — Handles the confirmation flow: if `force` is true, returns immediately. If `!process.stdin.isTTY` and `!force`, prints non-TTY error and exits with code 1. Otherwise, prompts with `readline/promises` and exits with code 0 on cancel.

3. **`formatTable(headers: string[], rows: string[][], widths: number[]): string`** — Builds a plain-text table using `String.padEnd()` with a separator row. Returns the formatted string.

**Alternatives considered**:
- Inline helpers in each subcommand file — duplicates the DB-open and confirmation logic.
- Place in `apps/cli/src/lib/memory.ts` — breaks locality; these helpers are specific to the `memory` command group.

**Rationale**: The DB-open check (CC1, R13) and confirmation prompt (R14, CC2) are used by multiple subcommands. Extracting them to a sibling `utils.ts` keeps each command handler focused on its specific logic while ensuring consistent behavior. The table formatter is small (~20 lines) but used by both `list` and `stats`.

### AD3: MemoryStorage Interface Extension — Additive, Same File

**Choice**: Add five new methods to the existing `MemoryStorage` interface in `packages/core/src/types.ts`. Add two new types (`MemoryObservationDetail`, `MemoryStats`) in the same file, in the existing "Memory Types" section.

**Alternatives considered**:
- New file `packages/core/src/memory/types.ts` — splits related types across files.
- Optional methods (with `?` suffix) to avoid breaking the interface — adds null checks everywhere.

**Rationale**: Follows the existing pattern established by the `sqlite-memory` change (see archived design AD3). `types.ts` already contains all memory types (`MemoryObservation`, `MemoryObservationRow`, `MemoryStorage`). The interface has exactly two implementors in the monorepo (`SqliteMemoryStorage`, `PostgresMemoryStorage`), both updated in the same PR. Making methods required (not optional) ensures compile-time enforcement that both implementations are complete.

### AD4: FTS5 Delete Trigger — Appended to SCHEMA_SQL

**Choice**: Append the `obs_fts_delete` trigger to the existing `SCHEMA_SQL` constant in `packages/core/src/memory/sqlite.ts`, immediately after the existing `obs_fts_update` trigger:

```sql
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;
```

**Alternatives considered**:
- Separate migration system (numbered migration files) — massive over-engineering for a single trigger.
- Check-and-create at runtime via `SqliteMemoryStorage.create()` method — adds runtime complexity when the DDL approach is simpler.

**Rationale**: The existing schema uses `CREATE TRIGGER IF NOT EXISTS` for the insert and update triggers. The same pattern makes the delete trigger idempotent — safe for both new databases and existing ones. When `db.run(SCHEMA_SQL)` executes on an existing DB, the new trigger is created silently; the existing triggers are no-ops. No migration infrastructure needed. This satisfies R3 and scenarios S36–S38.

### AD5: ID Handling — Direct Integer, Display as Zero-Padded

**Choice**: Observation IDs are SQLite auto-increment integers. CLI commands accept the integer directly as an argument. IDs are _displayed_ as 8-character zero-padded strings (e.g., `42` → `00000042`) using `String(id).padStart(8, '0')`. The underlying `getObservation(id)` and `deleteObservation(id)` always use the raw integer.

**Alternatives considered**:
- UUID-based IDs — requires schema migration, breaks existing data.
- Accept both padded and unpadded forms — adds parsing complexity for zero benefit.

**Rationale**: SQLite integer primary keys are the existing schema. Changing to UUIDs would be a schema migration. The 8-character padded display (CC5) is purely cosmetic — it keeps table columns aligned. Users type the plain integer (`ghagga memory show 42`), which is parsed with `parseInt()` and validated with `isNaN()` (R9.1, S15, S24).

### AD6: Output Formatting — Plain Text with padEnd

**Choice**: All output uses plain text with `String.padEnd()` for column alignment. No ANSI colors, no box-drawing beyond simple horizontal rules (`────────`), no external formatting libraries.

**Alternatives considered**:
- `cli-table3` or `columnify` npm packages — add unnecessary dependencies.
- ANSI colors via `chalk` — explicitly excluded by CC3 and R15.

**Rationale**: The spec (CC3) mandates plain text only. The output should be parseable by `grep`/`awk`. A simple `formatTable` helper using `padEnd()` handles the `list` and `stats` commands. The `show` command uses key-value formatting with fixed-width labels. Date formatting uses `YYYY-MM-DD` for `list`/`stats` and full ISO for `show` — no external date library needed (string slicing from the SQLite `datetime()` output is sufficient).

### AD7: Confirmation Prompts — readline/promises with TTY Detection

**Choice**: Use `node:readline/promises` (`createInterface({ input: process.stdin, output: process.stdout })`) for interactive confirmation in `delete` and `clear`. Detect non-TTY via `!process.stdin.isTTY`.

```typescript
import { createInterface } from 'node:readline/promises';

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}
```

**Alternatives considered**:
- `inquirer` or `prompts` npm packages — add dependencies, violates R15.
- Reading raw stdin bytes — fragile, no readline buffering.
- Treat non-TTY as implicit `--force` — unsafe; scripts could accidentally delete data.

**Rationale**: `readline/promises` is built into Node.js since v17 (CLI requires Node.js >= 20). Only `y`/`Y` confirms; any other input cancels (R10.2, R12.2). Non-TTY without `--force` prints an error and exits 1 (CC2, S21, S33). This makes commands safely scriptable: `ghagga memory delete 42 --force` works in CI, while `echo "y" | ghagga memory delete 42` is explicitly rejected.

### AD8: DB File Size for Stats — fs.statSync

**Choice**: Use `fs.statSync(dbPath).size` to get the file size in bytes, then format as human-readable:
- `< 1024`: `"N bytes"`
- `< 1024*1024`: `"N.N KB"`
- Otherwise: `"N.N MB"`

**Alternatives considered**:
- Read `PRAGMA page_count * PRAGMA page_size` from SQLite — accurate for the logical size but requires the DB to be open, and doesn't account for WAL files.
- Skip file size entirely — users find it useful for monitoring memory growth.

**Rationale**: The spec (R11.1) requires file size from the filesystem. `fs.statSync` is the simplest and most accurate measure of disk usage. The human-readable formatting uses a simple conditional with `toFixed(1)` — no dependency needed.

---

## Data Flow

### Read Commands: list, search, show, stats

```
User
  │
  ▼
Commander.js (apps/cli/src/index.ts)
  │   program.addCommand(memoryCommand)
  ▼
memoryCommand (apps/cli/src/commands/memory/index.ts)
  │   .command('list') / .command('search') / .command('show') / .command('stats')
  ▼
Subcommand handler (e.g., list.ts)
  │
  ├── getConfigDir() → "~/.config/ghagga"
  ├── dbPath = join(configDir, 'memory.db')
  │
  ├── existsSync(dbPath)?
  │     NO  → print "No memory database found..." → exit(0)
  │     YES ↓
  │
  ├── storage = await SqliteMemoryStorage.create(dbPath)
  │
  ├── try {
  │     result = await storage.listObservations(...) / searchObservations(...) / ...
  │     formatAndPrint(result)
  │   } finally {
  │     await storage.close()
  │   }
  │
  └── exit(0)
```

### Write Commands: delete, clear

```
User
  │
  ▼
Commander.js → memoryCommand → Subcommand handler (delete.ts / clear.ts)
  │
  ├── existsSync(dbPath)?
  │     NO  → print "No memory database found..." → exit(0)
  │     YES ↓
  │
  ├── storage = await SqliteMemoryStorage.create(dbPath)
  │
  ├── try {
  │     │
  │     ├── [delete] Parse ID → getObservation(id)
  │     │     NOT FOUND → print error → exit(1)
  │     │
  │     ├── [clear] Count observations to delete
  │     │     ZERO → print "No observations to clear." → exit(0)
  │     │
  │     ├── !force && !process.stdin.isTTY?
  │     │     YES → print "Error: Use --force..." → exit(1)
  │     │
  │     ├── !force?
  │     │     YES → confirm("Are you sure? (y/N) ")
  │     │            NOT confirmed → print "Cancelled." → exit(0)
  │     │
  │     ├── [delete] await storage.deleteObservation(id)
  │     │     └── SQL: DELETE FROM memory_observations WHERE id = ?
  │     │     └── Trigger: obs_fts_delete fires → cleans FTS5 index
  │     │
  │     ├── [clear] await storage.clearObservations({ project })
  │     │     └── SQL: DELETE FROM memory_observations [WHERE project = ?]
  │     │     └── Trigger: obs_fts_delete fires per row → cleans FTS5 index
  │     │
  │     └── print success message
  │   } finally {
  │     await storage.close()   ← Persists in-memory DB to disk
  │   }
  │
  └── exit(0)
```

### Search Command — Repo Resolution

```
User runs: ghagga memory search "auth"
  │
  ├── --repo flag provided?
  │     YES → project = opts.repo
  │     NO  ↓
  │
  ├── resolveProjectId(process.cwd())
  │     └── git remote get-url origin → normalize to "owner/repo"
  │     └── fallback: "local/unknown"
  │
  ├── project resolved
  │
  └── storage.searchObservations(project, query, { limit })
        └── Uses existing FTS5/BM25 search (no new SQL needed)
```

---

## TypeScript Interfaces

### New Types in `packages/core/src/types.ts`

```typescript
// ─── Memory Management Types ────────────────────────────────────

/**
 * Full observation row with all database columns.
 * Used by management commands (list, show, stats).
 * Extends MemoryObservationRow with metadata fields.
 */
export interface MemoryObservationDetail {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
  project: string;
  topicKey: string | null;
  revisionCount: number;
  createdAt: string; // ISO 8601 from SQLite datetime()
  updatedAt: string; // ISO 8601 from SQLite datetime()
}

/**
 * Aggregate statistics about the memory store.
 * Used by the `ghagga memory stats` command.
 */
export interface MemoryStats {
  totalObservations: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  oldestObservation: string | null; // ISO 8601, null if empty
  newestObservation: string | null; // ISO 8601, null if empty
}

/**
 * Options for listing observations with filtering and pagination.
 */
export interface ListObservationsOptions {
  project?: string;
  type?: string;
  limit?: number;
  offset?: number;
}
```

### Extended MemoryStorage Interface

```typescript
export interface MemoryStorage {
  // ── Existing methods (unchanged) ──────────────────────────────

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

  // ── New methods (this change) ─────────────────────────────────

  /** List observations with optional filtering and pagination. */
  listObservations(options?: ListObservationsOptions): Promise<MemoryObservationDetail[]>;

  /** Get a single observation by ID. Returns null if not found. */
  getObservation(id: number): Promise<MemoryObservationDetail | null>;

  /** Delete a single observation by ID. Returns true if deleted, false if not found. */
  deleteObservation(id: number): Promise<boolean>;

  /** Get aggregate statistics about the memory store. */
  getStats(): Promise<MemoryStats>;

  /** Delete all observations, optionally scoped to a project. Returns count of deleted rows. */
  clearObservations(options?: { project?: string }): Promise<number>;
}
```

---

## SQL Queries

### FTS5 Delete Trigger (appended to SCHEMA_SQL)

```sql
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;
```

### listObservations

Dynamic query built with optional WHERE clauses:

```sql
SELECT id, type, title, content, file_paths, project, topic_key,
       revision_count, created_at, updated_at
FROM memory_observations
WHERE 1=1
  AND project = ?     -- only when options.project is provided
  AND type = ?        -- only when options.type is provided
ORDER BY created_at DESC
LIMIT ? OFFSET ?
```

Implementation pattern (using `prepare`/`bind`/`step` like existing `searchObservations`):

```typescript
async listObservations(options: ListObservationsOptions = {}): Promise<MemoryObservationDetail[]> {
  const { project, type, limit = 20, offset = 0 } = options;

  let sql = `
    SELECT id, type, title, content, file_paths, project, topic_key,
           revision_count, created_at, updated_at
    FROM memory_observations
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = this.db.prepare(sql);
  stmt.bind(params);

  const rows: MemoryObservationDetail[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push(this.mapToDetail(row));
  }
  stmt.free();
  return rows;
}
```

### getObservation

```sql
SELECT id, type, title, content, file_paths, project, topic_key,
       revision_count, created_at, updated_at
FROM memory_observations
WHERE id = ?
```

Implementation:

```typescript
async getObservation(id: number): Promise<MemoryObservationDetail | null> {
  const stmt = this.db.prepare(`
    SELECT id, type, title, content, file_paths, project, topic_key,
           revision_count, created_at, updated_at
    FROM memory_observations
    WHERE id = ?
  `);
  stmt.bind([id]);

  if (!stmt.step()) {
    stmt.free();
    return null;
  }

  const row = stmt.getAsObject();
  stmt.free();
  return this.mapToDetail(row);
}
```

### deleteObservation

```sql
DELETE FROM memory_observations WHERE id = ?
```

The `obs_fts_delete` trigger fires automatically. Check affected rows via `this.db.getRowsModified()`:

```typescript
async deleteObservation(id: number): Promise<boolean> {
  this.db.run('DELETE FROM memory_observations WHERE id = ?', [id]);
  return this.db.getRowsModified() > 0;
}
```

### getStats

Three queries, each using `exec()` (returns column arrays, not row iterators):

```sql
-- Query 1: Totals and date range
SELECT COUNT(*) AS total,
       MIN(created_at) AS oldest,
       MAX(created_at) AS newest
FROM memory_observations;

-- Query 2: Count by type
SELECT type, COUNT(*) AS count
FROM memory_observations
GROUP BY type
ORDER BY count DESC;

-- Query 3: Count by project
SELECT project, COUNT(*) AS count
FROM memory_observations
GROUP BY project
ORDER BY count DESC;
```

Implementation:

```typescript
async getStats(): Promise<MemoryStats> {
  // Query 1: totals
  const totals = this.db.exec(
    'SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memory_observations',
  );
  const totalRow = totals[0]?.values[0];
  const totalObservations = (totalRow?.[0] as number) ?? 0;
  const oldestObservation = (totalRow?.[1] as string) ?? null;
  const newestObservation = (totalRow?.[2] as string) ?? null;

  // Query 2: by type
  const byTypeResult = this.db.exec(
    'SELECT type, COUNT(*) AS count FROM memory_observations GROUP BY type ORDER BY count DESC',
  );
  const byType: Record<string, number> = {};
  if (byTypeResult.length > 0) {
    for (const row of byTypeResult[0]!.values) {
      byType[row[0] as string] = row[1] as number;
    }
  }

  // Query 3: by project
  const byProjectResult = this.db.exec(
    'SELECT project, COUNT(*) AS count FROM memory_observations GROUP BY project ORDER BY count DESC',
  );
  const byProject: Record<string, number> = {};
  if (byProjectResult.length > 0) {
    for (const row of byProjectResult[0]!.values) {
      byProject[row[0] as string] = row[1] as number;
    }
  }

  return { totalObservations, byType, byProject, oldestObservation, newestObservation };
}
```

### clearObservations

```sql
-- Scoped:
DELETE FROM memory_observations WHERE project = ?

-- Unscoped:
DELETE FROM memory_observations
```

The `obs_fts_delete` trigger fires once per deleted row. Returns count via `this.db.getRowsModified()`:

```typescript
async clearObservations(options: { project?: string } = {}): Promise<number> {
  if (options.project) {
    this.db.run('DELETE FROM memory_observations WHERE project = ?', [options.project]);
  } else {
    this.db.run('DELETE FROM memory_observations');
  }
  return this.db.getRowsModified();
}
```

### Shared Row Mapper

To avoid duplicating the column-to-type mapping, add a private helper:

```typescript
private mapToDetail(row: Record<string, unknown>): MemoryObservationDetail {
  return {
    id: row['id'] as number,
    type: row['type'] as string,
    title: row['title'] as string,
    content: row['content'] as string,
    filePaths: row['file_paths'] ? JSON.parse(row['file_paths'] as string) : null,
    project: row['project'] as string,
    topicKey: (row['topic_key'] as string) ?? null,
    revisionCount: row['revision_count'] as number,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
```

---

## File Changes

| File                                          | Action | Description                                                                                                                                                                                                            |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`                  | Modify | Add `MemoryObservationDetail`, `MemoryStats`, `ListObservationsOptions` interfaces. Add 5 new methods to `MemoryStorage` interface.                                                                                    |
| `packages/core/src/index.ts`                  | Modify | Export `MemoryObservationDetail`, `MemoryStats`, `ListObservationsOptions` types.                                                                                                                                      |
| `packages/core/src/memory/sqlite.ts`          | Modify | Append `obs_fts_delete` trigger to `SCHEMA_SQL`. Import new types. Add `mapToDetail()` private method. Implement `listObservations()`, `getObservation()`, `deleteObservation()`, `getStats()`, `clearObservations()`. |
| `packages/core/src/memory/sqlite.test.ts`     | Modify | Add test cases for all 5 new methods: list with filters, get by id, get not found, delete + FTS5 cleanup, stats aggregation, stats empty, clear all, clear by project.                                                 |
| `apps/server/src/memory/postgres.ts`          | Modify | Import new types. Add 5 stub methods, each throwing `Error('Not implemented — use Dashboard for memory management')`.                                                                                                  |
| `apps/cli/src/index.ts`                       | Modify | Import `memoryCommand` from `'./commands/memory/index.js'`. Add `program.addCommand(memoryCommand)` after existing command registrations.                                                                              |
| `apps/cli/src/commands/memory/index.ts`       | Create | Barrel file: creates `new Command('memory')` with `.description('Inspect, search, and manage review memory')`, registers 6 subcommands, exports `memoryCommand`.                                                       |
| `apps/cli/src/commands/memory/utils.ts`       | Create | Shared helpers: `openMemoryOrExit()`, `confirmOrExit()`, `formatTable()`, `formatSize()`, `formatId()`, `truncate()`.                                                                                                  |
| `apps/cli/src/commands/memory/list.ts`        | Create | `ghagga memory list` subcommand: `--repo`, `--type`, `--limit` options, tabular output, empty-results handling.                                                                                                        |
| `apps/cli/src/commands/memory/search.ts`      | Create | `ghagga memory search <query>` subcommand: `--repo` (inferred from git if omitted), `--limit`, numbered results with snippets.                                                                                         |
| `apps/cli/src/commands/memory/show.ts`        | Create | `ghagga memory show <id>` subcommand: full key-value display, ID validation, not-found error.                                                                                                                          |
| `apps/cli/src/commands/memory/delete.ts`      | Create | `ghagga memory delete <id>` subcommand: `--force`, confirmation flow, TTY detection, FTS5 cleanup via trigger.                                                                                                         |
| `apps/cli/src/commands/memory/stats.ts`       | Create | `ghagga memory stats` subcommand: aggregates, file size, date range formatting.                                                                                                                                        |
| `apps/cli/src/commands/memory/clear.ts`       | Create | `ghagga memory clear` subcommand: `--repo`, `--force`, confirmation with count, bulk delete.                                                                                                                           |
| `apps/cli/src/commands/memory/utils.test.ts`  | Create | Unit tests for shared helpers: `formatTable()`, `formatSize()`, `formatId()`, `truncate()`, `confirmOrExit()` (mocked readline).                                                                                       |
| `apps/cli/src/commands/memory/list.test.ts`   | Create | Unit tests for `list` handler: happy path, filters, empty results, no DB file.                                                                                                                                         |
| `apps/cli/src/commands/memory/search.test.ts` | Create | Unit tests for `search` handler: happy path, repo inference, empty results, no DB file.                                                                                                                                |
| `apps/cli/src/commands/memory/show.test.ts`   | Create | Unit tests for `show` handler: happy path, not found, invalid ID, no DB file.                                                                                                                                          |
| `apps/cli/src/commands/memory/delete.test.ts` | Create | Unit tests for `delete` handler: happy path, cancel, force, not found, non-TTY, invalid ID, no DB file.                                                                                                                |
| `apps/cli/src/commands/memory/stats.test.ts`  | Create | Unit tests for `stats` handler: happy path, empty DB, no DB file.                                                                                                                                                      |
| `apps/cli/src/commands/memory/clear.test.ts`  | Create | Unit tests for `clear` handler: happy path, scoped, cancel, force, no observations, non-TTY, no DB file.                                                                                                               |

**Totals**: 8 files modified, 14 files created, 0 files deleted.

---

## Interfaces / Contracts

### Command Handler Pattern

Each subcommand file exports a function that takes the Commander.js `Command` instance and attaches the subcommand. This keeps the barrel clean:

```typescript
// apps/cli/src/commands/memory/list.ts
import { Command } from 'commander';

export function registerListCommand(parent: Command): void {
  parent
    .command('list')
    .description('List observations with optional filtering')
    .option('--repo <owner/repo>', 'Filter by repository')
    .option('--type <type>', 'Filter by observation type')
    .option('--limit <n>', 'Maximum rows to display', '20')
    .action(async (opts) => {
      await handleList(opts);
    });
}

async function handleList(opts: { repo?: string; type?: string; limit: string }): Promise<void> {
  // ... implementation
}
```

```typescript
// apps/cli/src/commands/memory/index.ts
import { Command } from 'commander';
import { registerListCommand } from './list.js';
import { registerSearchCommand } from './search.js';
import { registerShowCommand } from './show.js';
import { registerDeleteCommand } from './delete.js';
import { registerStatsCommand } from './stats.js';
import { registerClearCommand } from './clear.js';

export const memoryCommand = new Command('memory').description(
  'Inspect, search, and manage review memory',
);

registerListCommand(memoryCommand);
registerSearchCommand(memoryCommand);
registerShowCommand(memoryCommand);
registerDeleteCommand(memoryCommand);
registerStatsCommand(memoryCommand);
registerClearCommand(memoryCommand);
```

### openMemoryOrExit Contract

```typescript
// apps/cli/src/commands/memory/utils.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteMemoryStorage } from 'ghagga-core';
import { getConfigDir } from '../../lib/config.js';

const NO_DB_MESSAGE = 'No memory database found. Run "ghagga review" first to build memory.';

/**
 * Resolve the DB path, check existence, and open storage.
 * Prints a message and exits 0 if the DB file doesn't exist.
 * Returns the storage instance and resolved dbPath.
 */
export async function openMemoryOrExit(): Promise<{
  storage: SqliteMemoryStorage;
  dbPath: string;
}> {
  const configDir = getConfigDir();
  const dbPath = join(configDir, 'memory.db');

  if (!existsSync(dbPath)) {
    console.log(NO_DB_MESSAGE);
    process.exit(0);
  }

  const storage = await SqliteMemoryStorage.create(dbPath);
  return { storage, dbPath };
}
```

### confirmOrExit Contract

```typescript
import { createInterface } from 'node:readline/promises';

/**
 * Handle confirmation flow for destructive operations.
 *
 * - force=true: returns immediately (no prompt)
 * - Non-TTY without force: prints error, exits 1
 * - TTY without force: prompts, exits 0 on cancel
 */
export async function confirmOrExit(message: string, force: boolean): Promise<void> {
  if (force) return;

  if (!process.stdin.isTTY) {
    console.error('Error: Use --force for non-interactive deletion.');
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}
```

### Formatting Helpers

```typescript
/**
 * Format observation ID as 8-char zero-padded string.
 * ID 42 → "00000042"
 */
export function formatId(id: number): string {
  return String(id).padStart(8, '0');
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a plain-text table with headers, separator, and padded columns.
 */
export function formatTable(headers: string[], rows: string[][], widths: number[]): string {
  const lines: string[] = [];

  // Header row
  lines.push(headers.map((h, i) => h.padEnd(widths[i]!)).join('  '));

  // Separator row
  lines.push(widths.map((w) => '─'.repeat(w)).join('  '));

  // Data rows
  for (const row of rows) {
    lines.push(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  }

  return lines.join('\n');
}
```

---

## Testing Strategy

| Layer                            | What to Test                                                                                                                                                                                                                                                                                                                                                                                | Approach                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit — SqliteMemoryStorage**   | `listObservations`: no filters, project filter, type filter, combined filters, limit/offset, empty results, newest-first ordering. `getObservation`: found, not found. `deleteObservation`: found + deleted + FTS5 cleaned, not found returns false. `getStats`: populated DB, empty DB, null dates. `clearObservations`: all observations, scoped by project, returns count, FTS5 cleaned. | Extend existing `packages/core/src/memory/sqlite.test.ts`. Use real sql.js with temp directory (same pattern as existing tests). Add FTS5 verification: after delete, `searchObservations` must NOT return the deleted row. |
| **Unit — PostgresMemoryStorage** | All 5 new methods throw `Error('Not implemented — use Dashboard for memory management')`. Existing methods remain unchanged.                                                                                                                                                                                                                                                                | Add tests to `apps/server/src/memory/postgres.test.ts` (or create if not exists). Mock `ghagga-db` imports. Call each new method and `expect(...).rejects.toThrow('Not implemented')`.                                      |
| **Unit — CLI utils**             | `formatTable`: header/separator/data alignment. `formatSize`: bytes, KB, MB thresholds. `formatId`: padding for various ID lengths. `truncate`: short string unchanged, long string truncated with `...`.                                                                                                                                                                                   | New `apps/cli/src/commands/memory/utils.test.ts`. Pure functions, no mocking needed.                                                                                                                                        |
| **Unit — CLI list**              | Happy path (table output), `--repo` filter, `--type` filter, `--limit`, empty results ("No observations found."), no DB file (prints message, exits 0).                                                                                                                                                                                                                                     | New `apps/cli/src/commands/memory/list.test.ts`. Mock `SqliteMemoryStorage.create` and `existsSync`. Spy on `console.log` and `process.exit`. Verify output format and exit codes.                                          |
| **Unit — CLI search**            | Happy path (numbered results), `--repo` explicit, `--repo` inferred from git, `--limit`, empty results, no DB file.                                                                                                                                                                                                                                                                         | New `apps/cli/src/commands/memory/search.test.ts`. Mock `SqliteMemoryStorage.create`, `existsSync`, and `resolveProjectId`.                                                                                                 |
| **Unit — CLI show**              | Happy path (all fields displayed), not found (exit 1), invalid ID format (exit 1), no DB file (exit 0).                                                                                                                                                                                                                                                                                     | New `apps/cli/src/commands/memory/show.test.ts`. Mock storage, verify output contains all expected fields.                                                                                                                  |
| **Unit — CLI delete**            | Happy path with confirmation, cancel, `--force`, not found (exit 1), non-TTY without force (exit 1), non-TTY with force, invalid ID, no DB file.                                                                                                                                                                                                                                            | New `apps/cli/src/commands/memory/delete.test.ts`. Mock storage, `readline/promises`, and `process.stdin.isTTY`.                                                                                                            |
| **Unit — CLI stats**             | Happy path (full stats output), empty DB ("(none)" sections), no DB file.                                                                                                                                                                                                                                                                                                                   | New `apps/cli/src/commands/memory/stats.test.ts`. Mock storage and `fs.statSync`.                                                                                                                                           |
| **Unit — CLI clear**             | Happy path all, scoped `--repo`, cancel, `--force`, no observations (exit 0, no prompt), non-TTY without force (exit 1), non-TTY with force, no DB file.                                                                                                                                                                                                                                    | New `apps/cli/src/commands/memory/clear.test.ts`. Mock storage and confirmation.                                                                                                                                            |

### Test Patterns

CLI command tests follow the existing pattern from `review.test.ts`:

```typescript
// Mock ghagga-core to prevent WASM loading
vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      listObservations: vi.fn(),
      getObservation: vi.fn(),
      deleteObservation: vi.fn(),
      getStats: vi.fn(),
      clearObservations: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));
```

SqliteMemoryStorage tests follow the existing pattern from `sqlite.test.ts`:

```typescript
// Real sql.js with temp directory — no mocking
let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghagga-sqlite-test-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
```

### FTS5 Delete Verification Pattern

The critical test for FTS5 cleanup after `deleteObservation` and `clearObservations`:

```typescript
it('deleteObservation cleans up FTS5 index so search no longer finds it', async () => {
  const storage = await SqliteMemoryStorage.create(dbPath);

  // Insert an observation
  const obs = await storage.saveObservation(
    makeObservationData({ title: 'Unique FTS test', content: 'Searchable content here.' }),
  );

  // Verify search finds it
  const before = await storage.searchObservations('owner/repo', 'Searchable');
  expect(before).toHaveLength(1);

  // Delete it
  const deleted = await storage.deleteObservation(obs.id);
  expect(deleted).toBe(true);

  // Verify search no longer finds it
  const after = await storage.searchObservations('owner/repo', 'Searchable');
  expect(after).toHaveLength(0);

  await storage.close();
});
```

---

## Migration / Rollout

### No Data Migration Required

- **Schema change** (FTS5 delete trigger): `CREATE TRIGGER IF NOT EXISTS` is idempotent. Existing databases gain the trigger on next `SqliteMemoryStorage.create()` call. No manual migration step.
- **Interface change**: Additive — existing methods are unchanged. The two additional implementors (`SqliteMemoryStorage`, `PostgresMemoryStorage`) are updated in the same PR.
- **CLI command**: New command group — no impact on existing `review`, `login`, `logout`, `status` commands.

### Rollout Sequence

1. **Merge to main** — all changes in a single feature branch.
2. **`ghagga-core` published to npm** — includes new interface methods, types, and SQLite implementation. Existing consumers are unaffected (new methods are additive to the interface, and external consumers don't implement `MemoryStorage`).
3. **CLI users get `ghagga memory`** on next `npm update ghagga`. Commands are immediately available; if they've already run `ghagga review`, their `memory.db` file is ready.
4. **SaaS server** — `PostgresMemoryStorage` stubs compile but are never called from server routes (no API endpoints for memory management yet).

### Backward Compatibility

- Existing `MemoryStorage` consumers (the review pipeline) are unaffected — they call `searchObservations`, `saveObservation`, `createSession`, `endSession`, and `close`, all of which are unchanged.
- The `ghagga-core` npm package's public API gains new type exports (`MemoryObservationDetail`, `MemoryStats`, `ListObservationsOptions`) — additive, non-breaking.
- Existing databases work unchanged. The FTS5 delete trigger is silently added on next open.

---

## Open Questions

None — all technical decisions are resolved and align with the approved proposal and spec.
