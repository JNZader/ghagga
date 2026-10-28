# Tasks: v2.5.0 — TUI Polish, Output Formats, AI Enhance, Health Command, Issue Export

## Phase 1: TUI Foundation — Chalk Adapter, TUI Extensions, Theme

- [x] 1.1 Add `chalk` dependency and create `ui/chalk.ts` adapter (~30 lines new)
  - Add `"chalk": "^5.4.0"` to `apps/cli/package.json` dependencies
  - Run `pnpm install`
  - Create `apps/cli/src/ui/chalk.ts`:
    - Import `chalk` from `chalk`
    - Re-export `chalk` for internal use by `tui.ts` and `theme.ts` only
    - Export `SEVERITY_COLOR_FNS: Record<FindingSeverity, (text: string) => string>` mapping: critical→red, high→hex('#FFA500') (orange), medium→yellow, low→blue, info→gray
    - Export `colorSeverity(text: string, level: FindingSeverity): string` — applies the correct color fn, returns plain text for unknown levels
    - Import `FindingSeverity` from `ghagga-core`
  - **Files**: `apps/cli/package.json`, `apps/cli/src/ui/chalk.ts` (new)
  - **Verify**: `pnpm install` succeeds; `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 1.2 Extend `ui/theme.ts` with severity colors and box-drawing constants (~25 lines added)
  - Add `SEVERITY_COLORS` map: `Record<FindingSeverity, string>` mapping severity to human label+color name (used for plain-mode prefix and documentation)
  - Add `BOX_CHARS` constant: `{ topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘', horizontal: '─', vertical: '│' }`
  - Add `DIVIDER_CHAR` constant: `'─'`
  - Add `SCORE_COLORS` map: `{ good: 80, warning: 50 }` (thresholds for green/yellow/red health scores)
  - **Files**: `apps/cli/src/ui/theme.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 1.3 Extend `ui/tui.ts` with `severity()`, `box()`, `divider()`, `progress()` methods (~80 lines added)
  - Import `colorSeverity` from `./chalk.js`
  - Import `BOX_CHARS`, `DIVIDER_CHAR` from `./theme.js`
  - Import type `FindingSeverity` from `ghagga-core`
  - Add module-level `let _activeSpinner: TuiSpinner | null = null;`
  - Add `setActiveSpinner(s: TuiSpinner | null): void` export (so review.ts can register its spinner for progress updates)
  - Implement `severity(text: string, level: FindingSeverity): string`:
    - Styled: delegate to `colorSeverity(text, level)` from chalk adapter
    - Plain: return `[${level.toUpperCase()}] ${text}` (empty text → empty string)
  - Implement `box(title: string, content: string[]): string`:
    - Styled: Unicode box-drawing (`┌─ title ─┐`, `│ line │`, `└───┘`), auto-size width to longest line (min 40 chars)
    - Plain: `--- title ---\ncontent lines\n---`
  - Implement `divider(label?: string): string`:
    - Styled: `──── label ────` using `─` chars (60 char width), centered label
    - Plain: `--- label ---` or `---` if no label
  - Implement `progress(current: number, total: number, label: string): void`:
    - Styled: if `_activeSpinner` is set, call `_activeSpinner.message(\`[${current}/${total}] ${label}\`)`; else `console.log`
    - Plain: `console.log(\`[${current}/${total}] ${label}\`)`
  - **Files**: `apps/cli/src/ui/tui.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 1.4 Extend `ui/format.ts` with `formatBoxSummary()`, `formatSeverityLine()`, `formatDivider()` (~60 lines added)
  - Add `formatBoxSummary(result: ReviewResult): string[]` — produces an array of lines for the summary box: status, finding counts by severity, execution time, tools run
  - Add `formatSeverityLine(finding: ReviewFinding): string` — formats a single finding with severity emoji and message (used by both review and health)
  - Add `formatDivider(label: string): string` — produces a labeled divider line (calls through to tui-agnostic logic, so format.ts stays pure)
  - Add `formatHealthScore(score: number, grade: string): string[]` — produces lines for the health score display
  - **Files**: `apps/cli/src/ui/format.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 1.5 Unit tests for TUI foundation (~120 lines new)
  - Create `apps/cli/src/ui/__tests__/tui-extensions.test.ts`
  - Tests (vitest):
    - `tui.severity()` in plain mode → returns `[CRITICAL] text`, no ANSI codes
    - `tui.severity()` in styled mode → returns string containing ANSI escape codes
    - `tui.severity()` with unknown level → returns text unchanged (no error)
    - `tui.severity()` with empty string → returns empty string
    - `tui.box()` in plain mode → uses `---` delimiters, no box-drawing chars
    - `tui.box()` in styled mode → uses `┌`, `┐`, `│`, `└`, `┘` chars
    - `tui.box()` with empty content → no error, renders top+bottom only
    - `tui.divider()` with label in plain → `--- label ---`
    - `tui.divider()` without label in plain → `---`
    - `tui.divider()` in styled → uses `─` chars
    - `tui.progress()` in plain mode → console.log with `[n/m] label`
    - All 5 severity levels produce distinct output in styled mode
  - Test `colorSeverity()` from chalk adapter (each level maps to different ANSI code)
  - **Files**: `apps/cli/src/ui/__tests__/tui-extensions.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-cli test` passes
  - **Post**: `pnpm lint:fix`

## Phase 2: Output Formats — --output Flag, SARIF Builder, Format Routing

- [x] 2.1 Create SARIF type definitions in `packages/core/src/sarif/types.ts` (~40 lines new)
  - Create directory `packages/core/src/sarif/`
  - Create `types.ts` with inline SARIF v2.1.0 type subset: `SarifDocument`, `SarifRun`, `SarifDriver`, `SarifRule`, `SarifResult`, `SarifLocation`, `SarifLevel`
  - Exactly as specified in design.md interfaces section
  - **Files**: `packages/core/src/sarif/types.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 2.2 Create SARIF builder in `packages/core/src/sarif/builder.ts` (~200 lines new)
  - Create `buildSarif(result: ReviewResult, version: string): SarifDocument` — pure function:
    - `$.version` = `"2.1.0"`, `$.schema` = official SARIF schema URI
    - `$.runs[0].tool.driver` = `{ name: "ghagga", version, informationUri: "https://ghagga.dev" }`
    - Map each unique `(source, ruleId/category)` pair → `SarifRule` in `tool.driver.rules[]`
    - Map each finding → `SarifResult`:
      - `ruleId` = `${source}/${category}` (slugified)
      - `message.text` = finding message
      - `level` mapping: critical/high → `"error"`, medium → `"warning"`, low/info → `"note"`
      - `locations[0].physicalLocation.artifactLocation.uri` = relative file path
      - `locations[0].physicalLocation.region.startLine` = line number (omit region if no line) - Handle zero findings → empty `results[]`, valid document
  - Create barrel export `packages/core/src/sarif/index.ts`
  - **Files**: `packages/core/src/sarif/builder.ts` (new), `packages/core/src/sarif/index.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 2.3 Export SARIF module from `packages/core/src/index.ts` (~5 lines added)
  - Add `export { buildSarif } from './sarif/index.js';`
  - Add `export type { SarifDocument, SarifLevel, SarifResult, SarifRule } from './sarif/types.js';`
  - **Files**: `packages/core/src/index.ts`
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 2.4 Add `--output` flag, deprecate `--format`, wire plain mode in `index.ts` (~40 lines modified)
  - Replace `.option('-f, --format <format>', 'Output format', 'markdown')` with:
    - `.option('-o, --output <format>', 'Output format: json | sarif | markdown')` with `choices(['json', 'sarif', 'markdown'])`
    - `.option('-f, --format <format>', '(deprecated) Use --output instead')`
  - Update `preAction` hook: `const isPlain = opts.plain || !process.stdout.isTTY || !!process.env.CI || !!opts.output;`
  - In the review action callback: resolve `outputFormat` from `options.output ?? options.format ?? undefined` (default behavior when neither specified: styled TUI)
  - If `options.format` is used and `options.output` is not, print deprecation warning to stderr: `console.error('Warning: --format is deprecated. Use --output instead.')`
  - Pass `outputFormat` to `reviewCommand()` via updated `ReviewOptions`
  - Update `ReviewCommandOptions` interface to include `output?: string` field
  - **Files**: `apps/cli/src/index.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 2.5 Update `review.ts` with output format routing (~60 lines modified)
  - Add `outputFormat?: 'json' | 'sarif' | 'markdown'` to `ReviewOptions` interface
  - Import `buildSarif` from `ghagga-core`
  - After pipeline completes (Step 6 area), replace existing format conditional with switch:

    ```
    switch (options.outputFormat) {
      case 'json':     console.log(JSON.stringify(result, null, 2)); break;
      case 'sarif':    console.log(JSON.stringify(buildSarif(result, pkg.version), null, 2)); break;
      case 'markdown': console.log(formatMarkdownResult(result)); break;
      default:         tui.log.message(formatMarkdownResult(result)); break; // styled TUI
    }
    ```
  - When `outputFormat` is set, skip `tui.intro()`, `tui.outro()` (wrap existing calls in `if (!outputFormat)` guards)
  - Import `pkg.version` (pass as parameter or read from the same package.json pattern)
  - **Files**: `apps/cli/src/commands/review.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 2.6 Create CLI-side SARIF re-export `apps/cli/src/ui/sarif.ts` (~5 lines new)
  - Re-export `buildSarif` from `ghagga-core` for CLI convenience
  - **Files**: `apps/cli/src/ui/sarif.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 2.7 Unit tests for SARIF builder (~150 lines new)
  - Create `packages/core/src/sarif/builder.test.ts`
  - Tests (vitest):
    - Zero findings → valid SARIF with empty `results[]`, version "2.1.0", correct schema URI
    - 5 findings from 2 tools → 5 results, distinct rules per unique (source, category) pair
    - Severity mapping: critical → `"error"`, high → `"error"`, medium → `"warning"`, low → `"note"`, info → `"note"`
    - Finding with file and line → `physicalLocation` has `artifactLocation.uri` and `region.startLine`
    - Finding without line → `region` omitted, `artifactLocation.uri` still present
    - SARIF `tool.driver.name` = "ghagga", `version` matches passed version string
    - Unicode characters in messages → properly included (no escaping issues in JSON)
    - Findings from same tool + same category share a single rule entry
  - **Files**: `packages/core/src/sarif/builder.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-core test` passes
  - **Post**: `pnpm lint:fix`

- [x] 2.8 Integration test: `--output` flag routing (~80 lines new)
  - Create `apps/cli/src/commands/__tests__/review-output.test.ts` (or extend `review.test.ts`)
  - Tests:
    - `--output json` produces valid JSON (parse with `JSON.parse`, no ANSI codes)
    - `--output sarif` produces valid SARIF (check `$.version === '2.1.0'`, `$.runs` exists)
    - `--output markdown` produces clean markdown (no ANSI escape sequences)
    - `--format json` (deprecated alias) produces identical output to `--output json`
    - When `--output` is set, no `tui.intro()` or `tui.outro()` calls
  - Mock the review pipeline for these tests (don't need real git diff)
  - **Files**: `apps/cli/src/commands/__tests__/review-output.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-cli test` passes
  - **Post**: `pnpm lint:fix`

## Phase 3: TUI Polish — Integrate Severity/Box/Divider/Progress Into Review Flow

- [x] 3.1 Wire step progress `[n/m]` into review pipeline (~40 lines modified)
  - In `review.ts`, modify the non-verbose path (when `!options.verbose`):
    - Create a spinner via `tui.spinner()` and register it with `tui.setActiveSpinner(s)`
    - Create a `ProgressCallback` that calls `tui.progress(stepIndex, totalSteps, event.message)` instead of just the spinner
    - Compute `totalSteps` from tool registry active tool count + fixed pipeline steps (validate, parse-diff, detect-stacks, agent, memory → ~5 fixed steps)
    - Map `ProgressEvent.step` to incrementing `stepIndex`
    - Pass this callback as `onProgress` to the pipeline
    - Call `tui.setActiveSpinner(null)` after pipeline completes
  - **Files**: `apps/cli/src/commands/review.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 3.2 Add section dividers between tool finding groups in review output (~30 lines modified)
  - In `formatMarkdownResult()` in `ui/format.ts`, insert `tui.divider(toolLabel)` (or a format-equivalent divider) between each tool's findings section
  - Since `format.ts` must remain pure (no `tui.*` calls), add a `formatToolDivider(label: string, plain: boolean): string` pure function in `format.ts` that produces either `--- label ---` or `──── label ────`
  - Update the loop in `formatMarkdownResult()` to insert a divider before each tool section (except the first)
  - **Files**: `apps/cli/src/ui/format.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 3.3 Add colored severity to finding rendering (~15 lines modified)
  - In the styled TUI output path in `review.ts` (the `default` case of the output switch), apply `tui.severity()` to each finding's severity label when rendering
  - Update `formatMarkdownResult()` to accept an optional `styled` parameter — when true, use `tui.severity()` for severity labels
  - Alternatively: keep `formatMarkdownResult` pure and apply severity coloring in the review.ts output path only (post-format transformation)
  - **Files**: `apps/cli/src/commands/review.ts`, `apps/cli/src/ui/format.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 3.4 Add box-drawing summary at end of review (~30 lines modified)
  - In `review.ts`, after rendering findings in the styled output path:
    - Build summary lines using `formatBoxSummary(result)` from `format.ts`
    - Render using `tui.box("Review Summary", summaryLines)` in styled mode
    - In plain mode, render using plain box format
  - Summary box content: status, finding counts per severity (critical: N, high: N, ...), execution time, tools run
  - **Files**: `apps/cli/src/commands/review.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 3.5 Tests for TUI-polished review output (~100 lines new)
  - Create or extend `apps/cli/src/commands/__tests__/review-tui.test.ts`
  - Tests:
    - Styled mode review → output contains box-drawing characters (`┌`, `└`, `│`)
    - Styled mode review → output contains severity-colored text (ANSI codes present)
    - Styled mode review → dividers between tool sections use `─` characters
    - Plain mode review → `[LEVEL]` prefix for severity, `---` delimiters, no ANSI codes
    - Plain mode review → all output matches `/^[^\x1b]*$/` (no escape sequences)
    - Zero findings → summary box still appears with "0 findings" and PASSED
  - **Files**: `apps/cli/src/commands/__tests__/review-tui.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-cli test` passes
  - **Post**: `pnpm lint:fix`

## Phase 4: AI Enhance — Core Module, Pipeline Integration, CLI Flags

- [x] 4.1 Create enhance type definitions in `packages/core/src/enhance/types.ts` (~50 lines new)
  - Create directory `packages/core/src/enhance/`
  - Define interfaces exactly as specified in design.md:
    - `EnhanceInput` — `{ findings, provider, model, apiKey }`
    - `EnhanceFindingSummary` — compact finding representation for AI prompt (id, file, line, severity, category, message, source)
    - `EnhanceResult` — `{ groups, priorities, suggestions, filtered }`
    - `FindingGroup` — `{ groupId, label, findingIds }`
    - `FilteredFinding` — `{ findingId, reason }`
    - `EnhanceMetadata` — `{ model, tokenUsage, groupCount, filteredCount }`
  - **Files**: `packages/core/src/enhance/types.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 4.2 Create AI enhance prompt template in `packages/core/src/enhance/prompt.ts` (~100 lines new)
  - Export `buildEnhancePrompt(findings: EnhanceFindingSummary[]): string`
  - System prompt: role definition ("You are a code review assistant analyzing static analysis findings")
  - Instructions: group related findings, prioritize by real-world impact (1-10), suggest concrete fixes, identify false positives
  - Output format: structured JSON with `groups`, `priorities`, `suggestions`, `filtered` keys
  - Include token-efficient serialization: only include id, file, line, severity, category, message — no verbose fields
  - Export `ENHANCE_SYSTEM_PROMPT: string` constant
  - Export `serializeFindings(findings: ReviewFinding[]): EnhanceFindingSummary[]` — maps full findings to compact format, assigns numeric IDs
  - Export `truncateByTokenBudget(summaries: EnhanceFindingSummary[], maxTokens: number): EnhanceFindingSummary[]` — drops lowest-severity findings first until within budget (4K tokens ≈ ~200 findings)
  - **Files**: `packages/core/src/enhance/prompt.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 4.3 Create enhance main function in `packages/core/src/enhance/enhance.ts` (~200 lines new)
  - Export `enhanceFindings(input: EnhanceInput): Promise<EnhanceResult>`
  - Flow:
    1. If `input.findings.length === 0` → return empty result (skip AI call)
    2. Serialize findings via `serializeFindings()`, truncate via `truncateByTokenBudget()`
    3. Build prompt via `buildEnhancePrompt()`
    4. Call LLM using `createModel()` from `packages/core/src/providers/` with the specified provider/model/apiKey
    5. Parse JSON response — extract `groups`, `priorities`, `suggestions`, `filtered`
    6. Validate response shape (graceful fallback if malformed)
    7. Return `EnhanceResult` with token usage metadata
  - Wrap entire function in try/catch — on any error, return empty/unenhanced result with warning
  - Export `mergeEnhanceResult(findings: ReviewFinding[], enhanceResult: EnhanceResult): ReviewFinding[]` — merges `groupId`, `aiPriority`, `aiFiltered`, `filterReason` onto matching findings
  - Create barrel export `packages/core/src/enhance/index.ts`
  - **Files**: `packages/core/src/enhance/enhance.ts` (new), `packages/core/src/enhance/index.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 4.4 Add enhance fields to core types (~30 lines modified)
  - In `packages/core/src/types.ts`, add optional fields to `ReviewResult`:
    - `enhanced?: boolean`
    - `enhanceMetadata?: EnhanceMetadata` (import from `./enhance/types.js`)
  - Add optional field to `ReviewInput`:
    - `enhance?: boolean`
  - Add optional fields to `ReviewFinding`:
    - `groupId?: string`
    - `aiPriority?: number`
    - `aiFiltered?: boolean`
    - `filterReason?: string`
  - **Files**: `packages/core/src/types.ts`
  - **Verify**: `npx tsc --noEmit` in `packages/core`; existing tests still pass (optional fields)
  - **Post**: `pnpm lint:fix`

- [x] 4.5 Integrate enhance step into pipeline.ts (~20 lines modified)
  - Import `enhanceFindings`, `mergeEnhanceResult` from `./enhance/index.js`
  - After static analysis step (Step 4) and before agent mode (Step 5):
    - If `input.enhance === true` and static findings exist:
      - Call `enhanceFindings({ findings: staticFindings, provider, model, apiKey })`
      - If successful, merge via `mergeEnhanceResult()`, set `result.enhanced = true`, attach `result.enhanceMetadata`
      - If failed, set `result.enhanced = false`, emit progress warning "AI enhance failed: {reason}" - If `input.enhance !== true`, skip (no AI call)
  - **Files**: `packages/core/src/pipeline.ts`
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 4.6 Export enhance module from `packages/core/src/index.ts` (~5 lines added)
  - Add `export { enhanceFindings, mergeEnhanceResult } from './enhance/index.js';`
  - Add `export type { EnhanceMetadata, EnhanceResult, FindingGroup } from './enhance/types.js';`
  - **Files**: `packages/core/src/index.ts`
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 4.7 Add `--enhance` / `--no-enhance` flags to CLI (~30 lines modified)
  - In `apps/cli/src/index.ts`:
    - Add `.option('--enhance', 'Enable AI-powered post-analysis enhancement')` to the review command
    - Add `.option('--no-enhance', 'Disable AI enhancement')` (Commander handles boolean toggle)
    - Pass `enhance: options.enhance ?? false` to `reviewCommand()` (default OFF in v2.5.0)
  - In `apps/cli/src/commands/review.ts`:
    - Add `enhance?: boolean` to `ReviewOptions`
    - Pass `enhance: options.enhance` to the pipeline's `ReviewInput`
  - Update `ReviewCommandOptions` in `index.ts` to include `enhance?: boolean`
  - **Files**: `apps/cli/src/index.ts`, `apps/cli/src/commands/review.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 4.8 Unit tests for enhance module (~150 lines new)
  - Create `packages/core/src/enhance/enhance.test.ts`
  - Tests (vitest, mock LLM calls via `vi.mock`):
    - Zero findings → returns empty result, no LLM call made
    - Mock LLM returns valid grouped/prioritized/filtered JSON → groups, priorities, suggestions, filtered parsed correctly
    - `mergeEnhanceResult()` assigns `groupId`, `aiPriority`, `aiFiltered`, `filterReason` to matching findings
    - LLM failure (network error) → returns unenhanced result, no throw
    - LLM returns malformed JSON → returns unenhanced result, no throw
    - `serializeFindings()` maps ReviewFinding[] to compact EnhanceFindingSummary[] with sequential IDs
    - `truncateByTokenBudget()` drops info→low→medium findings until within budget
    - Token budget: 500 findings → only ~200 kept after truncation (lowest severity dropped first)
  - **Files**: `packages/core/src/enhance/enhance.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-core test` passes
  - **Post**: `pnpm lint:fix`

## Phase 5: Health Command — Core Scoring, Trends, Recommendations, CLI Command

- [ ] 5.1 Create health scoring module `packages/core/src/health/score.ts` (~250 lines new)
  - Create directory `packages/core/src/health/`
  - Export `SEVERITY_WEIGHTS: Record<FindingSeverity, number>` — `{ critical: -20, high: -10, medium: -3, low: -1, info: 0 }`
  - Export `HealthScore` interface: `{ score: number, grade: string, findingCounts: Record<FindingSeverity, number>, totalFindings: number }`
  - Export `computeHealthScore(findings: ReviewFinding[]): HealthScore`:
    - Base score = 100, sum all severity weights, clamp to [0, 100]
    - Grade: A (80-100), B (60-79), C (40-59), D (20-39), F (0-19)
    - Count findings per severity
  - Export `getScoreColor(score: number): 'green' | 'yellow' | 'red'` — green (80+), yellow (50-79), red (0-49)
  - Export `formatTopIssues(findings: ReviewFinding[], limit: number): ReviewFinding[]` — sort by severity (critical first), take top N
  - **Files**: `packages/core/src/health/score.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [ ] 5.2 Create health trends module `packages/core/src/health/trends.ts` (~200 lines new)
  - Export `HealthHistoryEntry` interface: `{ timestamp, score, findingCounts, toolsRun, projectPath }`
  - Export `HealthTrend` interface: `{ previous: number | null, delta: number | null, direction: 'up' | 'down' | 'unchanged' | null }`
  - Export `loadHistory(configDir: string, projectPath: string): HealthHistoryEntry[]`:
    - Read `health-history.json` from configDir, parse JSON, filter by projectPath
    - Missing file → return []; corrupt JSON → return [] (silent recovery)
  - Export `saveHistory(configDir: string, entry: HealthHistoryEntry): void`:
    - Read existing entries (or []), append new entry, prune to max 10 per project, write file
    - Create configDir if it doesn't exist (mkdir -p)
    - Permission denied → warn but don't throw
  - Export `computeTrend(currentScore: number, history: HealthHistoryEntry[]): HealthTrend`:
    - No history → `{ previous: null, delta: null, direction: null }`
    - Has history → compare with last entry, compute delta and direction
  - **Files**: `packages/core/src/health/trends.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [ ] 5.3 Create health recommendations module `packages/core/src/health/recommendations.ts` (~200 lines new)
  - Export `HealthRecommendation` interface: `{ category: string, action: string, impact: 'high' | 'medium' | 'low', findingCount: number }`
  - Export `generateRecommendations(findings: ReviewFinding[], limit?: number): HealthRecommendation[]`:
    - Group findings by category (security, dependencies, complexity, secrets, quality, etc.)
    - Derive category from finding source + category fields (Semgrep→security, Trivy→dependencies, Gitleaks→secrets, etc.)
    - Sort categories by weighted severity impact (highest first)
    - Generate actionable text per category (e.g., "Run `npm audit fix` to address 3 dependency vulnerabilities")
    - Return top N recommendations (default 5)
    - Zero findings → return empty array
  - Include a `RECOMMENDATION_TEMPLATES` map for common categories with templated action strings
  - **Files**: `packages/core/src/health/recommendations.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 5.4 Create health barrel export and add types to core (~15 lines new/modified)
  - Create `packages/core/src/health/index.ts` — barrel export for all health modules
  - In `packages/core/src/types.ts`, add `HealthResult` type:
    - `{ score: HealthScore, trend: HealthTrend, recommendations: HealthRecommendation[], topIssues: ReviewFinding[], toolsRun: string[], timestamp: string }`
  - In `packages/core/src/index.ts`, export:
    - `export { computeHealthScore, getScoreColor, formatTopIssues, SEVERITY_WEIGHTS } from './health/index.js';`
    - `export { loadHistory, saveHistory, computeTrend } from './health/index.js';`
    - `export { generateRecommendations } from './health/index.js';`
    - `export type { HealthScore, HealthTrend, HealthHistoryEntry, HealthRecommendation, HealthResult } from './health/index.js';`
  - **Files**: `packages/core/src/health/index.ts` (new), `packages/core/src/types.ts`, `packages/core/src/index.ts`
  - **Verify**: `npx tsc --noEmit` in `packages/core`
  - **Post**: `pnpm lint:fix`

- [x] 5.5 Create health command handler `apps/cli/src/commands/health.ts` (~300 lines new)
  - Export `HealthOptions` interface: `{ output?: 'json', plain?: boolean, top?: number }`
  - Export `healthCommand(targetPath: string, options: HealthOptions): Promise<void>`
  - Flow:
    1. Resolve target path (default `.`)
    2. Initialize tool registry (`initializeDefaultTools()`)
    3. Filter tools to always-on subset (Semgrep, Trivy, Gitleaks, ShellCheck, Lizard)
    4. Run static analysis via `runStaticAnalysis()` or `runTools()` on the target path
    5. Collect all findings from tool results
    6. Compute health score via `computeHealthScore(findings)`
    7. Load history via `loadHistory(getConfigDir(), projectPath)`
    8. Compute trend via `computeTrend(score, history)`
    9. Generate recommendations via `generateRecommendations(findings)`
    10. Format top issues via `formatTopIssues(findings, options.top ?? 5)`
    11. If `--output json` → print JSON to stdout (structured HealthResult)
    12. Else → render styled output:
        - Score with color coding via `tui.severity()` + `getScoreColor()`
        - Trend display (delta, direction arrow)
        - Top issues list
        - Recommendations list
        - Use `tui.box()` for the score summary, `tui.divider()` for sections
    13. Save history entry via `saveHistory(getConfigDir(), entry)`
  - Does NOT require authentication (no API key checks)
  - **Files**: `apps/cli/src/commands/health.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 5.6 Register health command in `apps/cli/src/index.ts` (~20 lines added)
  - Import `healthCommand` from `./commands/health.js`
  - Add command registration after the review command:

    ```
    program
      .command('health')
      .description('Quick project health check with scoring and trends')
      .argument('[path]', 'Path to the repository', '.')
      .option('--top <n>', 'Number of top issues to show', '5')
      .action(async (path, options) => {
        await healthCommand(path, { output: options.output, top: parseInt(options.top) });
      });
    ```
  - The `--output` and `--plain` global flags from the parent program are available via `optsWithGlobals()`
  - **Files**: `apps/cli/src/index.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`; `node dist/index.js health --help` shows the command
  - **Post**: `pnpm lint:fix`

- [x] 5.7 Unit tests for health scoring and recommendations (~150 lines new)
  - Create `packages/core/src/health/score.test.ts`
  - Tests:
    - Zero findings → score 100, grade A
    - 10 critical findings (10 × -20 = -200) → score 0, grade F (clamped)
    - Mixed: 1 critical + 2 high + 5 medium = -20 -20 -15 = -55 → score 45, grade C
    - `getScoreColor`: 85 → green, 60 → yellow, 30 → red
    - `formatTopIssues`: returns top N sorted by severity (critical first), respects limit
  - Create `packages/core/src/health/recommendations.test.ts`
  - Tests:
    - Findings in multiple categories → sorted by impact (highest first)
    - Zero findings → empty recommendations array
    - All findings in one category → still produces meaningful recommendations
    - Categories with only `info` findings → omitted
    - Recommendation `action` field contains actionable text
  - **Files**: `packages/core/src/health/score.test.ts` (new), `packages/core/src/health/recommendations.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-core test` passes
  - **Post**: `pnpm lint:fix`

- [x] 5.8 Unit tests for health trends (~100 lines new)
  - Create `packages/core/src/health/trends.test.ts`
  - Tests:
    - `loadHistory` with missing file → returns []
    - `loadHistory` with corrupt JSON → returns []
    - `loadHistory` filters by projectPath (multi-project isolation)
    - `saveHistory` prunes to 10 entries per project
    - `saveHistory` creates directory if missing
    - `computeTrend` with no history → `{ previous: null, delta: null, direction: null }`
    - `computeTrend` with improvement → positive delta, direction 'up'
    - `computeTrend` with regression → negative delta, direction 'down'
    - `computeTrend` with unchanged → delta 0, direction 'unchanged'
  - Use temp directories for file I/O tests
  - **Files**: `packages/core/src/health/trends.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-core test` passes
  - **Post**: `pnpm lint:fix`

- [x] 5.9 Line count verification for health feature
  - Run `wc -l` on all health-specific files (excluding tests):
    - `apps/cli/src/commands/health.ts`
    - `packages/core/src/health/score.ts`
    - `packages/core/src/health/trends.ts`
    - `packages/core/src/health/recommendations.ts`
  - Total MUST be ≤ 1,500 lines (target: ~950)
  - If over budget, refactor to move logic or reduce verbosity
  - **Verify**: Combined line count ≤ 1,500

## Phase 6: Issue Flag — GitHub API Client, --issue Flag

- [x] 6.1 Create GitHub API client `apps/cli/src/lib/github-api.ts` (~150 lines new)
  - Export `GitHubApiError` class extending `Error` with `status: number` and `body: string`
  - Export `createIssue(opts: { token, owner, repo, title, body, labels }): Promise<CreateIssueResult>`:
    - `POST /repos/{owner}/{repo}/issues` via `fetch`
    - Returns `{ url: string, number: number }`
    - Throws `GitHubApiError` on 401, 403, 404, 410 (issues disabled), 422, 429 (rate limited)
  - Export `createComment(opts: { token, owner, repo, issueNumber, body }): Promise<CreateCommentResult>`:
    - `POST /repos/{owner}/{repo}/issues/{number}/comments` via `fetch`
    - Returns `{ url: string }`
  - Export `ensureLabel(opts: { token, owner, repo, name, color, description }): Promise<void>`:
    - `POST /repos/{owner}/{repo}/labels` via `fetch`
    - Silently ignores 422 (already exists) and 403 (insufficient permissions)
  - Export `parseGitHubRemote(remoteUrl: string): { owner: string, repo: string }`:
    - Handle HTTPS: `https://github.com/owner/repo.git` → `{ owner, repo }`
    - Handle SSH: `git@github.com:owner/repo.git` → `{ owner, repo }`
    - Handle SSH protocol: `ssh://git@github.com/owner/repo.git` → `{ owner, repo }`
    - Strip `.git` suffix
    - Throw if not a GitHub URL
  - Export `formatIssueBody(result: ReviewResult, version: string): string`:
    - Summary section: status, finding counts, execution time
    - Collapsible `<details>` with full markdown review
    - GHAGGA version footer
  - **Files**: `apps/cli/src/lib/github-api.ts` (new)
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 6.2 Add `--issue` flag to CLI and wire into review command (~50 lines modified)
  - In `apps/cli/src/index.ts`:
    - Add `.option('--issue <target>', 'Create/update a GitHub issue with review results (use "new" or issue number)')` to review command
  - In `apps/cli/src/commands/review.ts`:
    - Add `issue?: string` to `ReviewOptions`
    - After output format routing (but before `process.exit`):
      - If `options.issue` is set:
        1. Validate GitHub token available (`getStoredToken()`) — error with suggestion to `ghagga login` if missing
        2. Get git remote URL via `execSync('git remote get-url origin')`
        3. Parse owner/repo via `parseGitHubRemote()`
        4. Get short SHA via `execSync('git rev-parse --short HEAD')`
        5. Call `ensureLabel()` with `ghagga-review` label (ignore errors)
        6. If `--issue new`: call `createIssue()`, print URL
        7. If `--issue <number>`: call `createComment()`, print comment URL
        8. Print URL to stderr if `--output` is set (stdout reserved for format), else print to stdout via `tui.log.success()` - On failure: warn but don't block exit (review still succeeds)
  - Update `ReviewCommandOptions` in `index.ts` to include `issue?: string`
  - **Files**: `apps/cli/src/index.ts`, `apps/cli/src/commands/review.ts`
  - **Verify**: `npx tsc --noEmit` in `apps/cli`
  - **Post**: `pnpm lint:fix`

- [x] 6.3 Unit tests for GitHub API client (~120 lines new)
  - Create `apps/cli/src/lib/github-api.test.ts`
  - Tests (vitest, mock `fetch` via `vi.fn()`):
    - `parseGitHubRemote()`:
      - HTTPS URL → correct owner/repo
      - SSH URL → correct owner/repo
      - SSH protocol URL → correct owner/repo
      - URL without `.git` → correct owner/repo
      - Non-GitHub URL → throws - `createIssue()`:
      - Mock 201 response → returns `{ url, number }`
      - Mock 401 → throws auth error
      - Mock 410 → throws "issues disabled" error
      - Mock 429 → throws rate limit error - `createComment()`:
      - Mock 201 response → returns `{ url }`
      - Mock 404 → throws "issue not found" error - `ensureLabel()`:
      - Mock 201 → label created
      - Mock 422 → silently ignored (already exists)
      - Mock 403 → silently ignored (insufficient permissions) - `formatIssueBody()`:
      - Contains `<details>` tag
      - Contains status and finding counts
      - Contains GHAGGA version
  - **Files**: `apps/cli/src/lib/github-api.test.ts` (new)
  - **Verify**: `pnpm --filter ghagga-cli test` passes
  - **Post**: `pnpm lint:fix`

## Phase 7: Verification, Build, and Cross-Cutting Validation

- [x] 7.1 Run full test suite — all existing + new tests pass
  - Run `pnpm test` at repo root
  - All existing tests MUST pass without modification (zero regressions)
  - All new tests from phases 1-6 MUST pass
  - **Verify**: Exit code 0, no failures

- [x] 7.2 Run TypeScript type check across entire monorepo
  - Run `pnpm -r exec npx tsc --noEmit` (or equivalent turbo command)
  - All packages must compile with zero type errors
  - **Verify**: Clean output, exit code 0

- [x] 7.3 Verify ncc bundling with chalk
  - Run `pnpm --filter ghagga-cli build` (which runs `ncc build`)
  - Verify bundle succeeds and includes chalk
  - Check bundle size increase: `ls -la` the output — increase must be < 30KB over baseline
  - If chalk bundling fails: implement fallback (vendor 50 lines of ANSI color functions in `chalk.ts`)
  - **Verify**: Bundle compiles; size delta < 30KB

- [x] 7.4 Verify no direct chalk imports in commands
  - Search for `import.*chalk` or `from 'chalk'` in `apps/cli/src/commands/` and `apps/cli/src/lib/`
  - Only `ui/chalk.ts` should import chalk directly
  - **Verify**: `grep -r "from 'chalk'" apps/cli/src/commands/ apps/cli/src/lib/` returns zero matches

- [x] 7.5 Verify TUI facade encapsulation — no direct `@clack/prompts` imports in commands
  - Search for `import.*@clack/prompts` in `apps/cli/src/commands/`
  - Only `ui/tui.ts` should import `@clack/prompts`
  - **Verify**: `grep -r "@clack/prompts" apps/cli/src/commands/` returns zero matches

- [x] 7.6 Health line budget final verification
  - Count non-test lines in health feature files
  - MUST be ≤ 1,500 lines
  - **Verify**: `wc -l` on health files (excluding tests, blank lines OK)

- [x] 7.7 Run linter and fix any remaining issues
  - Run `pnpm lint:fix` across the monorepo
  - Run `pnpm lint` to verify clean output
  - **Verify**: Zero lint errors

- [x] 7.8 Smoke tests (manual or scripted)
  - Build the CLI: `pnpm build`
  - Test commands:
    - `CI=true node dist/index.js review . --quick` → plain mode, no ANSI
    - `node dist/index.js review . --output json --quick` → valid JSON, no TUI
    - `node dist/index.js review . --output sarif --quick` → valid SARIF JSON
    - `node dist/index.js health` → health score displayed
    - `node dist/index.js health --output json` → valid JSON health output
    - `node dist/index.js review --help` → shows `--output`, `--enhance`, `--issue` flags
    - `node dist/index.js health --help` → shows health command docs
  - **Verify**: All smoke tests pass

---

## Summary

| Phase             | Tasks  | Description                                                                         |
| ----------------- | ------ | ----------------------------------------------------------------------------------- |
| 1. TUI Foundation | 5      | chalk adapter, tui.ts extensions, theme, format helpers, unit tests                 |
| 2. Output Formats | 8      | SARIF types/builder, --output flag, format routing, deprecate --format, tests       |
| 3. TUI Polish     | 5      | step progress, section dividers, colored severity, box summary, tests               |
| 4. AI Enhance     | 8      | enhance types/prompt/function, pipeline integration, CLI flags, tests               |
| 5. Health Command | 9      | score/trends/recommendations modules, CLI command, registration, tests, line budget |
| 6. Issue Flag     | 3      | GitHub API client, --issue wiring, tests                                            |
| 7. Verification   | 8      | full tests, typecheck, ncc build, encapsulation checks, lint, smoke tests           |
| **Total**         | **46** |                                                                                     |

### Estimated New Code (excluding tests)

| Feature                                               | ~Lines     |
| ----------------------------------------------------- | ---------- |
| TUI Foundation (chalk.ts + tui.ts + theme.ts)         | ~135       |
| Output Formats (SARIF builder + types + routing)      | ~350       |
| AI Enhance (types + prompt + enhance + pipeline)      | ~400       |
| Health (scoring + trends + recommendations + command) | ~950       |
| Issue (github-api.ts + review.ts wiring)              | ~200       |
| Wiring (index.ts changes)                             | ~100       |
| **Total new code**                                    | **~2,135** |
| **Test code**                                         | **~870**   |

### Key Constraints Reminder

- Sub-agents don't run Biome → `pnpm lint:fix` needed after each implementation task
- Health total must stay ≤ 1,500 lines (target: ~950)
- All tests use vitest
- Commands never import chalk directly (only via `ui/chalk.ts` → `ui/tui.ts`)
- Format functions in `ui/format.ts` must remain pure (no I/O, no side effects)
- `--output` triggers plain mode — zero TUI decorations on stdout
- AI Enhance default is OFF in v2.5.0 (opt-in via `--enhance`)
