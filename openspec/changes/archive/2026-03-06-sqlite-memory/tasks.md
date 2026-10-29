# Tasks: SQLite Memory for CLI and Action

## Phase 1: Foundation — Types, Interface, and Dependency Changes

- [x] 1.1 Add `MemoryStorage` interface and `MemoryObservationRow` interface to `packages/core/src/types.ts`
  - Add the `MemoryStorage` interface (5 methods: `searchObservations`, `saveObservation`, `createSession`, `endSession`, `close`) exactly as defined in `design.md` lines 231–257
  - Add the `MemoryObservationRow` interface (`id`, `type`, `title`, `content`, `filePaths`) at lines 263–269
  - Place both after the existing `ObservationType` enum (line 264) and `MemoryObservation` type (line 273)
  - Export both interfaces
  - **Verify**: `npx tsc --noEmit` passes in `packages/core`

- [x] 1.2 Replace `ReviewInput.db` with `ReviewInput.memoryStorage` in `packages/core/src/types.ts`
  - Remove `db?: unknown;` (line 95)
  - Add `memoryStorage?: MemoryStorage;` with JSDoc comment: "Memory storage backend for search and persist operations. Undefined when memory is disabled or unavailable — pipeline degrades gracefully."
  - **Verify**: `npx tsc --noEmit` will show errors in pipeline.ts, search.ts, persist.ts, server review.ts, cli review.ts, action index.ts — expected (fixed in later tasks)

- [x] 1.3 Update `packages/core/package.json` dependencies
  - Remove `"ghagga-db": "workspace:^"` from `dependencies` (line 57)
  - Add `"sql.js": "^1.11.0"` to `dependencies`
  - Run `pnpm install` to update the lockfile
  - **Verify**: `grep -r "ghagga-db" packages/core/package.json` returns zero matches; `sql.js` appears in dependencies

## Phase 2: Core Implementation — SQLite and Refactored Memory Modules

- [x] 2.1 Create `SqliteMemoryStorage` class in `packages/core/src/memory/sqlite.ts`
  - Implement the full class as specified in `design.md` lines 290–555
  - Private constructor, static `async create(filePath)` factory
  - Schema DDL with `CREATE TABLE IF NOT EXISTS` for `memory_sessions`, `memory_observations`, indexes, FTS5 virtual table, and sync triggers
  - `searchObservations`: FTS5 MATCH with OR-joined keywords, BM25 ranking, project scoping, type filtering, limit
  - `saveObservation`: SHA-256 content hash dedup (15-min window), topicKey upsert with `RETURNING`, new observation insert
  - `createSession` / `endSession`: basic session lifecycle
  - `close`: `db.export()` → `writeFileSync`, create parent dirs if needed
  - Import `MemoryStorage` and `MemoryObservationRow` from `../types.js`
  - **Verify**: File compiles with `npx tsc --noEmit`

- [x] 2.2 Refactor `packages/core/src/memory/search.ts` to use `MemoryStorage` interface
  - Remove `import { searchObservations } from 'ghagga-db'` (line 9)
  - Remove the local `Observation` interface (lines 15–20) — use `MemoryObservationRow` from types instead
  - Change `searchMemoryForContext` signature: `db: unknown` → `storage: MemoryStorage`
  - Import `MemoryStorage` from `../types.js`
  - Replace `searchObservations(db as ..., project, query, { limit: 3 })` with `storage.searchObservations(project, query, { limit: 3 })`
  - Update null-guard: `if (!db)` → `if (!storage)`
  - Update the `observations.map(obs => ...)` to map from `MemoryObservationRow` (field names match)
  - **Verify**: No `ghagga-db` import remains in this file

- [x] 2.3 Refactor `packages/core/src/memory/persist.ts` to use `MemoryStorage` interface
  - Remove `import { saveObservation, createMemorySession, endMemorySession } from 'ghagga-db'` (line 9)
  - Import `MemoryStorage` from `../types.js`
  - Change `persistReviewObservations` signature: `db: unknown` → `storage: MemoryStorage`
  - Replace `if (!db) return;` → `if (!storage) return;`
  - Remove `const typedDb = db as Parameters<typeof saveObservation>[0];` (line 68)
  - Replace `createMemorySession(typedDb, { project, prNumber })` → `storage.createSession({ project, prNumber })`
  - Replace `saveObservation(typedDb, { ... })` → `storage.saveObservation({ ... })` (lines 91–98 and 103–111)
  - Replace `endMemorySession(typedDb, session.id, ...)` → `storage.endSession(session.id, ...)`
  - **Verify**: No `ghagga-db` import remains in this file

- [x] 2.4 Refactor `packages/core/src/pipeline.ts` to use `input.memoryStorage`
  - In `searchMemorySafe` (lines 365–386): replace `!input.db` → `!input.memoryStorage`; replace `input.db` → `input.memoryStorage` in the call to `searchMemoryForContext`
  - In Step 8 persist (lines 256–269): replace `input.db` → `input.memoryStorage`; replace `input.db` → `input.memoryStorage` in the call to `persistReviewObservations`
  - **Change persist to await**: Replace the fire-and-forget pattern with `await persistReviewObservations(input.memoryStorage, ...).catch(...)` — ensures the in-memory SQLite DB is populated before callers call `close()`
  - **Verify**: `npx tsc --noEmit` in `packages/core`; `grep -r "input.db" packages/core/src/pipeline.ts` returns zero matches

- [x] 2.5 Verify `packages/core` has zero `ghagga-db` imports
  - Run `grep -r "from 'ghagga-db'" packages/core/src/` — MUST return zero matches
  - Run `grep -r "ghagga-db" packages/core/package.json` — MUST return zero matches
  - Run `npx tsc --noEmit` in `packages/core` — MUST pass (with expected errors in downstream apps)
  - **Verify**: This is the R9 (Core Independence) checkpoint

## Phase 3: Server Adapter — PostgresMemoryStorage

- [x] 3.1 Create `PostgresMemoryStorage` class in `apps/server/src/memory/postgres.ts`
  - Create the `apps/server/src/memory/` directory if it doesn't exist
  - Implement the class exactly as specified in `design.md` lines 558–627
  - Constructor takes `Database` (from `ghagga-db`)
  - `searchObservations` → delegates to `ghagga-db.searchObservations`, maps rows to `MemoryObservationRow`
  - `saveObservation` → delegates to `ghagga-db.saveObservation`, maps row
  - `createSession` → delegates to `ghagga-db.createMemorySession`, returns `{ id }`
  - `endSession` → delegates to `ghagga-db.endMemorySession`
  - `close` → no-op (`async close(): Promise<void> {}`)
  - Import `MemoryStorage` and `MemoryObservationRow` from `ghagga-core`
  - **Verify**: `npx tsc --noEmit` in `apps/server`

- [x] 3.2 Update `apps/server/src/inngest/review.ts` to use `PostgresMemoryStorage`
  - Import `PostgresMemoryStorage` from `../memory/postgres.js`
  - After `db = createDatabaseFromEnv()` (line 243), create: `const memoryStorage = db ? new PostgresMemoryStorage(db) : undefined;`
  - In the `ReviewInput` object (line 249–277): replace `db,` (line 276) with `memoryStorage,`
  - **Verify**: `npx tsc --noEmit` in `apps/server`

- [x] 3.3 Check for other server call sites that pass `db` to `reviewPipeline`
  - Search `apps/server/src/` for other files calling `reviewPipeline` with `db:`
  - Update any found call sites to use `PostgresMemoryStorage` (same pattern as 3.2)
  - **Verify**: `grep -r "db:" apps/server/src/ | grep reviewPipeline` returns zero matches (or only the updated pattern)

## Phase 4: CLI Integration — SQLite Memory + Git Remote

- [x] 4.1 Create `resolveProjectId` utility in `apps/cli/src/lib/git.ts`
  - Create the file with `resolveProjectId(repoPath)` and `normalizeRemoteUrl(url)` functions as specified in `design.md` lines 629–681
  - `resolveProjectId`: runs `git remote get-url origin` via `execSync`, normalizes via `normalizeRemoteUrl`, falls back to `"local/unknown"` on error
  - `normalizeRemoteUrl`: strips `.git` suffix, handles SSH (`git@host:owner/repo`) and HTTPS (`https://host/owner/repo`) formats
  - Export both functions
  - **Verify**: `npx tsc --noEmit` in `apps/cli`

- [x] 4.2 Add `--no-memory` option to CLI Commander.js in `apps/cli/src/index.ts`
  - Add `.option('--no-memory', 'Disable review memory')` after line 109 (after `--verbose`)
  - The `ReviewCommandOptions` or equivalent type at the action callback already handles `--no-*` patterns (see `semgrep`, `trivy`, `cpd`) — `memory` will be `true` by default, `--no-memory` sets it to `false`
  - **Verify**: `npx ghagga review --help` shows `--no-memory`

- [x] 4.3 Update `ReviewOptions` interface in `apps/cli/src/commands/review.ts`
  - Add `memory: boolean;` to the `ReviewOptions` interface (line 29–40)
  - **Verify**: Type check passes

- [x] 4.4 Integrate `SqliteMemoryStorage` into CLI review command in `apps/cli/src/commands/review.ts`
  - Import `SqliteMemoryStorage` from `ghagga-core` (or directly from `ghagga-core/memory/sqlite`)
  - Import `resolveProjectId` from `../lib/git.js`
  - Import `getConfigDir` from `../lib/config.js`
  - Import `join` from `node:path` (already imported)
  - Before the `reviewPipeline` call (line 87):
    - If `options.memory` is `true`:
      1. Resolve `dbPath = join(getConfigDir(), 'memory.db')`
      2. Create `memoryStorage = await SqliteMemoryStorage.create(dbPath)` wrapped in try/catch (log warning on failure, set `memoryStorage = undefined`)
      3. Resolve `repoFullName = resolveProjectId(repoPath)` (replace hardcoded `'local/review'` at line 95) - If `options.memory` is `false`: set `memoryStorage = undefined`, keep `repoFullName = resolveProjectId(repoPath)`
  - Update the `reviewPipeline` call:
    - Replace `db: undefined` (line 100) with `memoryStorage,`
      - Set `enableMemory: options.memory` in `settings` (currently not set, so it uses `DEFAULT_SETTINGS.enableMemory` which is `false` — override to `true` when memory is enabled)
      - Replace `repoFullName: 'local/review'` (line 95) with the resolved value
  - Update `mergeSettings()` (line 199): change `enableMemory: false` to `enableMemory: options.memory ?? true` — this function currently hardcodes `false` and would override the pipeline call's setting
  - After the pipeline completes (before formatting/exit), call `await memoryStorage?.close()` to persist to disk
  - **Verify**: `npx tsc --noEmit` in `apps/cli`

## Phase 5: Action Integration — SQLite Memory + @actions/cache

- [x] 5.1 Add `enable-memory` input to `action.yml` (root) and `apps/action/action.yml`
  - In `/action.yml` (root, line 64 area), add:

    ```yaml
    enable-memory:
      description: >-
        Enable review memory. Caches observations between runs via @actions/cache.
        Set to 'false' to disable.
      required: false
      default: 'true'
    ```
  - In `apps/action/action.yml`, add the equivalent input
  - **Verify**: Both YAML files are valid

- [x] 5.2 Add `sql.js` dependency to `apps/action/package.json`
  - Add `"sql.js": "^1.11.0"` to dependencies
  - Run `pnpm install`
  - **Verify**: `sql.js` appears in `apps/action/node_modules/`

- [x] 5.3 Integrate `SqliteMemoryStorage` and `@actions/cache` into `apps/action/src/index.ts`
  - Import `SqliteMemoryStorage` from `ghagga-core`
  - Import `* as cache` from `@actions/cache`
  - Read `enable-memory` input: `const enableMemory = core.getInput('enable-memory') !== 'false';`
  - Define constants: `const MEMORY_DB_PATH = '/tmp/ghagga-memory.db';` and `const cacheKey = \`ghagga-memory-${repoFullName}\`;`
  - Before the pipeline call (after Step 5.5, around line 134):
    - If `enableMemory`:
      1. Try `cache.restoreCache([MEMORY_DB_PATH], cacheKey, [cacheKey])` — log hit/miss, ignore errors
      2. Create `memoryStorage = await SqliteMemoryStorage.create(MEMORY_DB_PATH)` wrapped in try/catch - Else: `memoryStorage = undefined`
  - Update the `reviewPipeline` call (lines 147–168):
    - Replace `enableMemory: false` (line 158) with `enableMemory,`
    - Replace `db: undefined` (line 166) with `memoryStorage,`
  - After the pipeline completes and comment is posted (after line 178):
    - If `memoryStorage`: `await memoryStorage.close()` then `await cache.saveCache([MEMORY_DB_PATH], cacheKey)` wrapped in try/catch (log warning on failure, don't fail the action)
  - **Verify**: `npx tsc --noEmit` in `apps/action`

- [x] 5.4 Validate ncc bundling with sql.js WASM
  - Run `pnpm --filter ghagga-action build` (which runs `ncc build`)
  - Check that `apps/action/dist/` contains the WASM asset (or that sql.js is inlined)
  - If ncc fails to bundle the WASM, implement the `locateFile` fallback from `design.md` lines 808–816:
    - Add `locateFile: (file) => path.join(__dirname, file)` to `initSqlJs()` in `SqliteMemoryStorage`
    - Add a post-build copy step: `cp node_modules/sql.js/dist/sql-wasm.wasm dist/`
  - **Verify**: Run `node apps/action/dist/index.js` in a minimal test environment to verify WASM loads (expected to fail on missing GitHub context, but WASM init should succeed or fail with a clear non-WASM error)

## Phase 6: Testing — Unit, Integration, and Mutation

- [x] 6.1 Create unit tests for `SqliteMemoryStorage` in `packages/core/src/memory/sqlite.test.ts`
  - Test schema initialization (tables, FTS5 virtual table, indexes exist after `create()`)
  - Test `saveObservation` — insert new observation, verify returned row shape
  - Test content-hash deduplication — save same content within 15 minutes, verify no duplicate
  - Test dedup window expired — mock/manipulate timestamp, verify new row created
  - Test topicKey upsert — save with topicKey, save again with same topicKey, verify update (revisionCount incremented)
  - Test `searchObservations` — FTS5 keyword match returns correct results, BM25 ordering
  - Test project scoping — observations from other projects not returned
  - Test type filtering — only matching type returned
  - Test limit — returned results respect limit
  - Test `createSession` / `endSession` — session lifecycle
  - Test `close` — verify `db.export()` called, file written (mock `fs` for write verification)
  - Test `file_paths` JSON serialization/deserialization
  - Use real sql.js with in-memory DB (pass a temp file path), fast and deterministic
  - **Verify**: `pnpm --filter ghagga-core test` passes; all new tests pass

- [x] 6.2 Update `packages/core/src/memory/search.test.ts` to use mock `MemoryStorage`
  - Remove `vi.mock('ghagga-db', ...)` mock
  - Create a mock `MemoryStorage` object with `vi.fn()` for each method
  - Pass mock `storage` instead of `db` to `searchMemoryForContext`
  - Update assertions: `mockSearchObservations` → `storage.searchObservations`
  - Verify existing test scenarios still pass (empty results, formatted context, error handling)
  - **Verify**: `pnpm --filter ghagga-core test -- search.test` passes

- [x] 6.3 Update `packages/core/src/memory/persist.test.ts` to use mock `MemoryStorage`
  - Remove `vi.mock('ghagga-db', ...)` mock
  - Create a mock `MemoryStorage` object with `vi.fn()` for each method
  - Pass mock `storage` instead of `db` to `persistReviewObservations`
  - Update assertions: check `storage.createSession`, `storage.saveObservation`, `storage.endSession` were called with correct args
  - Verify existing test scenarios still pass (significant findings persisted, non-significant filtered, session lifecycle, error handling)
  - **Verify**: `pnpm --filter ghagga-core test -- persist.test` passes

- [x] 6.4 Update pipeline tests for `memoryStorage` field
  - Find existing pipeline tests (likely in `packages/core/src/pipeline.test.ts` or similar)
  - Replace `db: mockDb` with `memoryStorage: mockStorage` in test inputs
  - Add explicit test for `memoryStorage: undefined` — verify graceful degradation (search returns null, persist skipped)
  - Verify the `await` change on persist doesn't break existing test timing assumptions
  - **Verify**: `pnpm --filter ghagga-core test` passes

- [x] 6.5 Update `apps/server/src/inngest/review.test.ts` to use `memoryStorage: undefined`
  - Mock all `ghagga-db` imports (`searchObservations`, `saveObservation`, `createMemorySession`, `endMemorySession`)
  - Test each method delegates correctly to the mocked function
  - Test row mapping: Drizzle row → `MemoryObservationRow` shape
  - Test `close()` is a no-op (doesn't throw, returns void)
  - **Verify**: `pnpm --filter ghagga-server test -- postgres.test` passes

- [x] 6.6 Create unit tests for `resolveProjectId` and `normalizeRemoteUrl` in `apps/cli/src/lib/git.test.ts`
  - Mock `execSync` from `node:child_process`
  - Test HTTPS URL: `https://github.com/acme/widgets.git` → `acme/widgets`
  - Test SSH URL: `git@github.com:acme/widgets.git` → `acme/widgets`
  - Test SSH protocol URL: `ssh://git@github.com/acme/widgets.git` → `acme/widgets`
  - Test URL without `.git`: `https://github.com/acme/widgets` → `acme/widgets`
  - Test GitLab URL: `https://gitlab.com/acme/widgets.git` → `acme/widgets`
  - Test no remote (command throws): falls back to `"local/unknown"`
  - **Verify**: `pnpm --filter ghagga-cli test -- git.test` passes

- [x] 6.7 Run the full test suite — all 1,238 tests pass (zero failures)
  - Run `pnpm test` at the repo root
  - All existing tests MUST pass (zero regressions)
  - All new tests from 6.1–6.6 MUST pass
  - **Verify**: Exit code 0, no failures

## Phase 7: Validation and Cleanup

- [x] 7.1 Run TypeScript type check across the entire monorepo
  - Run `pnpm -r exec npx tsc --noEmit` (or equivalent turbo command)
  - All packages must compile with zero type errors
  - **Verify**: Clean output, exit code 0

- [x] 7.2 Verify ncc Action bundle end-to-end
  - Run `pnpm --filter ghagga-action build`
  - Verify `apps/action/dist/index.js` exists and includes sql.js references
  - Verify WASM asset is bundled or available as sibling file
  - **Verify**: Bundle size is reasonable (~1-2MB increase from WASM)

- [x] 7.3 Run mutation testing on `SqliteMemoryStorage` with Stryker
  - Configure Stryker for `packages/core/src/memory/sqlite.ts` if not already configured
  - Run mutation testing: `npx stryker run --mutate packages/core/src/memory/sqlite.ts`
  - Target: >80% mutation score
  - Critical mutants to check: dedup window check, topicKey upsert logic, FTS5 query construction, RETURNING clause parsing
  - **Verify**: Mutation score >80%

- [x] 7.4 Verify R9 (Core Independence) final check
  - `grep -r "from 'ghagga-db'" packages/core/src/` → zero matches
  - `grep "ghagga-db" packages/core/package.json` → zero matches
  - `pnpm --filter ghagga-core exec npx tsc --noEmit` → passes independently
  - **Verify**: Core package has zero coupling to ghagga-db

- [x] 7.5 Run linter and formatter
  - Run `pnpm lint` (or equivalent) across the monorepo
  - Fix any lint errors introduced by the changes
  - Run `pnpm format` (or equivalent) to ensure consistent formatting
  - **Verify**: Clean lint output
