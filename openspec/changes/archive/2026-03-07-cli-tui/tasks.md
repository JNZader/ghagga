# Tasks: CLI TUI Enhancement

> **Change**: cli-tui
> **Created**: 2026-03-07
> **Prerequisite**: Verify baseline — `pnpm test` in `apps/cli/` passes 124 tests before starting.

---

## Phase 1: Foundation (ui/ module + global wiring)

Everything in Phase 2 depends on these files existing. No command files change yet — this phase is purely additive.
- [x] **1.1** Create `apps/cli/src/ui/theme.ts` — Theme constants (~40 lines)
  - Define `BRAND` object (`name: 'GHAGGA'`, `tagline: 'AI Code Review'`)
  - Define `STATUS_EMOJI` map (`Record<ReviewStatus, string>`) — move from `review.ts` lines 280-285
  - Define `SEVERITY_EMOJI` map (`Record<FindingSeverity, string>`) — move from `review.ts` lines 287-293
  - Define `STEP_ICON` map (`Record<string, string>`) — move from `review.ts` lines 236-250
  - Define `SOURCE_LABELS` map (`Record<string, string>`) — move from `review.ts` lines 330-335
  - Export `resolveStepIcon(step: string): string` — resolves known steps via `STEP_ICON`, falls back to `'👤'` for `specialist-*`, `'🗳️'` for `vote-*`, `'▸'` for unknown
  - Import `ReviewStatus` and `FindingSeverity` types from `ghagga-core`
  - _(Covers: CC3 — theme centralization)_

- [x] **1.2** Create `apps/cli/src/ui/format.ts` — Pure formatting functions (~160 lines)
  - Copy `formatTable()`, `formatSize()`, `formatId()`, `truncate()` from `memory/utils.ts` lines 83-128 (identical logic, new location)
  - Copy `formatMarkdownResult()` from `review.ts` lines 298-384 — update to import `STATUS_EMOJI`, `SEVERITY_EMOJI`, `SOURCE_LABELS` from `./theme.js` instead of inline constants
  - Add new `formatKeyValue(label: string, value: string, indent?: number): string` — pads label to fixed width, used by `status` and `memory show`
  - All functions must be pure (string in, string out, no I/O)
  - Import `ReviewResult`, `ReviewStatus`, `FindingSeverity` types from `ghagga-core`
  - _(Covers: R14 results display, CC2 — formatting purity, CC4 — backward compat prep, Design AD4)_

- [x] **1.3** Create `apps/cli/src/ui/tui.ts` — TUI facade (~100 lines)
  - Implement `init(opts?: TuiInitOptions): void` — resolves mode via: `isPlain = opts.plain || !process.stdout.isTTY || !!process.env.CI`
  - Implement `isPlain(): boolean` — returns cached mode
  - Implement `intro(title: string): void` — styled: `clack.intro()` / plain: `console.log('═══ {title} ═══')`
  - Implement `outro(message: string): void` — styled: `clack.outro()` / plain: `console.log('─── {message} ───')`
  - Implement `log` object: `info`, `success`, `warn`, `error`, `step`, `message` — styled: delegates to `clack.log.*` / plain: delegates to `console.log` (error uses `console.error`)
  - Implement `spinner(): TuiSpinner` — styled: wraps `clack.spinner()` / plain: no-op for start/message, `console.log` for stop
  - Export `TuiMode`, `TuiInitOptions`, `TuiSpinner` types
  - `@clack/prompts` is imported ONLY in this file (Design AD1 — facade pattern)
  - _(Covers: R1-R2 mode detection/immutability, R6-R9 log/spinner behavior, R10 no ANSI in plain, Design AD1, AD2)_

- [x] **1.4** Add `@clack/prompts` dependency to `apps/cli/package.json`
  - Add `"@clack/prompts": "0.9.1"` to `dependencies` (exact pin, not caret — design open question)
  - Run `pnpm install` from workspace root
  - _(Covers: R22 — ncc bundling prerequisite)_

- [x] **1.5** Add `--plain` global flag and TUI init hook to `apps/cli/src/index.ts`
  - Add `.option('--plain', 'Disable styled terminal output')` on `program` (after line 46)
  - Add `program.hook('preAction', (thisCommand) => { ... })` that reads the `--plain` option from the root command and calls `tui.init({ plain })` before any command action runs
  - Import `* as tui from './ui/tui.js'`
  - Do NOT change any command action logic yet — only the global wiring
  - _(Covers: R3 --plain flag, S3.1-S3.3, Design AD3)_

### Phase 1 Verification Checkpoint

```bash
# All 124 tests must still pass (no command files changed, only additive)
cd apps/cli && pnpm test

# TypeScript must compile
pnpm typecheck

# Sanity: import the new modules
npx tsx -e "import * as tui from './src/ui/tui.js'; import * as fmt from './src/ui/format.js'; import * as theme from './src/ui/theme.js'; console.log('OK')"
```

---

## Phase 2: Command Migration (console.log -> tui.*)

Each task migrates one command file. Tasks within this phase are independent of each other (any order works), but all depend on Phase 1 being complete. Start with the simplest commands to build confidence, then tackle review.ts last.
- [x] **2.1** Migrate `apps/cli/src/commands/logout.ts` — Simplest command (3 lines)
  - Import `* as tui from '../ui/tui.js'`
  - Line 9: `console.log('ℹ️  Not currently logged in.\n')` → `tui.log.info('Not currently logged in.')`
  - Line 18: `console.log(\`✅ Logged out from ${login}.\`)`→`tui.log.success(\`Logged out from ${login}.\`)`
  - Line 19: `console.log('   Stored credentials have been removed.\n')` → `tui.log.info('Stored credentials have been removed.')`
  - _(Covers: R12 — S12.1, S12.2)_

- [x] **2.2** Migrate `apps/cli/src/commands/status.ts` — Key-value display + remove raw ANSI
  - Import `* as tui from '../ui/tui.js'`
  - Add `tui.intro('GHAGGA Status')` at function start; add `tui.outro('')` at each exit point
  - Line 13: `console.log(\` Config: ${configPath}\`)`→`tui.log.info(\`Config: ${configPath}\`)`
  - Line 16: Remove raw `\x1b[31m...\x1b[0m` ANSI codes, use `tui.log.warn('Not logged in')`
  - Line 17: `console.log(...)` → `tui.log.info('Run "ghagga login" ...')`
  - Lines 21-23: Remove raw `\x1b[32m...\x1b[0m` and `\x1b[1m...\x1b[0m` ANSI codes, use `tui.log.info()` / `tui.log.success()` for values
  - Line 29: Remove ANSI in session valid line → `tui.log.success(\`Session: Valid (${user.login})\`)`
  - Line 31: Remove ANSI in session expired line → `tui.log.warn('Session: Expired or invalid')`
  - Line 37: Remove trailing `console.log('')` (outro handles spacing)
  - _(Covers: R4 intro, R5 outro, R13 — S13.1-S13.3)_

- [x] **2.3** Migrate `apps/cli/src/commands/login.ts` — Device code box + spinner
  - Import `* as tui from '../ui/tui.js'`
  - Add `tui.intro('Authenticating with GitHub')` at function start
  - Lines 43-44: Already logged in → `tui.log.info(\`Already logged in as ${config.githubLogin}.\`)`+`tui.log.info('Run "ghagga logout" first to switch accounts.')`
  - Line 48: `console.log('🔐 Authenticating...')` → `tui.log.info('Authenticating with GitHub...')`
  - Lines 55-58: Remove raw `\x1b[1m\x1b[36m...\x1b[0m` and `\x1b[1m\x1b[33m...\x1b[0m` ANSI codes — use `tui.log.info()` for URL and `tui.log.message()` for the device code display
  - Lines 62, 65: Browser opened / waiting messages → `tui.log.info()`
  - Lines 67-72: Wrap `pollForAccessToken()` with `const s = tui.spinner(); s.start('Waiting for authorization...'); ... s.stop('Authorized!')`
  - Lines 86-88: Remove ANSI in success message → `tui.log.success(\`Logged in as ${user.login}\`)`+`tui.log.info('Provider: github (gpt-4o-mini) — free tier')`+`tui.log.info('Run "ghagga review ." to review your code!')`
  - Add `tui.outro('Authentication complete')` on success path
  - Line 91: `console.error(...)` → `tui.log.error(\`Login failed: ${message}\`)`
  - _(Covers: R4/R5 intro/outro, R7 spinner lifecycle, R11 — S11.1-S11.3)_

- [x] **2.4** Migrate `apps/cli/src/commands/memory/utils.ts` — Move formatters, keep re-exports
  - Remove `formatTable()`, `formatSize()`, `formatId()`, `truncate()` function bodies (lines 83-128)
  - Add: `export { formatTable, formatSize, formatId, truncate } from '../../ui/format.js';`
  - Import `* as tui from '../../ui/tui.js'`
  - Line 32: `console.log(NO_DB_MESSAGE)` → `tui.log.info(NO_DB_MESSAGE)`
  - Lines 56-57 in `confirmOrExit()`: `console.error(...)` → `tui.log.error(...)` (non-TTY destructive op warning)
  - Line 69: `console.log('Cancelled.')` → `tui.log.info('Cancelled.')`
  - Keep `openMemoryOrExit()` and `confirmOrExit()` logic identical — only output calls change
  - Do NOT migrate the `readline` confirmation prompt to clack (Design open question — keep existing approach)
  - _(Covers: CC4 — backward compat re-exports, R15 — memory commands use facade)_

- [x] **2.5** Migrate `apps/cli/src/commands/memory/list.ts` — 2 lines
  - Import `* as tui from '../../ui/tui.js'`
  - Line 37: `console.log('No observations found.')` → `tui.log.info('No observations found.')`
  - Line 52: `console.log(formatTable(...))` → `tui.log.message(formatTable(...))`
  - _(Covers: R15 — S15.1, S15.2)_

- [x] **2.6** Migrate `apps/cli/src/commands/memory/search.ts` — 5 lines
  - Import `* as tui from '../../ui/tui.js'`
  - Line 36: `console.log('No matching observations found.')` → `tui.log.info('No matching observations found.')`
  - Line 40: `console.log(\`Found ${results.length} results...\`)`→`tui.log.info(...)`
  - Line 41: `console.log('')` → (remove or keep as `tui.log.message('')`)
  - Lines 44-48: `console.log(...)` formatting lines → `tui.log.message(...)` for each result entry
  - _(Covers: R15 — S15.4)_

- [x] **2.7** Migrate `apps/cli/src/commands/memory/show.ts` — ~12 lines
  - Import `* as tui from '../../ui/tui.js'`
  - Line 19: `console.log(\`Invalid observation ID...\`)`→`tui.log.error(...)`
  - Line 27: `console.log(\`Observation not found: ${id}\`)`→`tui.log.error(\`Observation not found: ${id}\`)`
  - Lines 33-46: All key-value `console.log` calls → `tui.log.message(...)` (preserving the existing `label()` padding helper)
  - Lines 52, 54, 57: File paths, content header, content lines → `tui.log.message(...)`
  - Consider using `formatKeyValue()` from `ui/format.ts` for the label/value pairs (optional enhancement)
  - _(Covers: R15 — S15.4)_

- [x] **2.8** Migrate `apps/cli/src/commands/memory/delete.ts` — 3 lines
  - Import `* as tui from '../../ui/tui.js'`
  - Line 21: `console.log(\`Invalid observation ID...\`)`→`tui.log.error(...)`
  - Line 29: `console.log(\`Observation not found: ${id}\`)`→`tui.log.error(...)`
  - Line 39: `console.log(\`Deleted observation ${id}.\`)`→`tui.log.success(\`Deleted observation ${id}.\`)`
  - _(Covers: R15 — S15.4)_

- [x] **2.9** Migrate `apps/cli/src/commands/memory/stats.ts` — ~12 lines
  - Import `* as tui from '../../ui/tui.js'`
  - Lines 24-29: Header + DB stats → `tui.log.info(...)` for header, `tui.log.message(...)` for key-value lines
  - Line 38: Date range → `tui.log.message(...)`
  - Lines 41-49: "By Type" section → `tui.log.message(...)` for each entry
  - Lines 52-59: "By Project" section → `tui.log.message(...)` for each entry
  - _(Covers: R15 — S15.3)_

- [x] **2.10** Migrate `apps/cli/src/commands/memory/clear.ts` — 2 lines
  - Import `* as tui from '../../ui/tui.js'`
  - Line 33: `console.log('No observations to clear.')` → `tui.log.info('No observations to clear.')`
  - Line 46: `console.log(\`Cleared ${deleted} observations.\`)`→`tui.log.success(\`Cleared ${deleted} observations.\`)`
  - _(Covers: R15 — S15.4)_

- [x] **2.11** Migrate `apps/cli/src/commands/review.ts` — Most complex (spinner + progress + extract formatting)
  - Import `* as tui from '../ui/tui.js'` and `{ formatMarkdownResult } from '../ui/format.js'` and `{ STEP_ICON, resolveStepIcon } from '../ui/theme.js'`
  - **Remove** the local `STEP_ICON`, `STATUS_EMOJI`, `SEVERITY_EMOJI`, `SOURCE_LABELS` constants (lines 236-250, 280-293, 330-335) — now in `theme.ts`
  - **Remove** the local `formatMarkdownResult()` function (lines 298-384) — now in `format.ts`
  - Add `tui.intro('GHAGGA Code Review')` at function start
  - Line 74: `console.log('ℹ️  No changes detected...')` → `tui.log.info('No changes detected. Stage some changes or make commits to review.')`
  - Lines 85-87: Header/analyzing text → `tui.log.info(\`Mode: ${options.mode} | Provider: ${options.provider} | Model: ${options.model}\`)`
  - Line 98: `console.warn(...)` → `tui.log.warn(\`Failed to initialize memory: ${msg}\`)`
  - **Spinner integration** (Design AD5, AD6):
    - When `!options.verbose`: create `const s = tui.spinner(); s.start('Analyzing...');`, pass `onProgress` callback that calls `s.message(event.message)` for each step, call `s.stop('Analysis complete')` after `reviewPipeline()` resolves
    - When `options.verbose`: no spinner; rewrite `createProgressHandler()` to use `tui.log.step(\`${resolveStepIcon(event.step)} [${event.step}] ${event.message}\`)`for each event, and`tui.log.message(indented detail)` for details
  - Line 130: `console.log(JSON.stringify(...))` → keep as `console.log` (JSON bypasses TUI entirely per R16)
  - Line 132: `console.log(formatMarkdownResult(result))` → `tui.log.message(formatMarkdownResult(result))`
  - Skip `tui.intro()`/`tui.outro()` when `options.format === 'json'` (Design — JSON Format Bypass)
  - Add `tui.outro(STATUS_EMOJI[result.status])` before `process.exit()` (non-JSON path only) — import `STATUS_EMOJI` from `theme.js`
  - Line 143: `console.error(...)` → `tui.log.error(\`Review failed: ${message}\`)`
  - _(Covers: R4/R5 intro/outro, R7/R9 spinner, R14 — S14.1-S14.4, R16 — S16.1-S16.3, R23 — S23.1-S23.3, R24 — S24.1-S24.2, Design AD5, AD6)_

- [x] **2.12** Migrate validation errors in `apps/cli/src/index.ts` — 5 error blocks
  - Import `* as tui from './ui/tui.js'`
  - Lines 136-139: Invalid mode → `tui.log.error(\`Invalid mode "${options.mode}"...\`)`
  - Lines 145-148: Invalid provider → `tui.log.error(\`Invalid provider "${options.provider}"...\`)`
  - Lines 154-157: Invalid format → `tui.log.error(\`Invalid format "${options.format}"...\`)`
  - Lines 162-166: No API key → `tui.log.error('No API key available.')` + `tui.log.info('Quick fix: run "ghagga login"...')` etc.
  - _(Covers: R6 — error writes to stderr, R21 — exit codes unchanged)_

### Phase 2 Verification Checkpoint

```bash
# All 124 tests must still pass
cd apps/cli && pnpm test

# TypeScript must compile
pnpm typecheck
```

---

## Phase 3: Integration & Build Verification

All commands are migrated. Now verify the full system works end-to-end.
- [x] **3.1** Run full test suite and fix any regressions
  - `cd apps/cli && pnpm test` — all 124 tests must pass
  - If any test fails, diagnose: likely a missing re-export in `memory/utils.ts` or a changed `console.log` argument format
  - Fix by adjusting the TUI plain-mode delegation (tests run in non-TTY → plain mode → `console.log`) to match what tests expect
  - _(Covers: CC5 — existing test suite compatibility)_

- [x] **3.2** Verify TypeScript compilation
  - `cd apps/cli && pnpm typecheck` — zero errors
  - Check that `ghagga-core` type imports (`ReviewResult`, `ReviewStatus`, `FindingSeverity`, `ProgressEvent`, `ProgressCallback`) resolve correctly in `ui/format.ts` and `ui/theme.ts`

- [x] **3.3** Verify ncc build and bundle size
  - `cd apps/cli && pnpm build` — TypeScript compilation
  - `npx ncc build dist/index.js -o ncc-out` — single-file bundle
  - Confirm bundle produces a working binary: `node ncc-out/index.js --help`
  - Measure size: `ls -la ncc-out/index.js` — delta from baseline must be < 50KB
  - _(Covers: R22 — S22.1, S22.2)_

- [x] **3.4** Manual smoke tests — all output modes
  - **Styled mode** (real terminal): `npx tsx src/index.ts status` — verify intro/outro, colored badges
  - **Plain mode** (forced): `npx tsx src/index.ts --plain status` — verify no ANSI, no box drawing
  - **CI mode**: `CI=true npx tsx src/index.ts status` — verify same as plain
  - **Piped output**: `npx tsx src/index.ts status | cat` — verify no ANSI artifacts
  - **JSON format**: `npx tsx src/index.ts review . --format json 2>/dev/null` — verify stdout is valid JSON (no intro/outro mixed in)
  - **--help unaffected**: `npx tsx src/index.ts --help` — verify no branded intro appears
  - _(Covers: R1-S1.1-S1.5, R3-S3.1-S3.3, R10-S10.1, R16-S16.1-S16.3, R17-S17.1-S17.2, R18-S18.1-S18.2, R20-S20.1-S20.2)_

---

## Phase 4: Cleanup

Final polish. Command logic is stable — this is housekeeping.
- [x] **4.1** Audit all command files for remaining direct `console.log` / `console.error` calls
  - Run: `grep -rn 'console\.\(log\|error\|warn\)' apps/cli/src/commands/ apps/cli/src/index.ts`
  - **Allowed exceptions**:
    - `review.ts`: `console.log(JSON.stringify(...))` for `--format json` (R16)
    - `review.ts`: `console.warn` in `getExitCode()` exhaustive switch default (dead code path)
  - All other `console.*` calls must be replaced with `tui.*` calls
  - _(Covers: CC1 — facade encapsulation)_

- [x] **4.2** Remove dead imports and unused code from migrated files
  - In `review.ts`: verify the old `STATUS_EMOJI`, `SEVERITY_EMOJI`, `STEP_ICON`, `SOURCE_LABELS`, `formatMarkdownResult` are fully removed (not just commented out)
  - In `memory/utils.ts`: verify old function bodies are removed and only re-exports remain for formatting helpers
  - Remove any unused `import` statements flagged by TypeScript/linter
  - _(Covers: general code hygiene)_

- [x] **4.3** Verify `--plain` appears in help and all flags still work
  - `npx tsx src/index.ts --help` — confirm `--plain` is listed with description "Disable styled terminal output"
  - `npx tsx src/index.ts review --help` — confirm all existing flags are present and unchanged
  - _(Covers: R3-S3.1, R20-S20.1)_

---

## Summary

| Phase     | Tasks  | Focus                                                    |
| --------- | ------ | -------------------------------------------------------- |
| Phase 1   | 5      | Foundation — ui/ module, dependency, global wiring       |
| Phase 2   | 12     | Command migration — console.log → tui.* for all commands |
| Phase 3   | 4      | Integration verification — tests, build, smoke tests     |
| Phase 4   | 3      | Cleanup — dead code removal, final audit                 |
| **Total** | **24** |                                                          |

### Implementation Order

**Phase 1** must be completed first (1.1 → 1.2 → 1.3 → 1.4 → 1.5, in that order — each builds on the previous). Within **Phase 2**, tasks are independent but recommended order is easiest-first: 2.1 (logout) → 2.10 (clear) → 2.8 (delete) → 2.5 (list) → 2.6 (search) → 2.7 (show) → 2.9 (stats) → 2.4 (utils) → 2.2 (status) → 2.3 (login) → 2.12 (index.ts errors) → 2.11 (review.ts). **Phase 3** runs after all of Phase 2. **Phase 4** runs last.

### Spec Coverage

| Requirement                              | Covered by Task(s)                     |
| ---------------------------------------- | -------------------------------------- |
| R1-R2 Mode detection/immutability        | 1.3                                    |
| R3 --plain flag                          | 1.5, 4.3                               |
| R4-R5 intro/outro                        | 2.2, 2.3, 2.11                         |
| R6-R9 Log methods & spinner              | 1.3, 2.3, 2.11                         |
| R10 No ANSI in plain                     | 1.3, 3.4                               |
| R11 Login device code + spinner          | 2.3                                    |
| R12 Logout styled output                 | 2.1                                    |
| R13 Status styled display                | 2.2                                    |
| R14 Review spinner + results             | 2.11                                   |
| R15 Memory commands                      | 2.4-2.10                               |
| R16 JSON format bypass                   | 2.11, 3.4                              |
| R17-R18 Piped/CI output                  | 1.3, 3.4                               |
| R19 NO_COLOR                             | 1.3 (picocolors handles automatically) |
| R20 Existing flags unchanged             | 3.4, 4.3                               |
| R21 Exit codes unchanged                 | 2.11, 2.12                             |
| R22 ncc bundle                           | 1.4, 3.3                               |
| R23-R24 Verbose/spinner mutual exclusion | 2.11                                   |
| CC1-CC5 Cross-cutting concerns           | 1.1-1.3, 2.4, 4.1                      |
