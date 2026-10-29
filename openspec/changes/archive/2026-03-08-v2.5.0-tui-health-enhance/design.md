# Design: CLI Enhancements — TUI Polish, Output Formats, AI Enhance, Health Command, Issue Export

## Technical Approach

Five features land in a single release, all layered on top of the existing TUI facade pattern established in the `cli-tui` change. The strategy is:
1. **TUI facade extension** — Add `severity()`, `box()`, `divider()`, `progress()` to the existing `ui/tui.ts` facade. A new `ui/chalk.ts` adapter wraps chalk v5, ensuring commands never import chalk directly (extending AD1 from cli-tui design). The facade remains the single output abstraction; the four new methods follow the same `_plain` branching pattern used by `intro()`, `outro()`, `log.*`, and `spinner()`.

2. **Core-side modules for reuse** — AI Enhance (`packages/core/src/enhance/`), health scoring (`packages/core/src/health/`), and SARIF builder (`packages/core/src/sarif/`) live in the core package so they're usable from CLI, Action, and SaaS. These modules are pure functions with no CLI dependencies.

3. **CLI-side wiring** — The health command handler (`commands/health.ts`), GitHub API client (`lib/github-api.ts`), and output format routing live in `apps/cli/`. The review command is extended with `--output`, `--enhance`, and `--issue` flags. The health command is registered alongside review, login, status, etc.

4. **Plain mode extended** — The existing `isPlain` detection (`opts.plain || !process.stdout.isTTY || !!process.env.CI`) gains a fourth signal: `!!opts.output`. When `--output` is specified, TUI decorations are fully suppressed and only the raw format goes to stdout.

All changes follow the existing patterns: Commander for arg parsing, `tui.*` for output, pure functions in `ui/format.ts`, theme constants in `ui/theme.ts`, and the pipeline orchestrator in `packages/core/src/pipeline.ts`.

## Architecture Decisions

### AD1: Extend tui.ts In-Place — No Separate Module

**Choice**: Add `severity()`, `box()`, `divider()`, `progress()` as new exports in the existing `apps/cli/src/ui/tui.ts` file.

**Alternatives considered**:
- **New `ui/tui-extensions.ts` module** — Would split the facade across two files, breaking the "single import for all output" convention.
- **Class-based TUI with inheritance** — Over-engineered. The current module pattern (`export function`) is simpler and matches the existing code.

**Rationale**: `tui.ts` is currently 148 lines. Adding four methods (~80 lines) brings it to ~230 lines — well within a reasonable single-file size. Commands already do `import * as tui from '../ui/tui.js'`, and adding methods to the same module means zero import changes in existing command files. The new methods follow the identical pattern: check `_plain`, branch to clack/chalk-styled output or plain `console.log`.

### AD2: chalk.ts Adapter — Thin Wrapper, Not Direct Usage

**Choice**: Create `apps/cli/src/ui/chalk.ts` that imports chalk v5 and re-exports color functions. `tui.ts` imports from `chalk.ts`; commands never import chalk at all.

**Alternatives considered**:
- **Import chalk directly in tui.ts** — Works, but scatters the chalk dependency knowledge. If chalk bundling fails (ncc edge case), we'd need to touch multiple files.
- **Vendor chalk's core (~50 lines)** — Fallback plan if chalk v5 ESM-only causes ncc issues, but chalk v5 is pure JS with zero native deps, so ncc should handle it.

**Rationale**: The adapter is ~30 lines. It provides a single choke point for the chalk dependency, handles the `NO_COLOR`/`FORCE_COLOR` pass-through (chalk v5 does this natively), and exports a typed `SeverityColorFn` map that `tui.ts` and `theme.ts` consume. If chalk bundling fails, only this file needs to be replaced with vendored color functions.

### AD3: AI Enhance in packages/core — Not CLI-Only

**Choice**: Place the AI Enhance module in `packages/core/src/enhance/` with three files: `types.ts`, `prompt.ts`, `enhance.ts`.

**Alternatives considered**:
- **CLI-only in `apps/cli/src/lib/enhance.ts`** — Would prevent reuse from the GitHub Action and SaaS server.
- **New package `packages/enhance/`** — Over-engineered for ~350 lines of code. A directory within core is sufficient.

**Rationale**: The enhance module uses the existing `createModel()` factory from `packages/core/src/providers/` and operates on `ReviewFinding[]` (a core type). It has no CLI dependencies. Placing it in core makes it available to all distribution modes. The SaaS server and GitHub Action can call `enhanceFindings()` without importing CLI code. The module is opt-in — it only runs when explicitly enabled, and failures are non-blocking.

### AD4: SARIF Builder in packages/core — Pure Function

**Choice**: Place the SARIF builder in `packages/core/src/sarif/builder.ts` as a pure function `buildSarif(result: ReviewResult, version: string): SarifDocument`.

**Alternatives considered**:
- **CLI-only in `apps/cli/src/ui/sarif.ts`** — The proposal suggested this location. However, SARIF output is useful from the GitHub Action too (for `gh sarif upload` in CI). Moving it to core enables this.
- **Use `sarif` npm package** — Adds a dependency for types only. SARIF v2.1.0 is a stable schema; inline TypeScript interfaces for the subset we use (~40 lines) are cleaner than pulling in a full package.

**Rationale**: The SARIF builder is a pure function that maps `ReviewResult` → SARIF JSON. It has zero side effects, no I/O, and no CLI dependencies. The only input beyond the result is the package version string (for `tool.driver.version`). Placing it in core follows the pattern of `format.ts` (the PR comment formatter already lives in core). SARIF types are defined inline — we only use 6-7 SARIF interfaces, not the full 100+ type schema.

### AD5: Health Command — Split Across CLI Handler + Core Modules

**Choice**: The health command has two layers:
- **CLI handler**: `apps/cli/src/commands/health.ts` (~300 lines) — argument parsing, TUI output, orchestration
- **Core modules**: `packages/core/src/health/` — `score.ts` (~250 lines), `trends.ts` (~200 lines), `recommendations.ts` (~200 lines)

**Alternatives considered**:
- **Everything in one `commands/health.ts`** — Would create a 1,200+ line command file, violating the project's convention of keeping commands focused on orchestration.
- **Everything in core** — Trend storage uses filesystem paths (`~/.config/ghagga/`), which is CLI-specific. The scoring and recommendation logic is distribution-agnostic, but the I/O layer belongs in the CLI.

**Rationale**: The scoring algorithm and recommendation engine are pure functions suitable for core. Trend storage reads/writes a JSON file at a CLI-specific path, so the `trends.ts` module in core provides the logic (parse, prune, compute delta), while the CLI handler provides the file path and handles I/O errors. This keeps core free of filesystem assumptions and lets the handler focus on TUI output formatting. Combined line count: ~950 lines — well under the 1,500 line budget.

### AD6: Output Format Architecture — Strategy via Switch, Not Class Hierarchy

**Choice**: A simple `switch` statement in `review.ts` routes output to the appropriate formatter:

```typescript
switch (outputFormat) {
  case 'json':
    stdout(JSON.stringify(result, null, 2));
    break;
  case 'sarif':
    stdout(JSON.stringify(buildSarif(result, version)));
    break;
  case 'markdown':
    stdout(formatMarkdownResult(result));
    break;
  default:
    /* styled TUI output via tui.* */ break;
}
```

**Alternatives considered**:
- **Strategy pattern with `OutputFormatter` interface** — Over-engineered. We have exactly 3 formats plus the default TUI path. A switch is readable and covers all cases.
- **Plugin-based formatter registry** — Future possibility if we add PDF, HTML, etc. Not needed for 3 formats.

**Rationale**: The switch is 6 lines. Each format is already a pure function (`JSON.stringify`, `buildSarif`, `formatMarkdownResult`). Adding a strategy pattern would add ~50 lines of interface/factory code for zero benefit. If a fourth format is added in the future, it's a one-line addition to the switch.

### AD7: --output Triggers Plain Mode — In preAction Hook

**Choice**: Extend the existing `hook('preAction')` in `index.ts` to include `--output` in the plain mode detection:

```typescript
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  const isPlain = opts.plain || !process.stdout.isTTY || !!process.env.CI || !!opts.output;
  tui.init({ plain: isPlain });
});
```

**Alternatives considered**:
- **Detect in each command** — Would duplicate the logic in review and health commands.
- **Separate `--quiet` flag** — `--output` already implies "machine-readable, no decorations". Adding another flag is redundant.

**Rationale**: The preAction hook already exists (index.ts line 58). Adding `|| !!opts.output` to the existing detection is a single expression change. This ensures that ALL TUI methods (including `intro()`, `outro()`, `spinner()`) are suppressed when `--output` is specified, which is exactly the spec requirement.

### AD8: --issue GitHub API Client — Minimal fetch Wrapper

**Choice**: Create `apps/cli/src/lib/github-api.ts` with 3 functions: `createIssue()`, `createComment()`, `ensureLabel()`. All use `fetch` (Node 20+ built-in) with the stored GitHub token.

**Alternatives considered**:
- **Use `@octokit/rest`** — Adds a significant dependency (~200KB). We need exactly 3 API calls.
- **Use the existing `oauth.ts` patterns** — `oauth.ts` already uses `fetch` for GitHub API calls (device flow). We follow the same pattern.

**Rationale**: The GitHub REST API for issues is 3 endpoints: `POST /repos/{owner}/{repo}/issues`, `POST /repos/{owner}/{repo}/issues/{number}/comments`, and `POST /repos/{owner}/{repo}/labels`. Each is a single `fetch` call with a JSON body. The stored token from `ghagga login` is already available via `getStoredToken()` in `lib/config.ts`. No new dependencies needed.

### AD9: Enhance Pipeline Integration — Post-Static, Pre-Assembly

**Choice**: The enhance module is called in `pipeline.ts` after static analysis produces `ReviewFinding[]` but before the final result is assembled. It's a conditional step controlled by a new `enhance` boolean on `ReviewInput`.

```
Step 4: Static Analysis → findings[]
Step 4.5: AI Enhance (if enabled) → enhanced findings[]
Step 5: Agent mode (AI review)
Step 6: Merge and assemble result
```

**Alternatives considered**:
- **After agent mode (Step 6)** — Would enhance AI findings too, which adds latency and token cost for marginal benefit. Static analysis findings are the primary target.
- **Parallel with agent mode** — Would require splitting the pipeline flow. The enhance module needs the static findings as input, and the agent mode also uses static context. Running them in parallel would mean the agent doesn't see enhanced findings in its context, which is acceptable — but the complexity isn't worth it for a single gpt-4o-mini call (~1-2s latency).

**Rationale**: The enhance step runs after static analysis and before agent execution. This means the agent sees the original findings (not enhanced), which is fine — the agent has its own intelligence. The enhance metadata is merged into the final result during assembly. The conditional check is simple: `if (input.enhance && findings.length > 0)`. If the enhance call fails, the pipeline continues with unenhanced findings.

### AD10: Health Trend Storage — JSON File at Config Dir

**Choice**: Store health history in `~/.config/ghagga/health-history.json`. The file contains an array of entries keyed by project path.

**Alternatives considered**:
- **SQLite (reuse memory.db)** — Over-engineered for a simple append-only log of 10 entries per project.
- **Per-project `.ghagga/health.json`** — Would require write access in the project directory, which may be read-only or git-tracked.
- **No persistence** — Trends are a key feature of the health command.

**Rationale**: The config directory (`~/.config/ghagga/`) already exists (created by `ghagga login`). A JSON file is simple, human-readable, and trivially parseable. The `getConfigDir()` function from `lib/config.ts` provides the path. The file is pruned to 10 entries per project on each write, keeping it small. Corrupt files are silently reset (spec S10.5).

### AD11: chalk v5 ESM Bundling — Direct Import, ncc-Compatible

**Choice**: Add `chalk` (v5) to `apps/cli/package.json` dependencies. Import it as ESM in `ui/chalk.ts`. Verify ncc bundling works.

**Alternatives considered**:
- **chalk v4 (CJS)** — Would work with ncc more reliably, but chalk v5 has been ESM-only since 2022 and is widely bundled without issues. Going with v4 means using a 3-year-old version.
- **Vendor 50 lines of ANSI color functions** — Fallback plan if ncc fails. But chalk v5 is pure JS (no native deps, no WASM), so ncc should handle it.
- **Use picocolors (already in clack)** — picocolors doesn't support RGB colors needed for "orange" (high severity). It only has the basic 16 ANSI colors.

**Rationale**: chalk v5 is ~7KB, pure ESM, zero native dependencies. It auto-detects `NO_COLOR`, `FORCE_COLOR`, and non-TTY. The project is already ESM (`"type": "module"` in package.json), so chalk v5's ESM-only nature is not an issue. If ncc bundling fails during the build verification step, the fallback is to vendor the core color functions inline in `chalk.ts` (~50 lines).

## Data Flow

### Review Pipeline with --output, --enhance, --issue

```
                   ┌─────────────────────────────────────────────┐
                   │  ghagga review . --enhance --issue new      │
                   │           --output sarif                    │
                   └──────────┬──────────────────────────────────┘
                              │
                   ┌──────────▼──────────────────────────────────┐
                   │  index.ts preAction hook                    │
                   │  isPlain = true (--output set)              │
                   │  tui.init({ plain: true })                  │
                   │  --format deprecated? → stderr warning      │
                   └──────────┬──────────────────────────────────┘
                              │
                   ┌──────────▼──────────────────────────────────┐
                   │  review.ts reviewCommand()                  │
                   │                                             │
                   │  1. Get diff, merge settings                │
                   │  2. reviewPipeline(input)                   │
                   └──────────┬──────────────────────────────────┘
                              │
               ┌──────────────▼──────────────────────────────────┐
               │  pipeline.ts (core)                             │
               │                                                 │
               │  Step 1: Validate input                         │
               │  Step 2: Parse diff, filter files               │
               │  Step 3: Detect stacks                          │
               │  Step 4: Run static analysis (parallel)         │
               │                                                 │
               │  ┌─ Step 4.5: AI Enhance (NEW) ──────────────┐ │
               │  │ if (input.enhance && findings.length > 0)  │ │
               │  │   enhanceFindings(findings, provider, key) │ │
               │  │   → groups, priorities, suggestions,       │ │
               │  │     filtered findings                      │ │
               │  │ On failure → warn, continue unenhanced     │ │
               │  └────────────────────────────────────────────┘ │
               │                                                 │
               │  Step 5: Agent mode (AI review)                 │
               │  Step 6: Merge static + agent findings          │
               │  Step 7: Persist memory                         │
               │  → return ReviewResult                          │
               └──────────────┬──────────────────────────────────┘
                              │
               ┌──────────────▼──────────────────────────────────┐
               │  review.ts — Post-pipeline routing              │
               │                                                 │
               │  ┌─ Output Format (switch) ───────────────────┐ │
               │  │ 'sarif'    → buildSarif(result) → stdout   │ │
               │  │ 'json'     → JSON.stringify()   → stdout   │ │
               │  │ 'markdown' → formatMarkdown()   → stdout   │ │
               │  │  default   → tui.* styled output            │ │
               │  └────────────────────────────────────────────┘ │
               │                                                 │
               │  ┌─ Issue Creation (if --issue) ──────────────┐ │
               │  │ Validate token (getStoredToken())          │ │
               │  │ Parse owner/repo from git remote           │ │
               │  │ 'new'  → POST /repos/{o}/{r}/issues        │ │
               │  │ '{num}' → POST /repos/{o}/{r}/issues/N/... │ │
               │  │ Print URL to stderr (stdout is format)     │ │
               │  │ On failure → warn, don't block exit        │ │
               │  └────────────────────────────────────────────┘ │
               └─────────────────────────────────────────────────┘
```

### Health Command Flow

```
  ghagga health [path] [--output json] [--plain]
       │
       ▼
  ┌──────────────────────────────────────────────────┐
  │  commands/health.ts                              │
  │                                                  │
  │  1. Resolve target path (default: '.')           │
  │  2. Initialize tool registry                     │
  │  3. Run static analysis (always-on tools only)   │
  │     ─ semgrep, trivy, gitleaks, shellcheck,      │
  │       lizard                                     │
  │  4. Collect findings                             │
  └────────────────┬─────────────────────────────────┘
                   │
       ┌───────────▼────────────────────────────┐
       │  core/health/score.ts                  │
       │  computeHealthScore(findings)          │
       │  → { score: 0-100, grade, counts }     │
       └───────────┬────────────────────────────┘
                   │
       ┌───────────▼────────────────────────────┐
       │  core/health/recommendations.ts        │
       │  generateRecommendations(findings)     │
       │  → [ { category, action, impact } ]    │
       └───────────┬────────────────────────────┘
                   │
       ┌───────────▼────────────────────────────┐
       │  core/health/trends.ts                 │
       │  loadHistory(configDir, projectPath)   │
       │  computeTrend(current, previous)       │
       │  saveHistory(configDir, entry)          │
       │  → { previous, delta, direction }      │
       └───────────┬────────────────────────────┘
                   │
       ┌───────────▼────────────────────────────┐
       │  commands/health.ts — Render output    │
       │                                        │
       │  --output json → JSON to stdout        │
       │  default → tui.box() score summary     │
       │            tui.severity() top issues   │
       │            tui.divider() sections      │
       │            recommendations list        │
       └────────────────────────────────────────┘
```

### TUI Method Delegation

```
  Command code                 tui.ts facade              Rendering
  ─────────────               ──────────────             ──────────
  tui.severity(text, level) ──→ if _plain:              → "[LEVEL] text"
                                else:                   → chalk.red(text)  (via chalk.ts)

  tui.box(title, lines) ──────→ if _plain:              → "--- title ---\nlines\n---"
                                else:                   → "┌─ title ─┐\n│ line │\n└───┘"

  tui.divider(label?) ────────→ if _plain:              → "--- label ---"
                                else:                   → "──── label ────"

  tui.progress(n, total, msg) → if _plain:              → "[n/total] msg" (console.log)
                                else:                   → spinner.message("[n/total] msg")
```

## File Changes

### New Files

| File                                          | Action     | Description                                                                                                           |
| --------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/ui/chalk.ts`                    | **Create** | Chalk v5 adapter. Imports chalk, re-exports color functions. Exports `colorSeverity(text, level)` helper. ~30 lines.  |
| `apps/cli/src/ui/sarif.ts`                    | **Create** | Re-export of `buildSarif` from core for CLI convenience. ~5 lines. (Actual builder in core.)                          |
| `apps/cli/src/commands/health.ts`             | **Create** | Health command handler. Runs always-on tools, computes score, renders output. ~300 lines.                             |
| `apps/cli/src/lib/github-api.ts`              | **Create** | Minimal GitHub REST API client. `createIssue()`, `createComment()`, `ensureLabel()`. Uses `fetch`. ~150 lines.        |
| `packages/core/src/enhance/types.ts`          | **Create** | `EnhanceResult`, `FindingGroup`, `EnhanceMetadata` types. ~50 lines.                                                  |
| `packages/core/src/enhance/prompt.ts`         | **Create** | AI enhance prompt template for gpt-4o-mini. ~100 lines.                                                               |
| `packages/core/src/enhance/enhance.ts`        | **Create** | `enhanceFindings()` main function. Serializes findings, calls LLM, parses response, merges metadata. ~200 lines.      |
| `packages/core/src/enhance/index.ts`          | **Create** | Barrel export for enhance module. ~5 lines.                                                                           |
| `packages/core/src/health/score.ts`           | **Create** | `computeHealthScore(findings)` — weighted severity scoring. ~250 lines.                                               |
| `packages/core/src/health/trends.ts`          | **Create** | `loadHistory()`, `saveHistory()`, `computeTrend()`, `pruneHistory()`. ~200 lines.                                     |
| `packages/core/src/health/recommendations.ts` | **Create** | `generateRecommendations(findings)` — category-based actionable advice. ~200 lines.                                   |
| `packages/core/src/health/index.ts`           | **Create** | Barrel export for health module. ~5 lines.                                                                            |
| `packages/core/src/sarif/builder.ts`          | **Create** | `buildSarif(result, version)` — pure function mapping ReviewResult to SARIF v2.1.0. ~200 lines.                       |
| `packages/core/src/sarif/types.ts`            | **Create** | Inline SARIF v2.1.0 type subset: `SarifDocument`, `SarifRun`, `SarifResult`, `SarifRule`, `SarifLocation`. ~40 lines. |
| `packages/core/src/sarif/index.ts`            | **Create** | Barrel export for SARIF module. ~5 lines.                                                                             |

### Modified Files

| File                              | Action     | Description                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/cli/src/ui/tui.ts`          | **Modify** | Add 4 new methods: `severity()`, `box()`, `divider()`, `progress()`. Import from `chalk.ts`. ~80 lines added.                                                                                                                                                                                                      |
| `apps/cli/src/ui/theme.ts`        | **Modify** | Add `SEVERITY_COLORS` map (severity → chalk color fn reference), `BOX_CHARS` constant, `DIVIDER_CHAR`. ~25 lines added.                                                                                                                                                                                            |
| `apps/cli/src/ui/format.ts`       | **Modify** | Add `formatBoxSummary()`, `formatSeverityLine()`, `formatDivider()`, `formatHealthScore()`. Update `formatMarkdownResult()` to use dividers between tool groups. ~100 lines added.                                                                                                                                 |
| `apps/cli/src/commands/review.ts` | **Modify** | (1) Add `outputFormat` and `enhance` and `issue` to `ReviewOptions`. (2) Wire step progress via `tui.progress()` in non-verbose mode. (3) Add post-pipeline output format routing (switch). (4) Add post-pipeline issue creation. (5) Call `enhanceFindings()` or pass enhance flag to pipeline. ~120 lines added. |
| `apps/cli/src/index.ts`           | **Modify** | (1) Register `health` command. (2) Add `--output` flag with choices `json                                                                                                                                                                                                                                          | sarif | markdown`. (3) Add `--format`as deprecated alias. (4) Add`--enhance`/`--no-enhance`flags. (5) Add`--issue`flag. (6) Update preAction hook for`--output` plain mode. ~60 lines added. |
| `packages/core/src/types.ts`      | **Modify** | Add optional `enhanced?: boolean`, `enhanceMetadata?: EnhanceMetadata` to `ReviewResult`. Add `enhance?: boolean` to `ReviewInput`. Add `HealthResult` type. ~30 lines added.                                                                                                                                      |
| `packages/core/src/pipeline.ts`   | **Modify** | Add conditional enhance step (Step 4.5) between static analysis and agent mode. ~20 lines added.                                                                                                                                                                                                                   |
| `packages/core/src/index.ts`      | **Modify** | Export new modules: `enhance`, `health`, `sarif`. Export new types: `EnhanceMetadata`, `HealthResult`, `SarifDocument`. ~15 lines added.                                                                                                                                                                           |
| `apps/cli/package.json`           | **Modify** | Add `"chalk": "^5.4.0"` to dependencies.                                                                                                                                                                                                                                                                           |

### Files NOT Changed

- `apps/cli/src/commands/login.ts` — No output changes
- `apps/cli/src/commands/logout.ts` — No output changes
- `apps/cli/src/commands/status.ts` — No output changes
- `apps/cli/src/commands/memory/` — No changes
- `apps/cli/src/commands/hooks/` — No changes
- `apps/cli/src/lib/config.ts` — Used but not modified (getConfigDir, getStoredToken)
- `apps/cli/src/lib/git.ts` — Used but not modified (resolveProjectId, normalizeRemoteUrl)
- `apps/cli/src/lib/oauth.ts` — Not touched
- `packages/core/src/format.ts` — PR comment formatter, not touched (SARIF is a separate concern)
- `packages/core/src/providers/` — Used by enhance module, not modified
- All `*.test.ts` files — Existing tests pass without modification

## Interfaces / Contracts

### `ui/chalk.ts` — Chalk Adapter

```typescript
import chalk from 'chalk';
import type { FindingSeverity } from 'ghagga-core';

/** Re-export chalk for internal use by tui.ts and theme.ts only. */
export { chalk };

/** Map severity level to a chalk color function. */
export const SEVERITY_COLOR_FNS: Record<FindingSeverity, (text: string) => string> = {
  critical: (t) => chalk.red(t),
  high: (t) => chalk.hex('#FFA500')(t), // orange
  medium: (t) => chalk.yellow(t),
  low: (t) => chalk.blue(t),
  info: (t) => chalk.gray(t),
};

/**
 * Apply severity coloring to text.
 * Returns plain text if chalk detects NO_COLOR or non-TTY.
 */
export function colorSeverity(text: string, level: FindingSeverity): string;
```

### `ui/tui.ts` — New Methods (Added to Existing Facade)

```typescript
import type { FindingSeverity } from 'ghagga-core';

/**
 * Return severity-colored text.
 * Styled: ANSI-colored via chalk.
 * Plain: "[LEVEL] text" prefix, no ANSI.
 */
export function severity(text: string, level: FindingSeverity): string;

/**
 * Render a bordered box.
 * Styled: Unicode box-drawing (┌─┐│└─┘) with optional title.
 * Plain: "--- title ---\ncontent\n---"
 */
export function box(title: string, content: string[]): string;

/**
 * Render a section divider.
 * Styled: "──── label ────" using ─ characters.
 * Plain: "--- label ---"
 */
export function divider(label?: string): string;

/**
 * Render a step progress indicator.
 * Format: "[current/total] label"
 * In styled mode, updates the active spinner message.
 * In plain mode, prints to console.log.
 */
export function progress(current: number, total: number, label: string): void;
```

### `packages/core/src/enhance/types.ts` — Enhance Types

```typescript
import type { FindingSeverity } from '../types.js';

export interface EnhanceInput {
  findings: EnhanceFindingSummary[];
  provider: string;
  model: string;
  apiKey: string;
}

/** Compact finding representation for the AI prompt (token-efficient). */
export interface EnhanceFindingSummary {
  id: number;
  file: string;
  line?: number;
  severity: FindingSeverity;
  category: string;
  message: string;
  source: string;
}

export interface EnhanceResult {
  /** Grouped findings by root cause. */
  groups: FindingGroup[];
  /** AI-assigned priority scores (findingId → 1-10). */
  priorities: Record<number, number>;
  /** Fix suggestions for top findings (findingId → suggestion text). */
  suggestions: Record<number, string>;
  /** Findings flagged as likely false positives. */
  filtered: FilteredFinding[];
}

export interface FindingGroup {
  groupId: string;
  label: string;
  findingIds: number[];
}

export interface FilteredFinding {
  findingId: number;
  reason: string;
}

export interface EnhanceMetadata {
  model: string;
  tokenUsage: { input: number; output: number };
  groupCount: number;
  filteredCount: number;
}
```

### `packages/core/src/types.ts` — ReviewResult Extensions

```typescript
// Added to existing ReviewResult interface:
export interface ReviewResult {
  // ... existing fields ...

  /** Whether AI enhance was applied to this result. */
  enhanced?: boolean;

  /** Metadata from the AI enhance pass (present when enhanced === true). */
  enhanceMetadata?: import('./enhance/types.js').EnhanceMetadata;
}

// Added to existing ReviewInput interface:
export interface ReviewInput {
  // ... existing fields ...

  /** Enable AI-powered post-analysis enhancement. Default: false. */
  enhance?: boolean;
}

// Added to existing ReviewFinding interface:
export interface ReviewFinding {
  // ... existing fields ...

  /** AI-assigned group ID (shared by related findings). */
  groupId?: string;

  /** AI-assigned priority score (1-10, where 10 = highest impact). */
  aiPriority?: number;

  /** Whether the AI flagged this as a likely false positive. */
  aiFiltered?: boolean;

  /** Reason for AI filtering (present when aiFiltered === true). */
  filterReason?: string;
}
```

### `packages/core/src/health/score.ts` — Health Scoring

```typescript
import type { ReviewFinding, FindingSeverity } from '../types.js';

export interface HealthScore {
  score: number; // 0-100
  grade: string; // A (80+), B (60-79), C (40-59), D (20-39), F (0-19)
  findingCounts: Record<FindingSeverity, number>;
  totalFindings: number;
}

/** Severity weights for health score computation. */
export const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  critical: -20,
  high: -10,
  medium: -3,
  low: -1,
  info: 0,
};

/**
 * Compute health score from findings.
 * Base score = 100. Each finding subtracts its severity weight.
 * Result clamped to [0, 100].
 */
export function computeHealthScore(findings: ReviewFinding[]): HealthScore;
```

### `packages/core/src/health/trends.ts` — Trend Storage

```typescript
export interface HealthHistoryEntry {
  timestamp: string; // ISO 8601
  score: number;
  findingCounts: Record<string, number>;
  toolsRun: string[];
  projectPath: string;
}

export interface HealthTrend {
  previous: number | null;
  delta: number | null;
  direction: 'up' | 'down' | 'unchanged' | null;
}

/** Load history entries for a project. Returns [] on missing/corrupt file. */
export function loadHistory(configDir: string, projectPath: string): HealthHistoryEntry[];

/** Save a new entry, pruning to max 10 per project. */
export function saveHistory(configDir: string, entry: HealthHistoryEntry): void;

/** Compute trend from current score vs last entry. */
export function computeTrend(currentScore: number, history: HealthHistoryEntry[]): HealthTrend;
```

### `packages/core/src/sarif/types.ts` — SARIF Subset

```typescript
/** Minimal SARIF v2.1.0 types for the subset we produce. */

export interface SarifDocument {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

export interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}

export interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

export interface SarifRule {
  id: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
}

export type SarifLevel = 'error' | 'warning' | 'note' | 'none';

export interface SarifResult {
  ruleId: string;
  message: { text: string };
  level: SarifLevel;
  locations: SarifLocation[];
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
}
```

### `apps/cli/src/lib/github-api.ts` — Issue Client

```typescript
export interface CreateIssueResult {
  url: string;
  number: number;
}

export interface CreateCommentResult {
  url: string;
}

/**
 * Create a new GitHub issue.
 * @throws GitHubApiError on auth failure, rate limit, or issues disabled.
 */
export function createIssue(opts: {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<CreateIssueResult>;

/**
 * Post a comment on an existing GitHub issue.
 * @throws GitHubApiError on auth failure, rate limit, or issue not found.
 */
export function createComment(opts: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<CreateCommentResult>;

/**
 * Ensure a label exists on the repo. Creates it if missing.
 * Silently ignores errors (insufficient permissions).
 */
export function ensureLabel(opts: {
  token: string;
  owner: string;
  repo: string;
  name: string;
  color: string;
  description: string;
}): Promise<void>;

/**
 * Parse owner/repo from a git remote URL.
 * Supports HTTPS and SSH formats.
 * @throws if the remote is not a GitHub URL.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string };
```

### `apps/cli/src/commands/health.ts` — Command Options

```typescript
export interface HealthOptions {
  /** Output format: 'json' or default (styled TUI). */
  output?: 'json';
  /** Plain mode. */
  plain?: boolean;
  /** Number of top issues to show (default: 5). */
  top?: number;
}

export async function healthCommand(targetPath: string, options: HealthOptions): Promise<void>;
```

## Testing Strategy

| Layer           | What to Test                        | Approach                                                                                                                                                               |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**        | `tui.severity()` plain/styled modes | Init in plain → assert `[LEVEL]` prefix, no ANSI. Init in styled → assert ANSI codes present.                                                                          |
| **Unit**        | `tui.box()` plain/styled modes      | Assert `---` delimiters in plain, `┌┐│└┘` in styled. Assert auto-sizing width.                                                                                         |
| **Unit**        | `tui.divider()` plain/styled modes  | Assert `---` in plain, `─` chars in styled.                                                                                                                            |
| **Unit**        | `tui.progress()` output             | Assert `[n/m] label` format in both modes.                                                                                                                             |
| **Unit**        | `computeHealthScore()`              | Zero findings → 100. 10 criticals → 0. Mixed severities → expected weighted result.                                                                                    |
| **Unit**        | `computeTrend()`                    | First run → null trend. Improvement → positive delta. Regression → negative delta.                                                                                     |
| **Unit**        | `generateRecommendations()`         | Findings in multiple categories → sorted by impact. Zero findings → empty.                                                                                             |
| **Unit**        | `loadHistory()` / `saveHistory()`   | Missing file → []. Corrupt file → []. Prune to 10. Multiple projects isolated.                                                                                         |
| **Unit**        | `buildSarif()`                      | Zero findings → valid SARIF with empty results. 5 findings → 5 results. Severity mapping (critical→error, medium→warning, info→note). Missing line number → no region. |
| **Unit**        | `enhanceFindings()`                 | Mock LLM call → assert groups, priorities, suggestions, filtered findings merged. LLM failure → returns unenhanced. Zero findings → skips LLM call.                    |
| **Unit**        | `parseGitHubRemote()`               | HTTPS URL → owner/repo. SSH URL → owner/repo. Non-GitHub URL → throws.                                                                                                 |
| **Unit**        | `createIssue()` / `createComment()` | Mock fetch → assert correct URL, headers, body. 401 → auth error. 429 → rate limit error.                                                                              |
| **Integration** | SARIF schema validation             | Generate SARIF from real ReviewResult, validate against official schema JSON.                                                                                          |
| **Integration** | Health command end-to-end           | Run `healthCommand()` with mocked tools → assert score, trend, recommendations rendered.                                                                               |
| **Integration** | Review with --output json           | Run review command → assert stdout is valid JSON, no ANSI codes.                                                                                                       |
| **Integration** | Review with --enhance (mocked LLM)  | Run pipeline with enhance=true, mock AI response → assert enhanced fields on findings.                                                                                 |
| **Existing**    | All 124+ existing tests             | Must pass without modification. TUI facade auto-selects plain in test runner (no TTY).                                                                                 |

### SARIF Schema Validation

The SARIF builder should be validated against the official schema in tests:

```typescript
import schema from './sarif-schema-2.1.0.json'; // vendored or fetched once
import Ajv from 'ajv';

test('SARIF output validates against official schema', () => {
  const sarif = buildSarif(mockResult, '2.5.0');
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  expect(validate(sarif)).toBe(true);
});
```

Note: `ajv` is a dev dependency for testing only. Alternatively, use a simpler JSON schema validator or validate manually against the key required fields.

## Migration / Rollout

No data migration required. No config file schema changes. No database changes.

### Build Verification Steps

1. **Before starting**: Run `pnpm test` to confirm baseline passes
2. **After each phase**: Run `pnpm test && pnpm typecheck`
3. **After chalk is added**: Run `npx ncc build dist/index.js -o ncc-out` to verify bundling
4. **Bundle size check**: `ls -la ncc-out/index.js` — increase must be < 30KB
5. **After all changes**: Full verification:

   ```bash
   pnpm test                                          # All tests pass
   pnpm typecheck                                     # No type errors
   pnpm build                                         # Compiles
   npx ncc build dist/index.js -o ncc-out             # Bundle succeeds

   # Smoke tests
   CI=true node dist/index.js review . --quick         # Plain mode
   node dist/index.js review . --output json --quick   # JSON, no TUI
   node dist/index.js health                           # Health command
   node dist/index.js health --output json             # Health JSON
   node dist/index.js review . --output sarif --quick  # SARIF output
   ```

### Backward Compatibility

- `--format json` continues to work → prints deprecation warning to stderr, routes to `--output json`
- `--format markdown` continues to work → same deprecation warning
- JSON output schema from `--output json` is identical to existing `--format json` output
- `ReviewResult` additions (`enhanced`, `enhanceMetadata`) are optional fields — existing consumers ignore them
- `ReviewFinding` additions (`groupId`, `aiPriority`, `aiFiltered`, `filterReason`) are optional — existing consumers ignore them

### Rollback Plan

Each feature is independently reversible:
1. **TUI Polish**: Revert `ui/tui.ts`, `ui/chalk.ts`, `ui/theme.ts`, `ui/format.ts` changes. Remove chalk dependency.
2. **--output**: Revert `index.ts` flag changes and review.ts routing. Remove `sarif/` from core.
3. **AI Enhance**: Remove `core/enhance/`. Revert pipeline.ts and types.ts additions.
4. **Health**: Remove `commands/health.ts`. Remove `core/health/`. Revert index.ts registration.
5. **--issue**: Remove `lib/github-api.ts`. Revert review.ts and index.ts changes.

Full rollback: single PR revert. No database, config, or API changes to undo.

## Line Budget Verification

### Health Command (≤1,500 lines target)

| File                                          | Est. Lines |
| --------------------------------------------- | ---------- |
| `apps/cli/src/commands/health.ts`             | ~300       |
| `packages/core/src/health/score.ts`           | ~250       |
| `packages/core/src/health/trends.ts`          | ~200       |
| `packages/core/src/health/recommendations.ts` | ~200       |
| **Total**                                     | **~950**   |

Margin: ~550 lines under budget. Barrel exports (`index.ts`) not counted as they're boilerplate.

### Total New Code Across All Features

| Feature                                                        | Est. Lines |
| -------------------------------------------------------------- | ---------- |
| TUI methods (chalk.ts + tui.ts additions + theme.ts additions) | ~135       |
| Output formats (sarif builder + types + format.ts additions)   | ~340       |
| AI Enhance (enhance.ts + prompt.ts + types.ts)                 | ~350       |
| Health (command + core modules)                                | ~950       |
| Issue (github-api.ts + review.ts additions)                    | ~270       |
| Wiring (index.ts changes, review.ts routing)                   | ~180       |
| **Total new code**                                             | **~2,225** |

## Open Questions

- [x] **chalk v5 + ncc bundling** — Should be verified early in Phase 1. If it fails, vendor the color functions (~50 lines). **Decision: proceed with chalk v5, verify in build step, vendor as fallback.**

- [ ] **SARIF schema validation in CI** — Should we add `ajv` as a dev dependency for SARIF schema validation tests, or keep validation manual? Recommendation: add `ajv` as devDependency in core — it's only used in tests and doesn't affect the bundle.

- [ ] **Health command SARIF output** — The spec mentions `ghagga health --output sarif` as an edge case. Should health support SARIF output? Recommendation: defer to a future release. Health findings are the same `ReviewFinding[]` type, so SARIF support is trivially addable later. For v2.5.0, health supports `--output json` only.

- [ ] **`--enhance` with `--output sarif`** — SARIF schema has no fields for `groupId` or `aiPriority`. Enhanced metadata should be silently dropped from SARIF output. The SARIF builder ignores these optional fields naturally (it only maps the standard SARIF fields). **Decision: SARIF output is always schema-compliant regardless of enhance state.**

- [ ] **Spinner interaction with `tui.progress()`** — In non-verbose styled mode, `progress()` should update the spinner message. This requires the spinner instance to be accessible from the TUI module. Options: (a) store the spinner as module-level state in tui.ts, (b) pass the spinner to progress(). **Recommendation: (a) — add `setActiveSpinner(s: TuiSpinner)` to tui.ts so review.ts can register its spinner, and progress() updates it. This avoids threading the spinner through every call.**
