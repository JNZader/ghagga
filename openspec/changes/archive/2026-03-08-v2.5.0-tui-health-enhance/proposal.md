# Proposal: GHAGGA v2.5.0 — TUI Polish, Health Command, AI Enhance, Issue Export, Output Formats

## Intent

GHAGGA's CLI is functional but utilitarian. Review output is a flat wall of markdown text with no visual hierarchy, no severity coloring, and no structured summary. Static analysis findings are mixed inline with no tool-level separation. Users in CI pipelines cannot consume results programmatically (only `--format json` exists; no SARIF for GitHub Security tab, no machine-readable markdown). There is no way to create GitHub issues from review results, no "quick health check" workflow for local iteration, and no AI-powered post-processing to group, prioritize, and reduce noise in findings.

v2.5.0 addresses all five gaps in a single release:
1. **TUI Polish** — Colored severity output, box-drawing summary, step progress indicators, section dividers between tools. All behind the existing TUI facade pattern (`ui/tui.ts`).
2. **`ghagga health`** — A lightweight command that runs a subset of static analysis tools locally and produces a health score with top issues, trends, and actionable recommendations. Capped at 1,500 lines.
3. **AI Enhance** — Post-static-analysis pass using gpt-4o-mini to group related findings, prioritize by impact, generate fix suggestions, and filter false positives.
4. **`--issue` flag** — `ghagga review --issue 42` creates/updates a GitHub issue with the formatted review results via the GitHub API.
5. **`--output` flag** — Replaces the existing `--format` with `--output json|sarif|markdown`. When `--output` is used, TUI decorations are suppressed (plain mode). SARIF enables GitHub Security tab integration.

The goal is to make `ghagga` feel like a polished, professional tool both in interactive terminals and in CI pipelines, while keeping everything free and maintaining the existing TUI facade contract.

## Scope

### In Scope

#### TUI Polish (CLI presentation layer)

- **Colored severity output** using `chalk` — critical=red, high=orange, medium=yellow, low=green, info=purple. Colors respect `NO_COLOR`, non-TTY, and `--plain` detection.
- **Box-drawing summary** at end of review — bordered box showing status, finding counts by severity, execution time, tools run.
- **Step progress indicators** `[1/7] Running Semgrep...` `[2/7] Running Trivy...` — replacing the current generic spinner message during review.
- **Section dividers** between tool results — visual separator lines with tool name/icon between finding groups.
- **Extend `ui/tui.ts` facade** with new methods: `tui.box()`, `tui.divider()`, `tui.severity()`, `tui.progress()`. Commands never import `chalk` directly.
- **`ui/chalk.ts` adapter** — thin wrapper that re-exports chalk functions and handles NO_COLOR/non-TTY fallback, so tui.ts delegates color logic there.

#### `ghagga health` Command

- New command: `ghagga health [path]` — quick project health check.
- Runs a **subset** of static analysis tools locally (always-on tools from the registry: Semgrep, Trivy, Gitleaks, ShellCheck, Lizard at minimum).
- Produces a **health score** (0-100) computed from weighted severity counts.
- Shows **top N issues** (configurable, default 5) sorted by severity.
- Shows **trends** if previous health runs exist (stored in a local `.ghagga-health.json` in the config directory).
- Shows **actionable recommendations** — top 3 areas to improve, derived from finding categories.
- Supports `--output json` for CI consumption.
- **Must stay under 1,500 lines** of implementation (command handler + health scoring logic + trend storage).
- Respects `--plain` and CI detection.

#### AI Enhance (Post-Analysis Intelligence)

- New module in `packages/core/src/enhance/` — runs **after** static analysis, **before** final result assembly.
- Uses **gpt-4o-mini** (the CLI/Action model — free via GitHub Models) to:
  - **Group** related findings across tools (e.g., a Semgrep finding and a Trivy finding about the same dependency).
  - **Prioritize** by estimated real-world impact (not just severity label).
  - **Generate fix suggestions** for top findings (concrete code snippets where possible).
  - **Filter false positives** — mark low-confidence findings as `filtered` with reasoning.
- Controlled by `--enhance` flag (opt-in) and `--no-enhance` (opt-out). Default: **off** in v2.5.0 (opt-in while stabilizing).
- Adds `enhanced` boolean and `enhanceMetadata` to `ReviewResult` (backward-compatible additions).
- Token budget: single gpt-4o-mini call with findings summary, capped at 4K input tokens. Findings above the cap are truncated by severity (lowest dropped first).
- Graceful degradation: if the AI enhance call fails, the result is returned unenhanced with a warning. No review failure.

#### `--issue` Flag (GitHub Issue Creation)

- `ghagga review --issue 42` — creates or updates GitHub issue #42 with formatted review results.
- `ghagga review --issue new` — creates a new issue, prints the issue URL.
- Uses the **GitHub REST API** via `fetch` (no new dependency — the token is already available from `ghagga login`).
- Issue body is the same markdown output from `formatMarkdownResult()`, wrapped in a collapsible `<details>` section with summary stats.
- Issue title: `GHAGGA Review: {repo}@{short-sha} — {status}`.
- Labels: `ghagga-review` (created if missing).
- Requires authentication (uses stored GitHub token from `ghagga login`).
- Errors clearly when no token is available or the repo doesn't have issues enabled.

#### `--output` Flag (Structured Output Formats)

- Replaces the existing `--format` flag (which only supports `markdown|json`).
- `--format` becomes a deprecated alias for `--output` (backward compat).
- New values: `json`, `sarif`, `markdown` (default for TTY).
- **When `--output` is specified**, TUI decorations are suppressed — equivalent to `--plain` being set. Raw format goes to stdout.
- **SARIF output** (`--output sarif`): generates SARIF v2.1.0 JSON for GitHub Security tab / Code Scanning. Maps findings to SARIF `result` objects with `ruleId`, `message`, `physicalLocation`, `level`.
- **JSON output** (`--output json`): same as current `--format json` behavior.
- **Markdown output** (`--output markdown`): the formatted markdown string (current default behavior).
- New file: `ui/sarif.ts` — SARIF document builder (pure function, no dependencies beyond types).

### Explicitly Out of Scope

- **REPL mode** — no interactive prompt loop
- **Local web UI** — no browser-based dashboard for CLI
- **ASCII logo / brand art** — no splash screen graphics
- **Model selector UI** — no interactive model picker
- **Metrics timeseries** — no historical performance graphs
- **PDF generation** — no PDF export format
- **Paid APIs** — everything uses gpt-4o-mini (free via GitHub Models) or local tools
- **New static analysis tools** — this change uses the existing registry from the extensible-static-analysis change
- **Dashboard/server changes** — this is CLI-only (and Action where applicable)
- **GitHub Action specific UI** — Action uses its own PR comment flow, unchanged

## Approach

### Architecture Overview

All five features touch the CLI (`apps/cli/`) and the core package (`packages/core/`). The architectural strategy is:
1. **TUI facade remains the single output abstraction** — new methods added to `ui/tui.ts`, commands never import `chalk` or `@clack/prompts` directly.
2. **Core stays distribution-agnostic** — the AI Enhance module and SARIF builder live in `packages/core/` so they're usable from CLI, Action, and SaaS.
3. **New command (`health`) follows existing command patterns** — handler in `commands/health.ts`, registered in `index.ts`, uses `tui.*` for output.
4. **`--output` triggers plain mode** — when a structured output format is requested, `tui.init()` forces plain mode, and only the raw format is written to stdout.

### TUI Polish: Implementation Strategy

```
apps/cli/src/ui/chalk.ts    ← New: chalk wrapper with NO_COLOR/TTY awareness
apps/cli/src/ui/tui.ts      ← Extended: box(), divider(), severity(), progress()
apps/cli/src/ui/format.ts   ← Extended: formatBoxSummary(), formatDivider()
apps/cli/src/ui/theme.ts    ← Extended: SEVERITY_COLORS map
```

**chalk dependency**: chalk v5 is ESM-only, pure JS, ~7KB. It auto-detects `NO_COLOR`, `FORCE_COLOR`, and non-TTY. The `ui/chalk.ts` adapter re-exports chalk functions so commands never import chalk directly.

**New TUI methods**:
- `tui.box(lines: string[])` — bordered box using Unicode box-drawing characters (`┌─┐│└─┘`). Falls back to `---` in plain mode.
- `tui.divider(label?: string)` — horizontal rule with optional centered label. Falls back to `---` in plain mode.
- `tui.severity(text: string, level: FindingSeverity)` — returns severity-colored text. Falls back to plain text with `[LEVEL]` prefix.
- `tui.progress(current: number, total: number, message: string)` — `[3/7] Running Semgrep...`. Falls back to plain text in plain mode.

**Step progress**: The review pipeline's `onProgress` callback already exists. The progress handler in `review.ts` (`createProgressHandler`) will use `tui.progress()` to show numbered steps. Step count is known: the tool registry provides the active tool count, plus fixed steps (validate, parse-diff, detect-stacks, agent, memory).

### `ghagga health`: Implementation Strategy

```
apps/cli/src/commands/health.ts       ← Command handler + scoring (~400 lines)
packages/core/src/health/             ← Health scoring logic (~500 lines)
  score.ts                            ← Score computation from findings
  trends.ts                           ← Local trend storage (JSON file)
  recommendations.ts                  ← Recommendation derivation
```

**Scoring algorithm**:
- Each finding contributes negative points weighted by severity: critical=-20, high=-10, medium=-3, low=-1, info=0.
- Base score = 100. Score = max(0, 100 + sum(weights)).
- Score clamped to 0-100. Displayed with color coding: green (80-100), yellow (50-79), red (0-49).

**Trend storage**:
- Previous health runs stored in `~/.config/ghagga/health-history.json`.
- Each entry: `{ timestamp, score, findingCounts, toolsRun }`.
- Last 10 runs kept. Trend = current score vs. previous score (with delta and arrow).

**Line budget**: Command handler ~300 lines, scoring ~400 lines, trends ~200 lines, recommendations ~300 lines. Total ~1,200 lines with comfortable margin under 1,500.

### AI Enhance: Implementation Strategy

```
packages/core/src/enhance/
  enhance.ts         ← Main enhance function (~200 lines)
  prompt.ts          ← AI enhance prompt template (~100 lines)
  types.ts           ← EnhanceResult, GroupedFinding types (~50 lines)
```

**Flow**:
1. After static analysis produces `ReviewFinding[]`, the enhance module is called (if `--enhance` is set).
2. Findings are serialized into a compact JSON summary (file, severity, category, message — no suggestions yet).
3. A single gpt-4o-mini call with a structured prompt:
   - "You are a code review assistant. Given these static analysis findings, group related ones, prioritize by real-world impact, suggest fixes, and identify likely false positives."
   - Output: JSON with `groups`, `prioritized`, `suggestions`, `filtered`.
4. The pipeline merges the AI enhance output: grouped findings get a `groupId`, prioritized findings get an `aiPriority`, filtered findings get `aiFiltered: true`.
5. The result renderer shows grouped findings together, with AI-suggested fixes inline.

**Model**: Uses the same provider/model from the review input. For CLI, this is gpt-4o-mini (free via GitHub Models). No additional cost.

**Token budget**: Input capped at 4K tokens (~200 findings summary). Output capped at 2K tokens. Total cost per enhance: ~6K tokens of gpt-4o-mini = effectively free.

### `--issue` Flag: Implementation Strategy

```
apps/cli/src/lib/github-api.ts    ← GitHub REST API client (~150 lines)
apps/cli/src/commands/review.ts   ← Extended: --issue handling after review
```

**Flow**:
1. After the review completes and the result is formatted, if `--issue` is set:
2. Validate that a GitHub token is available (from `ghagga login`).
3. Resolve the repo's owner/name from git remote URL.
4. If `--issue new`: POST `/repos/{owner}/{repo}/issues` with formatted body.
5. If `--issue {number}`: POST `/repos/{owner}/{repo}/issues/{number}/comments` with formatted body.
6. Print the issue/comment URL.

**No new dependency**: Uses `fetch` (Node 20+ built-in) with the stored GitHub token as Bearer auth.

### `--output` Flag: Implementation Strategy

```
apps/cli/src/ui/sarif.ts          ← SARIF v2.1.0 builder (~200 lines)
apps/cli/src/commands/review.ts   ← Extended: --output routing
apps/cli/src/index.ts             ← Extended: --output flag, --format deprecated
```

**SARIF builder**: Pure function `buildSarif(result: ReviewResult): object` that maps:
- Each unique `(source, category)` pair → SARIF `reportingDescriptor` (rule)
- Each finding → SARIF `result` with `ruleId`, `message`, `level` (error/warning/note), `physicalLocation`
- `run.tool.driver` = `{ name: "ghagga", version: pkg.version }`
- Output: JSON string conforming to SARIF v2.1.0 schema

**Plain mode trigger**: In `index.ts`, the `preAction` hook detects `--output` and forces plain mode:
```typescript
const opts = thisCommand.optsWithGlobals();
const isPlain = opts.plain || !process.stdout.isTTY || !!process.env.CI || !!opts.output;
tui.init({ plain: isPlain });
```

## Affected Areas

| Area                                    | Impact   | Description                                                                                 |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `apps/cli/src/ui/tui.ts`                | Modified | Add `box()`, `divider()`, `severity()`, `progress()` methods                                |
| `apps/cli/src/ui/chalk.ts` (new)        | New      | Chalk wrapper with NO_COLOR/TTY-aware color functions                                       |
| `apps/cli/src/ui/theme.ts`              | Modified | Add `SEVERITY_COLORS` map, box-drawing constants                                            |
| `apps/cli/src/ui/format.ts`             | Modified | Add `formatBoxSummary()`, `formatSeverityLine()`, `formatDivider()`                         |
| `apps/cli/src/ui/sarif.ts` (new)        | New      | SARIF v2.1.0 document builder                                                               |
| `apps/cli/src/commands/review.ts`       | Modified | Wire `--output`, `--issue`, `--enhance`, step progress, box summary                         |
| `apps/cli/src/commands/health.ts` (new) | New      | Health command handler                                                                      |
| `apps/cli/src/index.ts`                 | Modified | Register `health` command, add `--output`/`--issue`/`--enhance` flags, deprecate `--format` |
| `apps/cli/src/lib/github-api.ts` (new)  | New      | GitHub REST API client for issue creation                                                   |
| `packages/core/src/enhance/` (new)      | New      | AI enhance module (enhance.ts, prompt.ts, types.ts)                                         |
| `packages/core/src/health/` (new)       | New      | Health scoring (score.ts, trends.ts, recommendations.ts)                                    |
| `packages/core/src/types.ts`            | Modified | Add `EnhanceMetadata` to `ReviewResult`, `HealthResult` type                                |
| `packages/core/src/pipeline.ts`         | Modified | Call enhance module after static analysis (when enabled)                                    |
| `packages/core/src/index.ts`            | Modified | Export new types and modules                                                                |
| `apps/cli/package.json`                 | Modified | Add `chalk` dependency                                                                      |
| Existing tests                          | None     | All existing tests must pass without modification                                           |
| ncc bundle                              | Modified | Bundle includes chalk (~7KB increase)                                                       |

### Distribution Mode Impact

| Mode               | Impact                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI**            | Primary target. All 5 features land here.                                                                                                                                                                           |
| **GitHub Action**  | AI Enhance and SARIF builder are usable from Action (via `packages/core`). TUI polish and health command are CLI-only. `--output sarif` could be used in Action for uploading to GitHub Security tab (future work). |
| **SaaS (server)**  | No changes. Server uses its own PR comment formatting. AI Enhance could be integrated into the SaaS pipeline in a future release.                                                                                   |
| **1-click deploy** | No changes. Runner template unchanged.                                                                                                                                                                              |

## Risks

| Risk                                              | Likelihood | Mitigation                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **chalk bundling with ncc**                       | Low        | chalk v5 is pure ESM with zero native deps. Pre-validate with `ncc build` before merging. If it fails, vendor chalk's core color functions (~50 lines) directly.                                                                     |
| **AI Enhance hallucinated groupings**             | Medium     | AI Enhance is opt-in (`--enhance`). Output is advisory — it adds metadata to findings but never removes findings from the result. Filtered findings are marked, not deleted, and visible with `--verbose`.                           |
| **AI Enhance token cost explosion**               | Low        | Input capped at 4K tokens. Uses gpt-4o-mini (cheapest available, free via GitHub Models). Single call per review. If findings exceed cap, lowest-severity findings are dropped from the AI input (still shown in results).           |
| **SARIF schema non-compliance**                   | Medium     | Validate generated SARIF against the official JSON schema (https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json) in tests. GitHub's Code Scanning is strict about schema compliance. |
| **Health score gaming / meaninglessness**         | Low        | Score is a simple weighted formula — transparent and documented. Not intended as a definitive quality metric; it's a directional indicator. The scoring weights are configurable in `.ghagga.json` (future enhancement).             |
| **`--issue` rate limiting**                       | Low        | GitHub API rate limit is 5,000 req/hr for authenticated users. A single issue creation is 1-2 requests. Warn the user if the API returns 403/429.                                                                                    |
| **`--issue` without authentication**              | Low        | Check for stored token before attempting API call. Clear error message with `ghagga login` suggestion.                                                                                                                               |
| **`--output` breaking existing `--format` users** | Medium     | `--format` remains as a deprecated alias. Both flags map to the same internal option. Deprecation warning printed when `--format` is used. JSON output format is byte-identical to current behavior.                                 |
| **Box-drawing characters on Windows terminals**   | Low        | Unicode box-drawing (U+2500 block) is supported by all modern Windows terminals (Terminal, PowerShell 7, CMD with chcp 65001). Fallback to ASCII `+--+` in plain mode.                                                               |
| **Health command exceeding 1,500 line cap**       | Low        | Architecture is pre-planned: command ~300, scoring ~400, trends ~200, recommendations ~300 = ~1,200 lines. If trending toward cap, move recommendation logic to `packages/core`.                                                     |

## Rollback Plan

1. **TUI Polish**: Revert the `ui/` changes and command formatting updates. All output reverts to pre-v2.5.0 style. No data migrations, no API changes.
2. **Health command**: Remove `commands/health.ts` and the `health` registration in `index.ts`. No other files depend on it. Health history file (`health-history.json`) is inert and can be left in place.
3. **AI Enhance**: Remove `packages/core/src/enhance/`. The pipeline has a conditional check (`if enhance enabled`) — removing the module disables the feature. `ReviewResult` type additions are additive (new optional fields) — old consumers ignore them.
4. **`--issue` flag**: Remove `--issue` option from `index.ts` and the GitHub API client. No other features depend on it.
5. **`--output` flag**: Revert to `--format`. The SARIF builder (`ui/sarif.ts`) is standalone and can be removed without affecting anything.
6. **Full rollback**: All changes are in `apps/cli/` and `packages/core/` — no database migrations, no server changes, no config schema changes. Single PR revert.

## Dependencies

### New Dependencies

- **`chalk`** (npm, MIT, ~7KB) — terminal color support. Auto-detects NO_COLOR, FORCE_COLOR, non-TTY. ESM-only, pure JS, zero native deps.

### Existing Dependencies (no changes)

- **`@clack/prompts`** — spinners, intro/outro (already installed)
- **`commander`** — CLI argument parsing (already installed)
- **`ghagga-core`** — review pipeline, tool registry, types (workspace dependency)

### No New Dependencies For

- **GitHub API** — uses `fetch` (Node 20+ built-in)
- **SARIF builder** — pure TypeScript, no external library
- **AI Enhance** — uses existing `packages/core/src/providers/` LLM infrastructure (Vercel AI SDK already installed in core)

## Implementation Phases

The recommended implementation order, based on dependency analysis:

### Phase 1: TUI Foundation

1. Add `chalk` dependency, create `ui/chalk.ts` adapter
2. Extend `tui.ts` with `box()`, `divider()`, `severity()`, `progress()`
3. Extend `theme.ts` with `SEVERITY_COLORS`
4. Update `format.ts` with `formatBoxSummary()`, `formatSeverityLine()`
5. Wire colored severity into finding rendering

### Phase 2: `--output` Flag

1. Add `--output json|sarif|markdown` to `index.ts`, deprecate `--format`
2. Implement SARIF builder (`ui/sarif.ts`)
3. Update `review.ts` to route output through format selector
4. Force plain mode when `--output` is specified

### Phase 3: TUI Polish (Review Output)

1. Wire step progress `[3/7]` into review pipeline via `onProgress`
2. Add section dividers between tool finding groups
3. Add box-drawing summary at end of review
4. Test: TTY output, plain output, piped output, CI output

### Phase 4: AI Enhance

1. Create `packages/core/src/enhance/` module (types, prompt, enhance function)
2. Integrate into pipeline (conditional, after static analysis)
3. Add `--enhance` / `--no-enhance` flags
4. Update result rendering to show grouped/prioritized/filtered findings

### Phase 5: `ghagga health`

1. Create `packages/core/src/health/` (scoring, trends, recommendations)
2. Create `commands/health.ts`
3. Register in `index.ts`
4. Implement health history storage and trend display

### Phase 6: `--issue` Flag

1. Create `lib/github-api.ts` (minimal REST client)
2. Add `--issue` flag to review command
3. Wire issue creation/update after review completion
4. Handle auth errors, rate limits, missing repos

## Success Criteria

### TUI Polish

- [ ] Findings display colored severity text in TTY mode (red/orange/yellow/green/purple)
- [ ] Review ends with a box-drawing summary showing status, counts, time, tools
- [ ] Review shows step progress `[1/7] Running Semgrep...` during pipeline
- [ ] Section dividers with tool name appear between finding groups
- [ ] `CI=true ghagga review .` produces clean output with zero ANSI escape codes
- [ ] `ghagga review . --plain` produces plain text with no colors or box drawing
- [ ] `ghagga review . | cat` detects non-TTY and suppresses decorations
- [ ] `NO_COLOR=1 ghagga review .` suppresses all color output
- [ ] Commands never import `chalk` or `@clack/prompts` directly (only via `ui/tui.ts` and `ui/chalk.ts`)

### `--output` Flag

- [ ] `ghagga review --output json` produces identical output to current `--format json`
- [ ] `ghagga review --output sarif` produces valid SARIF v2.1.0 JSON
- [ ] `ghagga review --output markdown` produces clean markdown (no ANSI)
- [ ] When `--output` is specified, zero TUI decorations appear (no spinners, no intro/outro, no colors)
- [ ] `--format` still works but prints a deprecation warning
- [ ] SARIF output passes validation against the official SARIF JSON schema
- [ ] SARIF output is uploadable to GitHub Code Scanning via `gh sarif upload`

### AI Enhance

- [ ] `ghagga review --enhance` triggers the AI enhance pass after static analysis
- [ ] Enhanced results show grouped findings with group labels
- [ ] Enhanced results show AI-prioritized ordering
- [ ] Enhanced results include fix suggestions for top findings
- [ ] Filtered (likely false positive) findings are marked but not removed
- [ ] AI Enhance failure does not block the review — result is returned unenhanced with a warning
- [ ] Token usage for enhance call is < 6K tokens
- [ ] `--no-enhance` explicitly disables even if a future default changes

### `ghagga health`

- [ ] `ghagga health` runs static analysis and shows a health score (0-100)
- [ ] Health score is color-coded: green (80+), yellow (50-79), red (0-49)
- [ ] Top 5 issues are shown sorted by severity
- [ ] Trend arrow shown when previous runs exist (improvement/regression)
- [ ] Actionable recommendations (top 3) are displayed
- [ ] `ghagga health --output json` produces structured JSON
- [ ] `ghagga health --plain` produces clean output
- [ ] Implementation is under 1,500 lines total
- [ ] Health command does not require authentication (runs locally)

### `--issue` Flag

- [ ] `ghagga review --issue new` creates a new GitHub issue and prints the URL
- [ ] `ghagga review --issue 42` posts a comment on issue #42 and prints the comment URL
- [ ] Issue body contains the review summary in formatted markdown
- [ ] Issue is labeled with `ghagga-review`
- [ ] Clear error when no GitHub token is available
- [ ] Clear error when repo has issues disabled or doesn't exist
- [ ] Works with both `owner/repo` from git remote and explicit repo paths

### Cross-Cutting

- [ ] All existing tests pass without modification
- [ ] `ncc build` succeeds and produces a single-file bundle
- [ ] Bundle size increase is < 30KB over v2.4.2 baseline
- [ ] `isPlain = opts.plain || !process.stdout.isTTY || !!process.env.CI` remains the canonical detection pattern
- [ ] No paid API calls — everything uses gpt-4o-mini (free) or local tools
- [ ] `--help` documents all new flags and the `health` command
