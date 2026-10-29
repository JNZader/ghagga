# Proposal: Memory Management — CLI Commands for Inspecting, Searching, and Pruning Memory

## Intent

The `sqlite-memory` change gave GHAGGA's CLI and GitHub Action the ability to build persistent review memory — observations about patterns, bugs, and learnings accumulate across reviews and make future reviews progressively smarter. But currently the memory is a black box: users cannot see what's stored, search for specific observations, delete stale or incorrect entries, or even know how large their memory has grown.

The only way to "manage" memory today is to delete `~/.config/ghagga/memory.db` manually — losing everything. There's no way to inspect a single observation, prune one repo's data without affecting others, or get basic statistics.

This change adds a `ghagga memory` command group with six subcommands (`list`, `search`, `show`, `delete`, `stats`, `clear`) that give users full visibility and control over their local memory database. These are CLI-only commands — Dashboard UI and API endpoints for memory management are planned as separate future work.

## Scope

### In Scope

- **`ghagga memory list`** — List observations with optional filtering by repository (`--repo`) and observation type (`--type`). Paginates with `--limit` (default 20). Outputs a formatted table with id, type, title (truncated), repo, and date.
- **`ghagga memory search <query>`** — Full-text search across observations using the existing FTS5/BM25 infrastructure in `SqliteMemoryStorage.searchObservations()`. Supports `--repo` scoping and `--limit` (default 10). Outputs ranked results with relevance-highlighted snippets.
- **`ghagga memory show <id>`** — Display the full details of a single observation: id, type, title, content, filePaths, project, created_at, updated_at, revision_count, topic_key.
- **`ghagga memory delete <id>`** — Delete a single observation by id. Requires interactive confirmation (`Are you sure?`) unless `--force` is passed. Also removes the corresponding FTS5 index entry.
- **`ghagga memory stats`** — Display memory statistics: total observations, breakdown by type, breakdown by repo, DB file size on disk, oldest and newest observation dates.
- **`ghagga memory clear`** — Delete ALL observations. Requires interactive confirmation unless `--force` is passed. Supports `--repo <owner/repo>` to scope deletion to a single repository's observations.
- **New `MemoryStorage` interface methods** — Add `listObservations`, `getObservation`, `deleteObservation`, `getStats`, `clearObservations` to the `MemoryStorage` interface in `packages/core/src/types.ts`.
- **`SqliteMemoryStorage` implementation** — Implement all new methods with proper FTS5 trigger handling (delete must clean up the FTS index) and `close()` persistence.
- **`PostgresMemoryStorage` stub** — Add the new methods to `PostgresMemoryStorage` in `apps/server/src/memory/postgres.ts`, throwing `Error('Not implemented — use Dashboard API')` for now. These will be implemented when the Dashboard memory management UI is built.
- **New types** — `MemoryObservationDetail` (full row with all columns), `MemoryStats` (aggregate statistics).
- **Unit tests** for all new `SqliteMemoryStorage` methods and all CLI command handlers.
- **Graceful error handling** — all commands handle: no memory DB file exists, empty results, invalid observation IDs, corrupted DB.

### Out of Scope

- **Dashboard UI / API endpoints** for memory management — future `memory-management-dashboard` change.
- **GitHub Action memory management** — Actions run headless; memory management doesn't make sense in CI. Users manage Action memory via CLI if they mount the same DB, or via cache key invalidation.
- **Memory export/import** (JSON, CSV) — useful but separate feature.
- **TUI / interactive mode** (arrows, scrolling, selection) — separate `memory-tui` change. This change outputs plain text/tables only.
- **Memory compaction / auto-pruning** (e.g., delete observations older than N days) — separate change.
- **Cross-project search** (FTS5 search across all repos without `--repo`) — the `search` subcommand requires `--repo` because the existing `searchObservations` method is scoped by project. Cross-project search is a separate enhancement. Note: `list` and `stats` already show all repos by default.
- **Modifying observations** (edit content, change type) — observations are AI-generated; manual editing is not a planned workflow.

## Approach

### 1. Extend the `MemoryStorage` Interface

Add five new methods to the existing interface in `packages/core/src/types.ts`:

```typescript
export interface MemoryStorage {
  // ... existing methods (searchObservations, saveObservation, createSession, endSession, close) ...

  /** List observations with optional filtering. */
  listObservations(options?: {
    project?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<MemoryObservationDetail[]>;

  /** Get a single observation by ID with all fields. */
  getObservation(id: number): Promise<MemoryObservationDetail | null>;

  /** Delete a single observation by ID. Returns true if found and deleted. */
  deleteObservation(id: number): Promise<boolean>;

  /** Get aggregate statistics about the memory store. */
  getStats(): Promise<MemoryStats>;

  /** Delete all observations, optionally scoped to a project. */
  clearObservations(options?: { project?: string }): Promise<number>;
}
```

New types:

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
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface MemoryStats {
  totalObservations: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  oldestObservation: string | null; // ISO 8601
  newestObservation: string | null; // ISO 8601
}
```

### 2. Implement in `SqliteMemoryStorage`

All new methods use straightforward SQL against the existing `memory_observations` table:
- **`listObservations`**: `SELECT * FROM memory_observations WHERE ... ORDER BY created_at DESC LIMIT ? OFFSET ?`
- **`getObservation`**: `SELECT * FROM memory_observations WHERE id = ?`
- **`deleteObservation`**: Delete from `memory_observations` (the existing FTS5 triggers don't handle DELETE — a new `obs_fts_delete` trigger must be added to the schema). Returns `true` if a row was deleted, `false` if the ID didn't exist.
- **`getStats`**: Three aggregation queries — `COUNT(*)`, `COUNT(*) GROUP BY type`, `COUNT(*) GROUP BY project`, plus `MIN/MAX(created_at)`.
- **`clearObservations`**: `DELETE FROM memory_observations WHERE project = ?` (or all rows if no project specified). Returns the count of deleted rows.

**FTS5 Delete Trigger** — The current schema has `obs_fts_insert` and `obs_fts_update` triggers but NO `obs_fts_delete` trigger. Deleting from `memory_observations` without cleaning up `memory_observations_fts` would leave orphan FTS entries and corrupt search results. A new trigger is needed:

```sql
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;
```

This trigger must be added to the `SCHEMA_SQL` constant in `sqlite.ts`. Since `CREATE TRIGGER IF NOT EXISTS` is used, existing databases will pick it up on next open — no migration needed.

### 3. Stub in `PostgresMemoryStorage`

Add all five methods throwing `Error('Not implemented — use Dashboard for memory management')`. This keeps the interface satisfied without requiring Drizzle query work in this change. When the Dashboard memory management change is built, these will be implemented with proper SQL.

### 4. CLI Command Group: `ghagga memory`

Register a `memory` command group in `apps/cli/src/index.ts` using Commander.js's `.command()` + `.addCommand()` pattern:

```typescript
import { memoryCommand } from './commands/memory.js';
program.addCommand(memoryCommand);
```

The `memoryCommand` is a `new Command('memory')` with six subcommands. Each subcommand:
1. Opens `SqliteMemoryStorage` at `~/.config/ghagga/memory.db` (via `getConfigDir()`)
2. Executes the query
3. Calls `storage.close()` to persist any changes
4. Formats and prints output
5. Handles the "no DB file" case by checking `existsSync()` before opening and printing: `No memory database found. Run "ghagga review" first to build memory.`

**Command file structure**: A single `apps/cli/src/commands/memory.ts` file containing the command group and all six subcommand handlers. This follows the pattern of `review.ts` being a single file for the review command with its helpers.

### 5. Output Formatting

All output is plain text — no colors or fancy formatting beyond simple alignment:
- **`list`**: Tabular output using fixed-width columns (id, type, title, repo, date). No external table library — `String.padEnd()` is sufficient for 5 columns.
- **`search`**: Numbered results with title, type, repo, and a content snippet (first 120 chars).
- **`show`**: Key-value pairs, one per line, with content shown in full.
- **`stats`**: Section-based output (totals, by type, by repo, file info).
- **`delete`/`clear`**: Confirmation prompt via `readline` (Node.js built-in), then success/failure message.

No external dependencies needed — `readline/promises` (Node.js built-in since v17) handles confirmation prompts. The CLI already requires Node.js >= 20.

### 6. Read-Only vs. Read-Write Open Mode

For `list`, `search`, `show`, and `stats`, the storage is opened but never modified. However, `SqliteMemoryStorage.close()` always writes the DB back to disk (even if unchanged). This is wasteful but harmless — sql.js exports the full DB on `close()`. A future optimization could add a `readOnly` flag to skip the write, but it's not needed for correctness.

For `delete` and `clear`, `close()` MUST be called to persist the deletion to disk, since sql.js operates on an in-memory copy.

## Affected Areas

| Area                                      | Impact   | Description                                                                                                                                                                         |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`              | Modified | Add `listObservations`, `getObservation`, `deleteObservation`, `getStats`, `clearObservations` to `MemoryStorage` interface. Add `MemoryObservationDetail` and `MemoryStats` types. |
| `packages/core/src/memory/sqlite.ts`      | Modified | Implement 5 new methods. Add `obs_fts_delete` trigger to `SCHEMA_SQL`.                                                                                                              |
| `packages/core/src/memory/sqlite.test.ts` | Modified | Add tests for all new methods: list with filters, get by id, get nonexistent, delete + FTS cleanup, stats aggregation, clear all, clear by project.                                 |
| `apps/server/src/memory/postgres.ts`      | Modified | Add 5 stub methods throwing "not implemented".                                                                                                                                      |
| `apps/cli/src/index.ts`                   | Modified | Import and register `memoryCommand` group.                                                                                                                                          |
| `apps/cli/src/commands/memory.ts`         | New      | Commander.js command group with 6 subcommands (list, search, show, delete, stats, clear). ~300-400 lines.                                                                           |
| `apps/cli/src/commands/memory.test.ts`    | New      | Unit tests for all subcommand handlers. Mock `SqliteMemoryStorage`. Test output formatting, error cases, confirmation prompts.                                                      |

## Risks

| Risk                                                                                           | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FTS5 index corruption if `obs_fts_delete` trigger is missing on existing DBs                   | Medium     | High   | `CREATE TRIGGER IF NOT EXISTS` is idempotent — the trigger is added on next `SqliteMemoryStorage.create()` call (which runs `SCHEMA_SQL`). Existing DBs get the trigger automatically. No migration needed. Test explicitly with a DB created without the trigger, then opened with the new code. |
| Adding methods to `MemoryStorage` interface is a breaking change for any external implementors | Very Low   | Low    | `MemoryStorage` is an internal interface — the only two implementors are `SqliteMemoryStorage` and `PostgresMemoryStorage`, both in this monorepo. The `ghagga-core` npm package exports the interface, but it's documented as internal and no external implementations are known.                |
| `readline/promises` confirmation prompt hangs in non-interactive environments (piped stdin)    | Low        | Medium | Detect non-TTY (`process.stdin.isTTY === false`) and either skip confirmation (treat as `--force`) or error with "use --force in non-interactive mode". This also makes the commands scriptable.                                                                                                  |
| `SqliteMemoryStorage.close()` writes unchanged DB to disk on read-only commands                | Low        | Low    | Correct but wasteful (~1-5ms for small DBs). Acceptable for CLI latency. Can be optimized later with a dirty flag if profiling shows it matters.                                                                                                                                                  |
| `DELETE FROM memory_observations` without `VACUUM` leaves DB file size unchanged               | Low        | Low    | SQLite reuses freed pages for future inserts. The file doesn't shrink but doesn't grow either. A `VACUUM` after `clear` could reclaim space, but adds complexity. Document as known behavior; add `VACUUM` as a future optimization if users report large files.                                  |
| Commander.js subcommand group may conflict with `--help` or other global options               | Very Low   | Low    | Commander.js handles nested subcommands well (tested in many CLIs). The `memory` command group inherits standard `--help` and `--version` from the parent.                                                                                                                                        |

## Rollback Plan

1. **Interface changes are additive**: The 5 new methods on `MemoryStorage` don't affect existing methods. Reverting removes the new methods — existing `searchObservations`, `saveObservation`, etc. are untouched.
2. **Schema change is backward-compatible**: The `obs_fts_delete` trigger is additive. Removing it doesn't break existing functionality — it only affects the new delete/clear commands. Existing databases without the trigger continue working for search/save.
3. **CLI command group is independent**: Removing the `memory` command from `index.ts` and deleting `commands/memory.ts` has zero impact on `review`, `login`, `logout`, and `status`.
4. **PostgresMemoryStorage stubs**: Removing the stub methods and reverting the interface is a clean revert with no side effects on the SaaS server.
5. **git revert scope**: All changes are in one feature branch. A single `git revert` of the merge commit restores full previous behavior.

## Dependencies

- **No new npm dependencies** — all functionality uses Node.js built-ins (`readline/promises`, `fs`, `path`) and the existing `sql.js` (already in `packages/core`), `commander` (already in `apps/cli`).
- **Existing `SqliteMemoryStorage`** in `packages/core/src/memory/sqlite.ts` — extended with new methods.
- **Existing `MemoryStorage` interface** in `packages/core/src/types.ts` — extended with new methods and types.
- **Existing CLI infrastructure** (`commander`, `getConfigDir()`, `resolveProjectId()`) — reused as-is.

## Distribution Mode Impact

| Mode              | Impact                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI**           | Primary target — all 6 commands are CLI features                                                                                                  |
| **SaaS**          | Minimal — PostgresMemoryStorage gets stub methods. No user-visible change.                                                                        |
| **GitHub Action** | No impact — Actions don't expose CLI commands. Memory management for Action-cached DBs is done by the user locally or via cache key invalidation. |

## Success Criteria

- [ ] `ghagga memory list` displays observations in a formatted table, respects `--repo`, `--type`, and `--limit` filters
- [ ] `ghagga memory search <query>` returns FTS5-ranked results with content snippets, respects `--repo` and `--limit`
- [ ] `ghagga memory show <id>` displays all fields of an observation, returns clear error for nonexistent ID
- [ ] `ghagga memory delete <id>` prompts for confirmation, deletes the observation AND its FTS5 index entry, respects `--force`
- [ ] `ghagga memory stats` shows total count, breakdown by type and repo, DB file size, date range
- [ ] `ghagga memory clear` prompts for confirmation, deletes all observations (or scoped by `--repo`), respects `--force`
- [ ] All commands print a helpful message when no `memory.db` file exists yet
- [ ] All commands handle empty results gracefully (e.g., "No observations found.")
- [ ] `MemoryStorage` interface has 5 new methods (`listObservations`, `getObservation`, `deleteObservation`, `getStats`, `clearObservations`)
- [ ] `SqliteMemoryStorage` implements all 5 new methods with tests (including FTS5 cleanup on delete)
- [ ] `obs_fts_delete` trigger added to schema, works on both new and existing databases
- [ ] `PostgresMemoryStorage` compiles with stub implementations (throws "not implemented")
- [ ] No new npm dependencies added
- [ ] Non-interactive mode (piped stdin) works with `--force` flag
- [ ] CLI help text (`ghagga memory --help`, `ghagga memory list --help`, etc.) is clear and complete
- [ ] Unit tests for all 6 CLI command handlers and all 5 new `SqliteMemoryStorage` methods
