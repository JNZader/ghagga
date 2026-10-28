# Spec: Memory Management — CLI Commands for Inspecting, Searching, and Pruning Memory

> **Domain**: Memory  
> **Change**: `memory-management`  
> **Type**: DELTA (extends existing memory-storage domain)  
> **Status**: Draft  
> **Depends on**: `sqlite-memory` (main spec: `openspec/specs/memory-storage/spec.md`)  

## Overview

This specification defines a `ghagga memory` CLI command group with six subcommands (`list`, `search`, `show`, `delete`, `stats`, `clear`) that give users full visibility and control over their local SQLite memory database. It also extends the `MemoryStorage` interface with five new methods, adds a missing FTS5 delete trigger to the SQLite schema, and stubs the new methods in `PostgresMemoryStorage`.

All commands are CLI-only, output plain text tables (no TUI, no colors), and handle edge cases gracefully: no database file, empty results, invalid IDs, and non-interactive (piped) environments.

---

## Requirements

### R1: MemoryStorage Interface Extension

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

### R2: New Types

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
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface MemoryStats {
  totalObservations: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  oldestObservation: string | null; // ISO 8601, null if no observations
  newestObservation: string | null; // ISO 8601, null if no observations
}
```

`MemoryObservationDetail` extends the existing `MemoryObservationRow` with all database columns needed for the `show` command. `MemoryStats` carries aggregate data for the `stats` command.

**Rationale**: The existing `MemoryObservationRow` is a projection of 5 columns used by the review pipeline. Management commands need the full row (project, topicKey, revisionCount, timestamps) and aggregate statistics.

### R3: FTS5 Delete Trigger

The `SCHEMA_SQL` constant in `packages/core/src/memory/sqlite.ts` MUST include an `obs_fts_delete` trigger:

```sql
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;
```

This trigger MUST be appended to the existing `SCHEMA_SQL` alongside the existing `obs_fts_insert` and `obs_fts_update` triggers.

Because `SCHEMA_SQL` runs via `db.run(SCHEMA_SQL)` on every `SqliteMemoryStorage.create()` call, and the trigger uses `CREATE TRIGGER IF NOT EXISTS`, existing databases MUST automatically gain the trigger the next time they are opened. No separate migration is needed.

**Rationale**: The current schema has insert and update triggers but no delete trigger. Deleting from `memory_observations` without cleaning up `memory_observations_fts` leaves orphan FTS entries that corrupt search results. Every delete operation (single or bulk) relies on this trigger for FTS consistency.

### R4: SqliteMemoryStorage — New Method Implementations

`SqliteMemoryStorage` in `packages/core/src/memory/sqlite.ts` MUST implement all five new methods:

#### R4.1: listObservations

```sql
SELECT id, type, title, content, file_paths, project, topic_key,
       revision_count, created_at, updated_at
FROM memory_observations
WHERE (project = ? OR ? IS NULL)
  AND (type = ? OR ? IS NULL)
ORDER BY created_at DESC
LIMIT ? OFFSET ?
```

- Default `limit`: 20, default `offset`: 0.
- When `options.project` is provided, filter by `project = ?`. When omitted, return all projects.
- When `options.type` is provided, filter by `type = ?`. When omitted, return all types.
- Results MUST be ordered newest first (`created_at DESC`).
- The `file_paths` column MUST be deserialized from JSON string to `string[] | null`.
- MUST return `MemoryObservationDetail[]`.

#### R4.2: getObservation

```sql
SELECT id, type, title, content, file_paths, project, topic_key,
       revision_count, created_at, updated_at
FROM memory_observations
WHERE id = ?
```

- Accepts the integer observation ID.
- MUST return `MemoryObservationDetail | null`. Returns `null` if no row matches.
- The `file_paths` column MUST be deserialized from JSON string.

#### R4.3: deleteObservation

```sql
DELETE FROM memory_observations WHERE id = ?
```

- The `obs_fts_delete` trigger (R3) MUST fire automatically to clean up the FTS index.
- MUST return `true` if a row was deleted (check `this.db.getRowsModified() > 0`), `false` if the ID was not found.
- After deletion, `close()` MUST be called by the consumer to persist the change to disk.

#### R4.4: getStats

Three queries:
1. `SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memory_observations`
2. `SELECT type, COUNT(*) AS count FROM memory_observations GROUP BY type`
3. `SELECT project, COUNT(*) AS count FROM memory_observations GROUP BY project ORDER BY count DESC`

- MUST return a `MemoryStats` object.
- If no observations exist, `totalObservations` MUST be 0, `byType` and `byProject` MUST be empty objects, `oldestObservation` and `newestObservation` MUST be `null`.

#### R4.5: clearObservations

```sql
-- Scoped:
DELETE FROM memory_observations WHERE project = ?
-- Unscoped:
DELETE FROM memory_observations
```

- When `options.project` is provided, delete only that project's observations.
- When `options.project` is omitted, delete ALL observations.
- The `obs_fts_delete` trigger (R3) MUST fire for each deleted row to clean up the FTS index.
- MUST return the count of deleted rows (via `this.db.getRowsModified()`).
- After clearing, `close()` MUST be called by the consumer to persist.

**Rationale**: These are straightforward SQL operations against the existing schema. The only schema change needed is the FTS5 delete trigger (R3).

### R5: PostgresMemoryStorage Stubs

All five new methods MUST be added to `PostgresMemoryStorage` in `apps/server/src/memory/postgres.ts`. Each MUST throw:

```typescript
throw new Error('Not implemented — use Dashboard for memory management');
```

**Rationale**: The SaaS server will expose memory management through the Dashboard UI (a separate future change). Stubbing now keeps the interface satisfied and the project compilable without premature Drizzle query work.

### R6: CLI Command Group — `ghagga memory`

A new `memory` command group MUST be registered in `apps/cli/src/index.ts`:

```typescript
import { memoryCommand } from './commands/memory.js';
program.addCommand(memoryCommand);
```

The command group MUST be implemented in a single file `apps/cli/src/commands/memory.ts` as a `new Command('memory')` with `.description('Inspect, search, and manage review memory')`.

The file MUST contain all six subcommand definitions and their handler functions.

**Rationale**: Follows the existing CLI pattern where each top-level command lives in `apps/cli/src/commands/`. A single file keeps the command group cohesive (similar to how `review.ts` contains the command plus all helpers).

### R7: `ghagga memory list`

#### R7.1: Options

| Option                | Type   | Defaults | Description                |
| --------------------- | ------ | -------- | -------------------------- |
| `--repo <owner/repo>` | string | (none)   | Filter by project field    |
| `--type <type>`       | string | (none)   | Filter by observation type |
| `--limit <n>`         | number | 20       | Maximum rows to display    |

#### R7.2: Output Format

A plain-text table with fixed-width columns using `String.padEnd()`:

```
ID        Type        Title                                     Repo              Date
────────  ──────────  ────────────────────────────────────────  ────────────────  ──────────
a1b2c3d4  pattern     OAuth token refresh patterns obser...     acme/widgets      2025-03-01
e5f6g7h8  bugfix      Pool connection leak in transaction...    acme/widgets      2025-02-28
```

- **ID**: First 8 characters of the integer ID, left-padded with zeros if needed (e.g., `00000042`).
- **Type**: Observation type, max 10 chars.
- **Title**: Truncated to 40 characters with `...` suffix if longer.
- **Repo**: The `project` field value.
- **Date**: `createdAt` formatted as `YYYY-MM-DD`.

#### R7.3: Empty Results

When no observations match the filters, output:

```
No observations found.
```

**Rationale**: A tabular overview is the most common way users will discover what's in their memory. The 20-row default and filter options keep output manageable.

### R8: `ghagga memory search <query>`

#### R8.1: Arguments and Options

- **Required argument**: `<query>` — the search terms (passed to `searchObservations`)
- `--repo <owner/repo>` — scope search to a specific project (REQUIRED, because `searchObservations` requires a `project` parameter)
- `--limit <n>` — maximum results (default 10)

If `--repo` is not provided, the command MUST resolve the project from the current git remote (using `resolveProjectId`). This allows running `ghagga memory search "auth"` inside a repo without specifying `--repo`.

#### R8.2: Output Format

Numbered results:

```
Found 3 results for "auth" in acme/widgets:

  1. [pattern] OAuth token refresh patterns
     a1b2c3d4 | OAuth token refresh must handle 401 responses by rotating the refre...

  2. [bugfix] Auth middleware bypass on OPTIONS
     e5f6g7h8 | CORS preflight requests were skipping the auth middleware because...

  3. [learning] JWT expiry edge case
     i9j0k1l2 | When the JWT expires exactly at the boundary of a request, the mi...
```

- Each result shows: type in brackets, title on the first line.
- Second line: ID (first 8 chars), pipe separator, content snippet (first 80 characters with `...` suffix if longer).

#### R8.3: Empty Results

```
No matching observations found.
```

**Rationale**: Reuses the existing `searchObservations` method with its FTS5/BM25 ranking. The output emphasizes title + snippet to help users quickly identify relevant observations.

### R9: `ghagga memory show <id>`

#### R9.1: Arguments

- **Required argument**: `<id>` — the observation ID. Accepts:
  - Full integer ID (e.g., `42`)
  - Prefix match: first 8+ characters of the zero-padded ID. The command MUST query `getObservation` with the parsed integer.

Since observation IDs are auto-increment integers, the CLI MUST parse the argument as an integer. If parsing fails (not a valid number), the command MUST print an error: `Invalid observation ID: "<input>". Expected a number.`

#### R9.2: Output Format

Key-value display, one field per line:

```
ID:             42
Type:           pattern
Title:          OAuth token refresh patterns
Project:        acme/widgets
Topic Key:      auth-token-refresh
Revision Count: 3
Created:        2025-03-01 14:22:05
Updated:        2025-03-04 09:15:32
File Paths:     src/auth.ts, lib/token.ts
Content:
  OAuth token refresh must handle 401 responses by rotating the refresh
  token. The current implementation retries once, but if the refresh token
  itself is expired, it should redirect to the login flow instead of
  throwing an unhandled error.
```

- **Content** MUST be displayed in full (no truncation), indented with 2 spaces per line.
- **File Paths** MUST be displayed as a comma-separated list, or `(none)` if null/empty.
- **Topic Key** displays `(none)` if null.

#### R9.3: Not Found

```
Observation not found: 42
```

**Rationale**: The detailed view complements `list` (which truncates) by showing the full content and all metadata fields.

### R10: `ghagga memory delete <id>`

#### R10.1: Arguments and Options

- **Required argument**: `<id>` — the observation ID (same parsing rules as R9.1)
- `--force` — skip the confirmation prompt

#### R10.2: Confirmation Flow

1. Fetch the observation via `getObservation(id)`.
2. If not found, print `Observation not found: <id>` and exit with code 1.
3. Display a summary: `Delete observation #<id>: [<type>] <title>?`
4. Prompt: `Are you sure? (y/N) `
5. Only `y` or `Y` confirms. Any other input (including empty) cancels.
6. On confirm: call `deleteObservation(id)`, then `storage.close()`, then print `Deleted observation #<id>.`
7. On cancel: print `Cancelled.`

#### R10.3: Non-TTY Behavior

If `process.stdin.isTTY` is falsy (piped input) and `--force` is not set:

```
Error: Use --force for non-interactive deletion.
```

Exit with code 1.

#### R10.4: Force Mode

When `--force` is set, skip the confirmation prompt entirely. Proceed directly to deletion.

**Rationale**: Destructive operations require confirmation to prevent accidents. Non-TTY detection ensures scripts and pipelines don't hang waiting for input that will never come.

### R11: `ghagga memory stats`

#### R11.1: Output Format

```
Memory Statistics
─────────────────

Total observations: 147

By type:
  pattern       68
  bugfix        42
  learning      21
  decision       9
  architecture   5
  config         2

By repository (top 10):
  acme/widgets      89
  acme/gadgets      45
  acme/platform     13

Database file: ~/.config/ghagga/memory.db (2.4 MB)
Oldest observation: 2025-01-15
Newest observation: 2025-03-06
```

- **By type**: All types present in the DB, sorted by count descending.
- **By repository**: Top 10 projects by observation count, sorted by count descending.
- **Database file**: The path and file size in human-readable form (bytes, KB, MB). The file size MUST be read from the filesystem via `fs.statSync()`.
- **Oldest/Newest**: Formatted as `YYYY-MM-DD`. Show `(none)` if no observations exist.

#### R11.2: No Database

If the memory database file does not exist:

```
No memory database found. Run "ghagga review" first to build memory.
```

**Rationale**: Stats give users a quick overview of memory growth and help decide whether pruning is needed.

### R12: `ghagga memory clear`

#### R12.1: Options

| Option                | Type    | Defaults | Description                        |
| --------------------- | ------- | -------- | ---------------------------------- |
| `--repo <owner/repo>` | string  | (none)   | Scope deletion to a single project |
| `--force`             | boolean | false    | Skip confirmation prompt           |

#### R12.2: Confirmation Flow

1. Count observations that will be deleted:
   - If `--repo` set: count where `project = ?`
   - If no `--repo`: count all observations
2. If count is 0, print `No observations to clear.` and exit.
3. Display prompt:
   - Scoped: `This will delete <N> observations for <repo>. Are you sure? (y/N) `
   - Unscoped: `This will delete ALL <N> observations. Are you sure? (y/N) `
4. Only `y`/`Y` confirms.
5. On confirm: call `clearObservations({ project })`, then `storage.close()`, then print `Deleted <N> observations.`
6. On cancel: print `Cancelled.`

#### R12.3: Non-TTY Behavior

Same as R10.3: if `process.stdin.isTTY` is falsy and `--force` is not set, print error and exit with code 1.

#### R12.4: Force Mode

Same as R10.4: skip confirmation, proceed directly.

**Rationale**: Bulk deletion is a destructive operation. Scoping by `--repo` allows cleaning one project without affecting others. The count in the prompt helps users understand the impact before confirming.

### R13: Database Lifecycle in Commands

Every command handler MUST follow this lifecycle:
1. **Check existence**: `existsSync(dbPath)`. If the file does not exist:
   - For read-only commands (`list`, `search`, `show`, `stats`): print `No memory database found. Run "ghagga review" first to build memory.` and exit with code 0.
   - For write commands (`delete`, `clear`): same message, exit with code 0.
2. **Open**: `const storage = await SqliteMemoryStorage.create(dbPath)`.
3. **Execute**: Run the query/operation.
4. **Close**: `await storage.close()` — MUST be called in a `finally` block to ensure persistence even on errors.

The database path MUST be `join(getConfigDir(), 'memory.db')`.

**Rationale**: Opening a non-existent DB creates a new empty file, which is misleading for read operations. Checking existence first provides a better user experience. The `finally` block ensures sql.js in-memory changes are always written to disk.

### R14: Confirmation Prompt Implementation

Confirmation prompts MUST use Node.js built-in `readline/promises`:

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

No external prompt library MUST be added.

**Rationale**: `readline/promises` is built into Node.js >= 17 (the CLI requires Node.js >= 20). Using built-ins avoids new dependencies.

### R15: No New Dependencies

This change MUST NOT add any new npm dependencies to `packages/core` or `apps/cli`. All functionality uses:
- `readline/promises` (Node.js built-in) for confirmation prompts
- `fs` (Node.js built-in) for file existence and size checks
- `commander` (already in `apps/cli`) for CLI command definitions
- `sql.js` / `fts5-sql-bundle` (already in `packages/core`) for SQLite operations

**Rationale**: The proposal explicitly states zero new dependencies. Everything needed is already available.

---

## Cross-Cutting Concerns

### CC1: Graceful Degradation — No Database File

All six commands MUST handle the case where `~/.config/ghagga/memory.db` does not exist. The behavior is:
- Check `existsSync(dbPath)` BEFORE attempting to open the storage.
- Print: `No memory database found. Run "ghagga review" first to build memory.`
- Exit with code 0 (not an error — the user simply hasn't reviewed yet).

This MUST NOT create an empty database file as a side effect.

**Rationale**: Opening `SqliteMemoryStorage.create()` on a non-existent path creates a fresh empty DB and writes it to disk on `close()`. This would leave a 0-observation DB file that clutters the config directory.

### CC2: Non-TTY Detection

Commands that require interactive confirmation (`delete`, `clear`) MUST detect non-TTY environments:
- Check: `process.stdin.isTTY === undefined` or `process.stdin.isTTY === false`
- When non-TTY and `--force` is NOT set: print `Error: Use --force for non-interactive deletion.` and exit with code 1.
- When non-TTY and `--force` IS set: proceed without confirmation.
- When TTY and `--force` IS set: proceed without confirmation.
- When TTY and `--force` NOT set: show confirmation prompt.

**Rationale**: Piped stdin (`echo "y" | ghagga memory delete 42`) is unreliable and confusing. Requiring `--force` for non-interactive use makes commands safely scriptable.

### CC3: Output Formatting — Plain Text Only

All command output MUST be plain text. Specifically:
- No ANSI color codes (no chalk, kleur, etc.)
- No TUI components (no ink, blessed, etc.)
- No box-drawing characters beyond simple horizontal rules (`────────`)
- Tables use space-padding via `String.padEnd()`, not any external table library
- Output is designed to be parseable by simple text processing tools (`grep`, `awk`)

**Rationale**: The proposal explicitly excludes TUI/interactive mode. Plain text is the most portable format for CLI tools and ensures output works in all terminals and piped scenarios.

### CC4: Error Exit Codes

| Scenario                            | Exit Code |
| ----------------------------------- | --------- |
| Success (data found and displayed)  | 0         |
| Success (no data / empty results)   | 0         |
| No database file exists             | 0         |
| Observation not found (show/delete) | 1         |
| Invalid input (bad ID format)       | 1         |
| Non-TTY without --force             | 1         |
| Database open/read error            | 1         |
| Cancelled by user                   | 0         |

**Rationale**: Standard Unix conventions — 0 for success or graceful conditions, 1 for errors. "No data" is not an error (the user asked a valid question, the answer is "nothing").

### CC5: ID Display Format

Throughout all commands, observation IDs are displayed as the first 8 characters of the zero-padded integer ID:
- ID `42` displays as `00000042`
- ID `1234567` displays as `01234567`
- ID `12345678` displays as `12345678`

This provides a consistent 8-character visual identifier while the actual storage and API use the full integer ID.

**Rationale**: 8 characters is enough to uniquely identify observations in any realistic database size while keeping table output compact.

---

## Scenarios

### S1: List — Happy Path, All Observations

```gherkin
Given a memory database exists with 25 observations across 2 projects
  And the user runs `ghagga memory list`
When the command executes
Then listObservations({ limit: 20, offset: 0 }) MUST be called
  And a table with 20 rows MUST be printed (respecting default limit)
  And rows MUST be ordered newest first (by created_at DESC)
  And each row MUST show: ID (8 chars), Type, Title (max 40 chars), Repo, Date
  And the header row MUST be displayed above the data rows
  And the exit code MUST be 0
```

### S2: List — Filtered by Repo

```gherkin
Given a memory database exists with observations for "acme/widgets" and "acme/gadgets"
  And the user runs `ghagga memory list --repo acme/widgets`
When the command executes
Then listObservations({ project: "acme/widgets", limit: 20, offset: 0 }) MUST be called
  And only observations where project = "acme/widgets" MUST appear in the output
  And no "acme/gadgets" observations MUST appear
```

### S3: List — Filtered by Type

```gherkin
Given a memory database exists with observations of types "pattern", "bugfix", "learning"
  And the user runs `ghagga memory list --type pattern`
When the command executes
Then listObservations({ type: "pattern", limit: 20, offset: 0 }) MUST be called
  And only observations where type = "pattern" MUST appear in the output
```

### S4: List — Custom Limit

```gherkin
Given a memory database exists with 50 observations
  And the user runs `ghagga memory list --limit 5`
When the command executes
Then listObservations({ limit: 5, offset: 0 }) MUST be called
  And exactly 5 rows MUST be printed
```

### S5: List — Combined Filters

```gherkin
Given a memory database exists with observations
  And the user runs `ghagga memory list --repo acme/widgets --type bugfix --limit 3`
When the command executes
Then listObservations({ project: "acme/widgets", type: "bugfix", limit: 3, offset: 0 }) MUST be called
  And only matching observations MUST appear
```

### S6: List — Empty Results

```gherkin
Given a memory database exists but contains no observations
  And the user runs `ghagga memory list`
When listObservations returns an empty array
Then the output MUST be "No observations found."
  And the exit code MUST be 0
```

### S7: List — No Database File

```gherkin
Given no memory database file exists at ~/.config/ghagga/memory.db
  And the user runs `ghagga memory list`
When the command checks existsSync(dbPath)
Then the check MUST return false
  And the output MUST be 'No memory database found. Run "ghagga review" first to build memory.'
  And SqliteMemoryStorage.create MUST NOT be called
  And no empty database file MUST be created
  And the exit code MUST be 0
```

### S8: Search — Happy Path

```gherkin
Given a memory database exists with observations for "acme/widgets" containing "auth" and "pool" terms
  And the user runs `ghagga memory search "auth" --repo acme/widgets`
When the command executes
Then searchObservations("acme/widgets", "auth", { limit: 10 }) MUST be called
  And results MUST be displayed as numbered entries
  And each entry MUST show: rank number, type in brackets, title, ID (8 chars), content snippet (80 chars)
  And results MUST be ranked by BM25 relevance
  And the exit code MUST be 0
```

### S9: Search — Repo Inferred from Git Remote

```gherkin
Given a memory database exists with observations
  And the user's current directory is a git repo with remote "https://github.com/acme/widgets.git"
  And the user runs `ghagga memory search "auth"` (no --repo flag)
When the command executes
Then resolveProjectId MUST be called to derive "acme/widgets"
  And searchObservations("acme/widgets", "auth", { limit: 10 }) MUST be called
```

### S10: Search — Custom Limit

```gherkin
Given a memory database exists with many observations
  And the user runs `ghagga memory search "patterns" --repo acme/widgets --limit 3`
When the command executes
Then searchObservations("acme/widgets", "patterns", { limit: 3 }) MUST be called
  And at most 3 results MUST be displayed
```

### S11: Search — No Results

```gherkin
Given a memory database exists with observations for "acme/widgets"
  And the user runs `ghagga memory search "xyznonexistent" --repo acme/widgets`
When searchObservations returns an empty array
Then the output MUST be "No matching observations found."
  And the exit code MUST be 0
```

### S12: Search — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory search "auth" --repo acme/widgets`
When the command checks existsSync(dbPath)
Then the output MUST be 'No memory database found. Run "ghagga review" first to build memory.'
  And the exit code MUST be 0
```

### S13: Show — Happy Path

```gherkin
Given a memory database exists with observation ID 42:
  | field          | value                                    |
  | id             | 42                                       |
  | type           | pattern                                  |
  | title          | OAuth token refresh patterns              |
  | content        | Full multi-line content...                |
  | filePaths      | ["src/auth.ts", "lib/token.ts"]           |
  | project        | acme/widgets                              |
  | topicKey       | auth-token-refresh                        |
  | revisionCount  | 3                                        |
  | createdAt      | 2025-03-01 14:22:05                      |
  | updatedAt      | 2025-03-04 09:15:32                      |
  And the user runs `ghagga memory show 42`
When the command executes
Then getObservation(42) MUST be called
  And ALL fields MUST be displayed in key-value format
  And the content MUST be displayed in full (no truncation)
  And filePaths MUST be shown as comma-separated list
  And the exit code MUST be 0
```

### S14: Show — Observation Not Found

```gherkin
Given a memory database exists but no observation has ID 999
  And the user runs `ghagga memory show 999`
When getObservation(999) returns null
Then the output MUST be "Observation not found: 999"
  And the exit code MUST be 1
```

### S15: Show — Invalid ID Format

```gherkin
Given the user runs `ghagga memory show abc`
When the command parses the argument
Then "abc" MUST fail to parse as a valid integer
  And the output MUST be 'Invalid observation ID: "abc". Expected a number.'
  And the exit code MUST be 1
```

### S16: Show — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory show 42`
When the command checks existsSync(dbPath)
Then the output MUST be 'No memory database found. Run "ghagga review" first to build memory.'
  And the exit code MUST be 0
```

### S17: Delete — Happy Path with Confirmation

```gherkin
Given a memory database exists with observation ID 42 of type "pattern" and title "OAuth token refresh"
  And the user's terminal is a TTY
  And the user runs `ghagga memory delete 42`
When the command executes
Then getObservation(42) MUST be called to fetch the summary
  And the output MUST show: 'Delete observation #42: [pattern] OAuth token refresh?'
  And the prompt MUST show: "Are you sure? (y/N) "
  And the user types "y" and presses Enter
Then deleteObservation(42) MUST be called
  And the delete MUST return true
  And storage.close() MUST be called
  And the output MUST show: "Deleted observation #42."
  And the exit code MUST be 0
```

### S18: Delete — User Cancels

```gherkin
Given observation ID 42 exists
  And the user's terminal is a TTY
  And the user runs `ghagga memory delete 42`
When the confirmation prompt appears and the user types "n" (or presses Enter)
Then deleteObservation MUST NOT be called
  And the output MUST show "Cancelled."
  And the exit code MUST be 0
```

### S19: Delete — Force Mode

```gherkin
Given observation ID 42 exists
  And the user runs `ghagga memory delete 42 --force`
When the command executes
Then no confirmation prompt MUST be shown
  And deleteObservation(42) MUST be called directly
  And storage.close() MUST be called
  And the output MUST show "Deleted observation #42."
```

### S20: Delete — Observation Not Found

```gherkin
Given no observation has ID 999
  And the user runs `ghagga memory delete 999`
When getObservation(999) returns null
Then no confirmation prompt MUST be shown
  And the output MUST be "Observation not found: 999"
  And the exit code MUST be 1
```

### S21: Delete — Non-TTY Without Force

```gherkin
Given observation ID 42 exists
  And process.stdin.isTTY is falsy (piped input)
  And the user runs `echo "y" | ghagga memory delete 42`
When the command checks for TTY
Then the output MUST be "Error: Use --force for non-interactive deletion."
  And deleteObservation MUST NOT be called
  And the exit code MUST be 1
```

### S22: Delete — Non-TTY With Force

```gherkin
Given observation ID 42 exists
  And process.stdin.isTTY is falsy (piped input)
  And the user runs `ghagga memory delete 42 --force`
When the command executes
Then no TTY check MUST block execution
  And deleteObservation(42) MUST be called directly
  And storage.close() MUST be called
  And the output MUST show "Deleted observation #42."
  And the exit code MUST be 0
```

### S23: Delete — FTS5 Cleanup

```gherkin
Given observation ID 42 exists and is indexed in memory_observations_fts
  And the obs_fts_delete trigger exists on memory_observations
  And the user runs `ghagga memory delete 42 --force`
When deleteObservation(42) executes DELETE FROM memory_observations WHERE id = 42
Then the obs_fts_delete trigger MUST fire
  And it MUST execute: INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content)
  And the FTS entry for observation 42 MUST be removed
  And subsequent searchObservations calls MUST NOT return observation 42
```

### S24: Delete — Invalid ID Format

```gherkin
Given the user runs `ghagga memory delete abc`
When the command parses the argument
Then the output MUST be 'Invalid observation ID: "abc". Expected a number.'
  And the exit code MUST be 1
```

### S25: Stats — Happy Path

```gherkin
Given a memory database exists at ~/.config/ghagga/memory.db (file size 2,457,600 bytes)
  And the database contains 147 observations:
    | type          | count |
    | pattern       | 68    |
    | bugfix        | 42    |
    | learning      | 21    |
    | decision      | 9     |
    | architecture  | 5     |
    | config        | 2     |
  And observations span projects: acme/widgets (89), acme/gadgets (45), acme/platform (13)
  And the oldest observation was created on 2025-01-15
  And the newest observation was created on 2025-03-06
  And the user runs `ghagga memory stats`
When the command executes
Then getStats() MUST be called
  And the output MUST show:
    - Total observations: 147
    - By type (all types, sorted by count desc)
    - By repository (top 10, sorted by count desc)
    - Database file path and size ("2.4 MB")
    - Oldest observation date
    - Newest observation date
  And the exit code MUST be 0
```

### S26: Stats — Empty Database

```gherkin
Given a memory database exists but contains no observations
  And the user runs `ghagga memory stats`
When getStats() returns { totalObservations: 0, byType: {}, byProject: {}, oldestObservation: null, newestObservation: null }
Then the output MUST show:
  - Total observations: 0
  - By type: (none)
  - By repository: (none)
  - Database file path and size
  - Oldest observation: (none)
  - Newest observation: (none)
  And the exit code MUST be 0
```

### S27: Stats — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory stats`
When the command checks existsSync(dbPath)
Then the output MUST be 'No memory database found. Run "ghagga review" first to build memory.'
  And the exit code MUST be 0
```

### S28: Clear — Happy Path, All Observations

```gherkin
Given a memory database exists with 147 observations
  And the user's terminal is a TTY
  And the user runs `ghagga memory clear`
When the command counts observations (147)
Then the prompt MUST show: "This will delete ALL 147 observations. Are you sure? (y/N) "
  And the user types "y"
Then clearObservations() MUST be called with no project filter
  And it MUST return 147 (rows deleted)
  And storage.close() MUST be called
  And the output MUST show: "Deleted 147 observations."
  And the exit code MUST be 0
```

### S29: Clear — Scoped to Repository

```gherkin
Given a memory database exists with 89 observations for "acme/widgets" and 58 for other projects
  And the user runs `ghagga memory clear --repo acme/widgets`
When the command counts observations for "acme/widgets" (89)
Then the prompt MUST show: "This will delete 89 observations for acme/widgets. Are you sure? (y/N) "
  And the user types "y"
Then clearObservations({ project: "acme/widgets" }) MUST be called
  And it MUST return 89
  And observations for other projects MUST NOT be deleted
  And storage.close() MUST be called
  And the output MUST show: "Deleted 89 observations."
```

### S30: Clear — User Cancels

```gherkin
Given a memory database exists with observations
  And the user's terminal is a TTY
  And the user runs `ghagga memory clear`
When the confirmation prompt appears and the user types "n"
Then clearObservations MUST NOT be called
  And the output MUST show "Cancelled."
  And the exit code MUST be 0
```

### S31: Clear — Force Mode

```gherkin
Given a memory database exists with 147 observations
  And the user runs `ghagga memory clear --force`
When the command executes
Then no confirmation prompt MUST be shown
  And clearObservations() MUST be called directly
  And storage.close() MUST be called
  And the output MUST show "Deleted 147 observations."
```

### S32: Clear — No Observations to Delete

```gherkin
Given a memory database exists but contains no observations
  And the user runs `ghagga memory clear`
When the command counts observations (0)
Then the output MUST be "No observations to clear."
  And no confirmation prompt MUST be shown
  And clearObservations MUST NOT be called
  And the exit code MUST be 0
```

### S33: Clear — Non-TTY Without Force

```gherkin
Given a memory database exists with observations
  And process.stdin.isTTY is falsy
  And the user runs `ghagga memory clear` (without --force)
When the command checks for TTY
Then the output MUST be "Error: Use --force for non-interactive deletion."
  And clearObservations MUST NOT be called
  And the exit code MUST be 1
```

### S34: Clear — Non-TTY With Force and Repo

```gherkin
Given a memory database exists with observations
  And process.stdin.isTTY is falsy
  And the user runs `ghagga memory clear --repo acme/widgets --force`
When the command executes
Then no TTY check MUST block execution
  And clearObservations({ project: "acme/widgets" }) MUST be called
  And storage.close() MUST be called
  And the exit code MUST be 0
```

### S35: Clear — FTS5 Cleanup on Bulk Delete

```gherkin
Given a memory database with 50 observations all indexed in memory_observations_fts
  And the user runs `ghagga memory clear --force`
When clearObservations() executes DELETE FROM memory_observations
Then the obs_fts_delete trigger MUST fire once per deleted row
  And memory_observations_fts MUST be empty after the operation
  And subsequent searchObservations calls MUST return empty results
```

### S36: FTS5 Delete Trigger — Auto-Migration of Existing Database

```gherkin
Given a memory database was created BEFORE this change (no obs_fts_delete trigger)
  And it contains observations indexed in memory_observations_fts
When SqliteMemoryStorage.create(dbPath) is called with the new code
Then db.run(SCHEMA_SQL) MUST execute
  And CREATE TRIGGER IF NOT EXISTS obs_fts_delete MUST succeed (trigger created)
  And the existing obs_fts_insert and obs_fts_update triggers MUST remain unchanged
  And subsequent deleteObservation calls MUST correctly clean up FTS entries
```

### S37: FTS5 Delete Trigger — Idempotent on New Database

```gherkin
Given SqliteMemoryStorage.create() is called on a non-existent path (new DB)
When SCHEMA_SQL runs
Then all three triggers (obs_fts_insert, obs_fts_update, obs_fts_delete) MUST be created
  And the FTS virtual table MUST be created
  And no errors MUST be thrown
```

### S38: FTS5 Delete Trigger — Idempotent on Re-Open

```gherkin
Given a memory database was created with the NEW code (obs_fts_delete exists)
When SqliteMemoryStorage.create(dbPath) is called again (re-open)
Then CREATE TRIGGER IF NOT EXISTS obs_fts_delete MUST be a no-op (already exists)
  And no errors MUST be thrown
  And the trigger MUST continue functioning correctly
```

### S39: PostgresMemoryStorage — listObservations Throws

```gherkin
Given a PostgresMemoryStorage instance
When listObservations() is called
Then it MUST throw Error('Not implemented — use Dashboard for memory management')
```

### S40: PostgresMemoryStorage — getObservation Throws

```gherkin
Given a PostgresMemoryStorage instance
When getObservation(42) is called
Then it MUST throw Error('Not implemented — use Dashboard for memory management')
```

### S41: PostgresMemoryStorage — deleteObservation Throws

```gherkin
Given a PostgresMemoryStorage instance
When deleteObservation(42) is called
Then it MUST throw Error('Not implemented — use Dashboard for memory management')
```

### S42: PostgresMemoryStorage — getStats Throws

```gherkin
Given a PostgresMemoryStorage instance
When getStats() is called
Then it MUST throw Error('Not implemented — use Dashboard for memory management')
```

### S43: PostgresMemoryStorage — clearObservations Throws

```gherkin
Given a PostgresMemoryStorage instance
When clearObservations() is called
Then it MUST throw Error('Not implemented — use Dashboard for memory management')
```

### S44: PostgresMemoryStorage — Existing Methods Unchanged

```gherkin
Given a PostgresMemoryStorage instance
When searchObservations, saveObservation, createSession, endSession, or close is called
Then each MUST continue to delegate to ghagga-db functions as before
  And behavior MUST be identical to the pre-change implementation
  And no regressions MUST be introduced
```

### S45: CLI Help Text

```gherkin
Given the user runs `ghagga memory --help`
Then the output MUST list all 6 subcommands with descriptions:
  - list     List observations with optional filtering
  - search   Search observations using full-text search
  - show     Show full details of an observation
  - delete   Delete a single observation
  - stats    Show memory statistics
  - clear    Delete observations (all or by repository)

Given the user runs `ghagga memory list --help`
Then all options MUST be documented: --repo, --type, --limit

Given the user runs `ghagga memory delete --help`
Then the required <id> argument and --force option MUST be documented
```

### S46: Command Registration in index.ts

```gherkin
Given the CLI entry point at apps/cli/src/index.ts
When the program is initialized
Then memoryCommand MUST be imported from './commands/memory.js'
  And program.addCommand(memoryCommand) MUST be called
  And `ghagga memory` MUST appear in `ghagga --help` output
  And existing commands (login, logout, status, review) MUST NOT be affected
```

### S47: Storage Close in Finally Block

```gherkin
Given a memory command opens SqliteMemoryStorage successfully
  And an unexpected error occurs during the query/operation
When the error propagates
Then storage.close() MUST still be called (via finally block)
  And the in-memory database changes MUST be persisted to disk
  And the error MUST be re-thrown or printed with a non-zero exit code
```

### S48: Delete — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory delete 42`
When the command checks existsSync(dbPath)
Then the output MUST be 'No memory database found. Run "ghagga review" first to build memory.'
  And the exit code MUST be 0
```

### S49: Clear — No Database File

```gherkin
Given no memory database file exists
  And the user runs `ghagga memory clear --force`
When the command checks existsSync(dbPath)
Then the output MUST be 'No memory database found. Run "ghagga review" first to build memory.'
  And the exit code MUST be 0
```

---

## Acceptance Criteria

1. **Interface**: `MemoryStorage` interface in `packages/core/src/types.ts` has 5 new methods: `listObservations`, `getObservation`, `deleteObservation`, `getStats`, `clearObservations`
2. **Types**: `MemoryObservationDetail` and `MemoryStats` types are exported from `packages/core/src/types.ts`
3. **FTS5 Trigger**: `obs_fts_delete` trigger is present in `SCHEMA_SQL` in `packages/core/src/memory/sqlite.ts`
4. **FTS5 Auto-Migration**: Existing databases gain the `obs_fts_delete` trigger on next open (via `CREATE TRIGGER IF NOT EXISTS`)
5. **SQLite Methods**: `SqliteMemoryStorage` implements all 5 new methods with correct SQL, JSON deserialization, and return types
6. **Postgres Stubs**: `PostgresMemoryStorage` has all 5 new methods throwing `'Not implemented — use Dashboard for memory management'`
7. **Postgres Existing**: All pre-existing `PostgresMemoryStorage` methods continue to work unchanged
8. **CLI Registration**: `ghagga memory` command group is registered in `apps/cli/src/index.ts` and appears in `ghagga --help`
9. **List Command**: `ghagga memory list` displays observations in a table, supports `--repo`, `--type`, `--limit`, shows "No observations found." on empty
10. **Search Command**: `ghagga memory search <query>` uses FTS5/BM25 via `searchObservations`, supports `--repo` (inferred from git if omitted), `--limit`, shows "No matching observations found." on empty
11. **Show Command**: `ghagga memory show <id>` displays all fields with full content, returns error for not-found and invalid IDs
12. **Delete Command**: `ghagga memory delete <id>` shows confirmation prompt, respects `--force`, cleans up FTS5 entry, returns error for not-found
13. **Stats Command**: `ghagga memory stats` shows total count, by-type breakdown, by-repo breakdown (top 10), DB file size, date range
14. **Clear Command**: `ghagga memory clear` prompts before deletion, supports `--repo` scoping, supports `--force`, cleans up FTS5 entries, returns deletion count
15. **No DB Graceful**: All 6 commands print `'No memory database found. Run "ghagga review" first to build memory.'` when the DB file does not exist, without creating one
16. **Non-TTY Safety**: `delete` and `clear` require `--force` when `process.stdin.isTTY` is falsy; without it, they print error and exit 1
17. **Confirmation**: Interactive prompts use `readline/promises` (Node.js built-in), accept only `y`/`Y` as confirmation
18. **Plain Text Output**: No ANSI colors, no TUI components, no external formatting libraries
19. **No New Dependencies**: No new npm packages added to `packages/core` or `apps/cli`
20. **Unit Tests — SQLite**: All 5 new `SqliteMemoryStorage` methods have tests covering: happy path, empty results, edge cases, FTS5 cleanup on delete/clear
21. **Unit Tests — CLI**: All 6 command handlers have tests covering: happy path, empty results, not found, invalid input, no DB file, non-TTY detection, force mode
22. **Existing Commands Unaffected**: `ghagga review`, `ghagga login`, `ghagga logout`, `ghagga status` continue to work identically
23. **Help Text**: `ghagga memory --help` and each subcommand's `--help` display complete, accurate usage information
