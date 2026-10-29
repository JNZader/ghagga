# Design: CLI TUI Enhancement

## Technical Approach

Replace all raw `console.log` / `console.error` / `process.stderr.write` calls across the CLI with a thin TUI facade (`apps/cli/src/ui/tui.ts`) backed by `@clack/prompts`. The facade auto-detects whether the terminal supports rich output (TTY + not CI + no `--plain` flag) and routes every output call through either the styled path (clack spinners, colored text, branded headers) or the plain path (identical to current `console.log` behavior).

This is a **presentation-only** change. No command logic, exit codes, argument parsing, or core pipeline invocations change. The approach:
1. Create a `ui/` module with three files: `tui.ts` (facade), `format.ts` (formatters), `theme.ts` (constants)
2. Add `--plain` as a global Commander option in `index.ts`
3. Initialize the TUI mode once at startup, before any command runs
4. Migrate each command file to replace `console.log` → `tui.*` calls, one command at a time
5. Move table/size formatting from `memory/utils.ts` to `ui/format.ts` (re-export for backward compat)
6. Wire the review spinner to the existing `onProgress` callback in `review.ts`

The facade pattern means commands never import `@clack/prompts` directly — they import `tui.*` and `format.*`. If clack is replaced in the future, only `tui.ts` changes.

## Architecture Decisions

### AD1: TUI Facade Pattern — Wrap Clack, Never Use Directly

**Choice**: Commands import from `ui/tui.ts` (e.g., `tui.intro()`, `tui.spinner()`, `tui.log.info()`). No command file ever imports `@clack/prompts` or `picocolors` directly.

**Alternatives considered**:
- **Direct clack usage in commands** — Simpler initially, but scatters the dependency across 12+ files. Changing to a different library (e.g., `ora` for spinners) would require touching every file.
- **Abstract `Logger` class** — Over-engineered for this use case. We don't need inheritance or polymorphism; we need a mode switch.

**Rationale**: The facade is ~80 lines of code. It centralizes TTY detection, mode switching, and the entire clack dependency in one file. Commands get a stable API (`tui.log.info()`, `tui.log.success()`, `tui.spinner()`) that works identically in both modes. This also makes testing trivial — mock `tui.ts` instead of mocking `@clack/prompts` internals.

### AD2: CI / TTY Detection Strategy

**Choice**: Determine output mode once at process startup using a three-signal check:

```
isPlain = opts.plain || !process.stdout.isTTY || !!process.env.CI
```

When `isPlain === true`: all `tui.*` calls delegate to `console.log` / `console.error` with zero ANSI escapes and no spinners. When `isPlain === false`: use `@clack/prompts` styled output.

**Alternatives considered**:
- **Per-call detection** — Check `isTTY` on every output call. Wasteful and error-prone (what if stdout changes mid-execution?).
- **Respect only `NO_COLOR`** — `NO_COLOR` disables colors but doesn't disable spinners. We need to detect non-interactive environments (CI, piped output) to also disable spinners.

**Rationale**: The mode is immutable for the lifetime of the process. Determining it once and branching in the facade is simple, predictable, and testable. We additionally respect `NO_COLOR` (per no-color.org) via `picocolors`, which `@clack/prompts` uses internally — so colors auto-disable when `NO_COLOR=1` even in TTY mode. The `CI` env var catches GitHub Actions, GitLab CI, Jenkins, CircleCI, Travis CI, etc.

### AD3: The `--plain` Global Flag

**Choice**: Add `--plain` as a global option on the root `program` Command in `index.ts` (line 43). Read it before any subcommand runs using Commander's `hook('preAction')`. Pass the resolved mode to the TUI facade via `tui.init({ plain: opts.plain })`.

**Alternatives considered**:
- **Per-command `--plain` option** — Would need to be added to every command and subcommand (6+ places). Easy to miss one.
- **Environment variable only (e.g., `GHAGGA_PLAIN=1`)** — Less discoverable. Users expect CLI flags.
- **`--no-color` flag** — Only covers colors, not spinners. `--plain` communicates "strip everything fancy", which is the actual intent.

**Rationale**: A global option on the root program is the idiomatic Commander pattern. It appears in `ghagga --help` once. Commander's `hook('preAction')` runs before any command action, which is the perfect place to call `tui.init()`. The global option plus `preAction` hook means every command — including future ones — automatically gets TUI mode resolution without any per-command wiring.

### AD4: Formatting Logic Location

**Choice**: Create `ui/format.ts` and move `formatTable()`, `formatSize()`, `formatId()`, `truncate()` from `memory/utils.ts` into it. Also move `formatMarkdownResult()` and the `STATUS_EMOJI` / `SEVERITY_EMOJI` maps from `review.ts` (lines 280-384) into `ui/format.ts`. The `memory/utils.ts` file re-exports from `ui/format.ts` for backward compatibility (existing tests import from `./utils.js`).

**Alternatives considered**:
- **Keep formatting in each command** — Status quo. Scatters formatting across `review.ts` (100+ lines), `memory/utils.ts` (50+ lines), and inline ANSI escapes in `login.ts`/`status.ts`. Makes the TUI migration harder because each file mixes logic and presentation.
- **Move everything to `tui.ts`** — Would bloat the facade with formatting details. The facade should be thin (mode detection + routing); formatting is a separate concern.

**Rationale**: `ui/format.ts` becomes the single source of truth for "how does data X look as text?" — tables, review results, severity icons, sizes, IDs. The facade (`tui.ts`) handles "where does it go?" (styled terminal vs. plain console). This separation means format functions are pure (string in, string out) and trivially testable, while TUI routing is a thin wrapper.

### AD5: Spinner Integration with Review Progress Callback

**Choice**: In `review.ts`, create the spinner before calling `reviewPipeline()` (line 108). The existing `onProgress` callback (lines 257-276) gets two behaviors depending on mode:
- **Normal mode (no `--verbose`)**: Start the spinner with `"Analyzing..."`. The `onProgress` callback updates `spinner.message` with each step's message. The spinner keeps spinning while the message changes. After `reviewPipeline()` resolves, stop the spinner.
- **Verbose mode (`--verbose`)**: No spinner. Instead, `onProgress` calls `tui.log.step()` for each event (same semantic content as today's `console.log` in `createProgressHandler()` at line 257, but styled).

In plain mode, the spinner start/stop are no-ops, and `onProgress` falls back to simple `console.log` lines (identical to current verbose output, but without spinner artifacts).

**Alternatives considered**:
- **Spinner in facade only** — The facade doesn't know about `ProgressEvent` types. The command is the right place to map domain events to spinner updates.
- **Multiple spinners (one per step)** — Clack's spinner is designed for sequential start/message/stop cycles, not multiple concurrent spinners. A single spinner with changing messages is the standard pattern.

**Rationale**: The existing `createProgressHandler()` function (review.ts line 257) already maps `ProgressEvent` to console output. We transform this into two code paths: spinner-update (non-verbose) and log-step (verbose). The `STEP_ICON` map (lines 236-250) moves to `ui/theme.ts` and is used by both paths.

### AD6: Verbose Mode + Spinner Conflict Resolution

**Choice**: `--verbose` and the spinner are mutually exclusive. When `verbose: true`:
- No spinner is created
- Each `ProgressEvent` emits a `tui.log.step()` line immediately (icon + step name + message + optional detail)
- This is the same information density as today (review.ts lines 258-275), but styled

When `verbose: false`:
- Spinner is active, showing the latest step message
- Detail lines from `ProgressEvent.detail` are suppressed (they'd conflict with spinner rendering)
- After the spinner stops, the full result is displayed

**Alternatives considered**:
- **Show both spinner and verbose lines** — Spinner writes to the same line via `\r`, so interleaving `console.log` lines causes visual corruption. Not possible without a full terminal UI framework like Ink.
- **Buffer verbose output and show after spinner** — Defeats the purpose of verbose (real-time visibility).

**Rationale**: The existing code already has this distinction: `options.verbose ? createProgressHandler() : undefined` (review.ts line 104-106). We preserve this exact branching. The only change is that non-verbose mode now shows a spinner instead of a static "Analyzing..." message, and verbose mode gets styled output instead of raw `console.log`.

### AD7: intro()/outro() Placement — Per-Command, Not Global

**Choice**: Each command calls `tui.intro()` and `tui.outro()` at its own start/end, rather than wrapping everything in a single intro/outro in `index.ts`.

**Alternatives considered**:
- **Global intro/outro in `index.ts`** — Would show the GHAGGA header even for `--help` and `--version`, which Commander handles before any action runs. Also, error exits (e.g., validation failures at index.ts lines 136-167) would bypass the outro.

**Rationale**: Each command has different context to show in its intro (login shows "Authenticating with GitHub", review shows "mode | provider | model"). The intro/outro are part of the command's user story, not the CLI framework's. Commands that fail early (validation errors) can skip the outro or show an error-styled outro. This is also how clack's own examples work — intro/outro per logical operation.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User invokes: ghagga review . --verbose                        │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ index.ts: Commander parses args                                │
│   • Reads --plain global option                                │
│   • hook('preAction') → tui.init({ plain: false })             │
│   • Detects: isTTY=true, CI=undefined → mode = 'styled'       │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ review action handler (index.ts lines 112-191)                 │
│   • Validates mode, provider, format, API key                  │
│   • Calls reviewCommand(path, options)                         │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ reviewCommand (review.ts)                                      │
│                                                                 │
│   tui.intro('GHAGGA Code Review')                              │
│   tui.log.info('Mode: simple | Provider: github | ...')        │
│                                                                 │
│   ┌─── if NOT verbose ───┐   ┌─── if verbose ───────────────┐ │
│   │ spinner.start()       │   │ (no spinner)                  │ │
│   │ onProgress →          │   │ onProgress →                  │ │
│   │   spinner.message =   │   │   tui.log.step(icon, msg)    │ │
│   │   event.message       │   │                               │ │
│   │ spinner.stop()        │   │                               │ │
│   └───────────────────────┘   └───────────────────────────────┘ │
│                                                                 │
│   formatMarkdownResult(result) → string                        │
│   tui.log.info(formattedOutput)                                │
│   tui.outro(statusLine)                                        │
│   process.exit(code)                                           │
└─────────────────────────────────────────────────────────────────┘
```

### TUI Mode Resolution Flow

```
                    ┌──────────────┐
                    │ tui.init()   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
            ┌─yes── │ --plain ?    │
            │       └──────┬───────┘
            │              │ no
            │       ┌──────▼───────────┐
            │ ┌─no──│ stdout.isTTY ?   │
            │ │     └──────┬───────────┘
            │ │            │ yes
            │ │     ┌──────▼───────┐
            │ │┌yes─│ CI env var ? │
            │ ││    └──────┬───────┘
            │ ││           │ no
            │ ││    ┌──────▼───────┐
            ▼ ▼▼    │  STYLED MODE │
     ┌──────────┐   │  (clack)     │
     │PLAIN MODE│   └──────────────┘
     │(console) │
     └──────────┘
```

### JSON Format Bypass

```
reviewCommand()
     │
     ├── options.format === 'json'?
     │   yes → console.log(JSON.stringify(result))   // No TUI at all
     │   no  → tui.log.info(formatMarkdownResult())  // Styled output
```

Note: When `format === 'json'`, the intro/outro and spinner still appear (they go to stderr or are suppressed by piping), but the result payload is raw JSON on stdout. This matches the convention that `--format json` means "machine-readable data on stdout" while status messages go to stderr. However, since `@clack/prompts` writes to stdout by default, the intro/outro should be skipped entirely when `format === 'json'` to keep stdout clean. The spinner can still run (visual feedback) as long as it cleans up its output before the JSON is printed.

**Revised decision**: When `format === 'json'`, skip `tui.intro()` / `tui.outro()`, suppress `tui.log.*` calls for the result, and use the spinner only if TTY (it self-cleans). The final `console.log(JSON.stringify(...))` remains untouched.

## File Changes

| File                                     | Action     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/ui/tui.ts`                 | **Create** | TUI facade. Exports `init()`, `intro()`, `outro()`, `log.*` (info, success, warn, error, step, message), `spinner()`, `isPlain()`. Internally branches between `@clack/prompts` and plain `console.*` based on mode. ~100 lines.                                                                                                                                                                                                                                                                                                                                                             |
| `apps/cli/src/ui/format.ts`              | **Create** | Pure formatting functions. Receives `formatTable()`, `formatSize()`, `formatId()`, `truncate()` (from `memory/utils.ts` lines 83-128), and `formatMarkdownResult()`, `STATUS_EMOJI`, `SEVERITY_EMOJI` (from `review.ts` lines 280-384). Also new: `formatKeyValue()` for status-style output. ~160 lines.                                                                                                                                                                                                                                                                                    |
| `apps/cli/src/ui/theme.ts`               | **Create** | Constants: `STEP_ICON` map (from `review.ts` lines 236-250), `SOURCE_LABELS` map (from `review.ts` lines 330-335), brand colors for intro/outro, severity colors. ~40 lines.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/cli/src/index.ts`                  | **Modify** | Add `.option('--plain', 'Disable styled terminal output')` on root program (after line 46). Add `hook('preAction')` to call `tui.init()`. Import `tui` module. ~10 lines added.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/cli/src/commands/login.ts`         | **Modify** | Replace `console.log` (lines 43-44, 48, 55-58, 62, 65, 86-88) and `console.error` (line 91) with `tui.*` calls. Add spinner during `pollForAccessToken()` (wrapping lines 68-72). Use `tui.intro()` at start, `tui.outro()` at end. Remove raw ANSI escape sequences (`\x1b[1m\x1b[36m` etc. at lines 56, 58, 86).                                                                                                                                                                                                                                                                           |
| `apps/cli/src/commands/logout.ts`        | **Modify** | Replace `console.log` (lines 9, 18-19) with `tui.log.info()` / `tui.log.success()`. 3 lines changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/cli/src/commands/status.ts`        | **Modify** | Replace `console.log` (lines 12-13, 16-17, 21-23, 29, 31-33, 37) with `tui.*` calls. Remove raw ANSI escape sequences (`\x1b[31m`, `\x1b[32m`, `\x1b[1m` at lines 16, 21, 29, 31). Use `tui.intro()` / `tui.outro()`.                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/cli/src/commands/review.ts`        | **Modify** | (1) Replace `console.log` at lines 74, 85-87, 98, 130, 132, 143 with `tui.*` calls. (2) Extract `formatMarkdownResult()` (lines 298-384), `STATUS_EMOJI` (line 280), `SEVERITY_EMOJI` (line 287), `STEP_ICON` (line 236), `SOURCE_LABELS` (line 330) to `ui/format.ts` and `ui/theme.ts`. (3) Rewrite `createProgressHandler()` (lines 257-276) into two functions: `createSpinnerHandler(spinner)` and `createVerboseHandler()`. (4) Add spinner creation before `reviewPipeline()` call when `!verbose`. (5) Add `tui.intro()` / `tui.outro()` framing. Import `tui` and `format` modules. |
| `apps/cli/src/commands/memory/utils.ts`  | **Modify** | Remove `formatTable()`, `formatSize()`, `formatId()`, `truncate()` function bodies (lines 83-128). Replace with re-exports from `../../ui/format.js`. Keep `openMemoryOrExit()` (lines 24-38) and `confirmOrExit()` (lines 49-75) in place. Replace `console.log` in `openMemoryOrExit()` (line 32) and `confirmOrExit()` (lines 56-57, 69) with `tui.*` calls.                                                                                                                                                                                                                              |
| `apps/cli/src/commands/memory/list.ts`   | **Modify** | Replace `console.log` (lines 37, 52) with `tui.log.info()`. 2 lines changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/cli/src/commands/memory/search.ts` | **Modify** | Replace `console.log` (lines 36, 40-41, 44, 46, 48) with `tui.log.*` calls. 5 lines changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/cli/src/commands/memory/show.ts`   | **Modify** | Replace `console.log` (lines 19, 27, 33-36, 37-46, 52, 54, 57) with `tui.log.*` calls.~12 lines changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/cli/src/commands/memory/delete.ts` | **Modify** | Replace `console.log` (lines 21, 29, 39) with `tui.log.*` calls. 3 lines changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/cli/src/commands/memory/stats.ts`  | **Modify** | Replace `console.log` (lines 24-29, 33, 38-39, 41, 43, 47, 50, 52, 54, 58) with `tui.log.*` calls.~12 lines changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/cli/src/commands/memory/clear.ts`  | **Modify** | Replace `console.log` (lines 33, 46) with `tui.log.*` calls. 2 lines changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/cli/package.json`                  | **Modify** | Add `"@clack/prompts": "^0.9.1"` to `dependencies` (line 51 area).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Files NOT changed**:
- `apps/cli/src/lib/oauth.ts` — No output calls; pure HTTP logic
- `apps/cli/src/lib/git.ts` — No output calls; pure git logic
- `apps/cli/src/lib/config.ts` — No output calls; pure file I/O
- All `*.test.ts` files — Tests spy on `console.log`/`console.error` (e.g., review.test.ts line 255-256). Since the TUI facade delegates to `console.log` in plain mode, and tests run without a TTY (vitest is non-interactive), the facade will auto-select plain mode in tests. **Existing tests pass without modification.**

## Interfaces / Contracts

### `ui/tui.ts` — TUI Facade API

```typescript
/**
 * Output mode: 'styled' uses @clack/prompts, 'plain' uses console.*.
 * Determined once at init() and immutable for the process lifetime.
 */
export type TuiMode = 'styled' | 'plain';

export interface TuiInitOptions {
  /** User explicitly passed --plain */
  plain?: boolean;
}

/**
 * Initialize the TUI mode. Must be called once before any output.
 * Auto-detects styled vs. plain based on TTY, CI, and --plain flag.
 */
export function init(opts?: TuiInitOptions): void;

/** Returns the current mode. Useful for conditional logic in commands. */
export function isPlain(): boolean;

/**
 * Display a branded intro header.
 * Styled: clack intro() with box drawing and colors.
 * Plain: simple "═══ {title} ═══" line.
 */
export function intro(title: string): void;

/**
 * Display a branded outro footer.
 * Styled: clack outro() with box drawing.
 * Plain: simple "─── {message} ───" line.
 */
export function outro(message: string): void;

/** Structured log methods. */
export const log: {
  /** Informational message (blue dot in styled, plain text in plain). */
  info(message: string): void;

  /** Success message (green checkmark in styled). */
  success(message: string): void;

  /** Warning message (yellow triangle in styled). */
  warn(message: string): void;

  /** Error message (red X in styled, goes to stderr). */
  error(message: string): void;

  /** Step in a process (used for verbose progress). */
  step(message: string): void;

  /** Raw message with no icon prefix (for tables, multi-line output). */
  message(message: string): void;
};

export interface TuiSpinner {
  /** Start the spinner with an initial message. */
  start(message?: string): void;

  /** Update the spinner's message while it's spinning. */
  message(message: string): void;

  /** Stop the spinner with a final message (shown as success). */
  stop(message?: string): void;
}

/**
 * Create a spinner instance.
 * Styled: animated clack spinner.
 * Plain: no-op start/message, stop() prints the final message.
 */
export function spinner(): TuiSpinner;
```

### `ui/format.ts` — Format Module API

```typescript
import type { ReviewResult, ReviewStatus, FindingSeverity } from 'ghagga-core';

/**
 * Format a plain-text table with headers, separator, and padded columns.
 * Moved from memory/utils.ts — same signature, same behavior.
 */
export function formatTable(headers: string[], rows: string[][], widths: number[]): string;

/** Format bytes as human-readable size (N bytes / N.N KB / N.N MB). */
export function formatSize(bytes: number): string;

/** Format observation ID as 8-char zero-padded string. */
export function formatId(id: number): string;

/** Truncate a string to maxLen characters, appending "..." if truncated. */
export function truncate(str: string, maxLen: number): string;

/**
 * Format a ReviewResult as a human-readable markdown string.
 * Moved from review.ts — same output, but uses theme constants.
 */
export function formatMarkdownResult(result: ReviewResult): string;

/**
 * Format a key-value pair with padded label.
 * Used by status and memory show commands.
 * Example: formatKeyValue('Provider', 'github') → "   Provider:  github"
 */
export function formatKeyValue(label: string, value: string, indent?: number): string;
```

### `ui/theme.ts` — Theme Constants

```typescript
import type { ReviewStatus, FindingSeverity } from 'ghagga-core';

/** Brand identity for intro/outro. */
export const BRAND = {
  name: 'GHAGGA',
  tagline: 'AI Code Review',
} as const;

/** Status display with emoji. */
export const STATUS_EMOJI: Record<ReviewStatus, string> = {
  PASSED: '✅ PASSED',
  FAILED: '❌ FAILED',
  NEEDS_HUMAN_REVIEW: '⚠️  NEEDS HUMAN REVIEW',
  SKIPPED: '⏭️  SKIPPED',
};

/** Severity indicator with colored emoji. */
export const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
  info: '🟣',
};

/** Step icons for verbose progress output. */
export const STEP_ICON: Record<string, string> = {
  validate: '🔍',
  'parse-diff': '📄',
  'detect-stacks': '🧩',
  'token-budget': '📊',
  'static-analysis': '🛡️',
  'static-results': '📋',
  'agent-start': '🤖',
  'simple-call': '💬',
  'simple-done': '✅',
  'workflow-start': '🔄',
  'workflow-synthesis': '🧬',
  'consensus-start': '🗳️',
  'consensus-voting': '🏛️',
};

/** Source labels for review findings. */
export const SOURCE_LABELS: Record<string, string> = {
  semgrep: '🔍 Semgrep',
  trivy: '🛡️ Trivy',
  cpd: '📋 CPD',
  ai: '🤖 AI Review',
};

/**
 * Resolve the icon for a progress step.
 * Known steps use STEP_ICON, dynamic steps (specialist-*, vote-*) get fallback icons.
 */
export function resolveStepIcon(step: string): string;
```

## Testing Strategy

### Existing Tests — Must Pass Unchanged (124 tests)

The existing test suite does NOT need modification because:
1. **Tests run in non-TTY mode** — Vitest runs in a child process without a real TTY. The TUI facade's auto-detection will select plain mode (`process.stdout.isTTY === undefined/false` in test runners). In plain mode, `tui.log.info(msg)` delegates to `console.log(msg)`, which is exactly what tests already spy on (review.test.ts lines 255-256: `vi.spyOn(console, 'log')`).

2. **Format functions keep exact signatures** — `formatTable()`, `formatSize()`, `formatId()`, `truncate()` move to `ui/format.ts` but `memory/utils.ts` re-exports them. Tests like `utils.test.ts` (lines 11, 16-55, 59-78, 82-97, 101-115) import from `./utils.js` and will get the re-exported functions with identical behavior.

3. **review.test.ts spies on console.log** — The functional tests (lines 245-528) assert on `logSpy.mock.calls`. Since TUI plain mode → `console.log`, these assertions still hold. The `formatMarkdownResult()` output structure doesn't change (same sections, same emoji, same text), it just lives in `ui/format.ts` now.

4. **config.test.ts and git.test.ts** — These test pure logic in `lib/config.ts` and `lib/git.ts`, which are not modified by this change.

### Verification Steps During Implementation

| Check                    | How                                                                        |
| ------------------------ | -------------------------------------------------------------------------- |
| All 124 tests pass       | `pnpm test` in `apps/cli/`                                                 |
| TypeScript compiles      | `pnpm typecheck` in `apps/cli/`                                            |
| ncc bundle succeeds      | `npx ncc build dist/index.js -o ncc-out` (or project's actual ncc command) |
| Bundle size delta < 50KB | Compare `ls -la dist/index.js` before/after                                |
| Plain mode works         | `CI=true npx tsx src/index.ts status` — should look like current output    |
| Styled mode works        | `npx tsx src/index.ts status` in a real terminal                           |
| Piped output is clean    | `npx tsx src/index.ts status                                               | cat` — no ANSI artifacts |
| JSON format untouched    | `npx tsx src/index.ts review . --format json` — raw JSON on stdout         |

### Future Tests (Deferred to `test-coverage-audit`)

When test coverage is expanded, the TUI layer should be tested with:

| Layer       | What to Test                  | Approach                                                                                                                                                                  |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tui.init()` mode detection   | Mock `process.stdout.isTTY`, `process.env.CI`, pass `{ plain: true/false }`. Assert `isPlain()` returns correct value.                                                    |
| Unit        | `tui.log.*` plain mode output | Init in plain mode, spy on `console.log`, call `tui.log.info('msg')`, assert `console.log` was called with `'msg'`.                                                       |
| Unit        | `tui.spinner()` plain mode    | Init in plain mode, create spinner, call `start()` + `message()` + `stop('done')`. Assert only `stop()` produces output.                                                  |
| Unit        | `formatMarkdownResult()`      | Same assertions as current review.test.ts lines 343-417, but imported from `ui/format.ts`.                                                                                |
| Unit        | `formatKeyValue()`            | Assert label padding and indentation.                                                                                                                                     |
| Unit        | `resolveStepIcon()`           | Assert known steps, specialist-* fallback, vote-* fallback, unknown fallback.                                                                                             |
| Integration | Commands with styled mode     | Snapshot test: capture ANSI output of each command in styled mode, assert it matches expected snapshot. Requires TTY simulation (e.g., `script` command or `pseudo-tty`). |

## Migration / Rollout

No data migration is needed. No config file changes. No API changes.

### Build Verification Steps

1. **Before starting**: Run `pnpm test` to confirm baseline (124 tests pass)
2. **After each command migration**: Run `pnpm test` to catch regressions
3. **After all changes**: Full verification:

   ```bash
   # Type check
   pnpm typecheck

   # Unit tests
   pnpm test

   # Build
   pnpm build

   # ncc bundle (if project uses ncc for single-file distribution)
   npx ncc build dist/index.js -o ncc-out

   # Bundle size check
   ls -la ncc-out/index.js   # Should be < 50KB larger than before

   # Manual smoke tests
   CI=true node dist/index.js status          # Plain mode
   node dist/index.js status                   # Styled mode (if TTY)
   node dist/index.js review . --format json   # JSON bypass
   echo "test" | node dist/index.js status     # Piped input (plain)
   node dist/index.js --plain status           # Explicit plain flag
   ```

### Rollback

Revert the PR. Remove `@clack/prompts` from `package.json`. The `ui/` directory is additive — deleting it and reverting command files restores exact prior behavior. No database, config, or API changes to undo.

## Open Questions

- [ ] **Clack version pinning**: `@clack/prompts` is at `0.9.x` (pre-1.0). Should we pin to exact version (`0.9.1`) or use caret range (`^0.9.1`)? Pre-1.0 semver allows breaking changes on minor bumps. **Recommendation**: Pin exact (`0.9.1`) for stability; bump deliberately.

- [ ] **Spinner cleanup on SIGINT**: If the user presses Ctrl+C during a review spinner, does clack clean up the cursor? Need to verify clack's built-in `isCancel()` handling. If not, add a `process.on('SIGINT', ...)` handler that calls `spinner.stop()` before exit.

- [ ] **stderr vs stdout for TUI chrome**: `@clack/prompts` writes everything to `process.stdout`. For commands with `--format json`, the intro/outro/spinner should ideally go to stderr (so stdout is pure JSON). Clack doesn't support stderr out of the box. **Mitigation**: Skip intro/outro entirely when `format === 'json'`. The spinner self-cleans so it won't appear in piped stdout.

- [ ] **`confirmOrExit` in memory/utils.ts**: Currently uses `readline/promises` for the delete/clear confirmation prompt (line 62). Should this be migrated to clack's `confirm()` prompt? **Recommendation**: No — clack's `confirm()` is interactive and would change the UX. Keep the existing readline approach; just route the output messages through `tui.log.*`. This avoids scope creep and keeps the change purely cosmetic.
