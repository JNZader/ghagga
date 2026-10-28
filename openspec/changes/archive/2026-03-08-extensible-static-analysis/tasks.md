# Tasks: Extensible Static Analysis — From 3 Hardcoded Tools to 15 via Plugin Registry

> **Change**: extensible-static-analysis
> **Status**: Ready for implementation
> **Phases**: 9
> **Total tasks**: 85

---

## Phase 1: Foundation — Types, Registry, Execution Context, Budget, Orchestrator

> **Goal**: Create the entire core infrastructure in `packages/core/src/tools/` that all subsequent phases depend on. System remains functional because nothing references these new files yet.
- [ ] 1.1 Create `packages/core/src/tools/types.ts` with `ToolName`, `ToolCategory`, `ToolTier`, `RawToolOutput`, `ToolDefinition`, `ExecutionContext`, `ExecOpts` interfaces as specified in `design.md:236-322`
- [ ] 1.2 Create `packages/core/src/tools/registry.ts` with `ToolRegistry` class implementing `register()`, `getAll()`, `getByName()`, `getByTier()`, `validateAll()`, `size` getter — plus the singleton `toolRegistry` export as specified in `design.md:326-353`
- [ ] 1.3 Create `packages/core/src/tools/resolve.ts` with `resolveActivatedTools()` implementing the 5-step resolution order: always-on → auto-detect(files) → +enabledTools → -disabledTools → -deprecated booleans as specified in `specs/runner/spec.md:48-86` and `design.md:356-381`
- [ ] 1.4 Create `packages/core/src/tools/budget.ts` with `allocateTimeBudget()` and `getEffectiveBudget()` — total 600s default, min 30s/tool, always-on priority, rollover logic as specified in `specs/runner/spec.md:107-149` and `design.md:383-414`
- [ ] 1.5 Create `packages/core/src/tools/orchestrator.ts` with `runToolsWithRegistry()` — sequential install → run → parse loop, failure isolation via try/catch, timeout enforcement (SIGTERM+5s SIGKILL), `ensureLegacyKeys()` for backward compat, total-budget-exhausted handling as specified in `specs/runner/spec.md:14-236` and `design.md:94-143`
- [ ] 1.6 Create `packages/core/src/tools/execution.ts` with `NodeExecutionContext` class implementing `ExecutionContext` using `node:child_process` — `exec()` with timeout, `cacheRestore()`/`cacheSave()` as no-ops (CLI has no cache), `log()` via `console.log` as specified in `design.md:28-38`
- [ ] 1.7 Modify `packages/core/src/types.ts`: change `StaticAnalysisResult` to intersection type `LegacyStaticAnalysisResult & Record<string, ToolResult>`, change `FindingSource` to `'ai' | ToolName`, add `enabledTools?: string[]` and `disabledTools?: string[]` to `ReviewSettings`, update `DEFAULT_SETTINGS` with `enabledTools: []` and `disabledTools: []` as specified in `design.md:418-472`
- [ ] 1.8 Modify `packages/core/src/index.ts`: add exports for `ToolDefinition`, `ToolCategory`, `ToolName`, `RawToolOutput`, `ExecutionContext`, `ToolTier` types and `toolRegistry` from the new modules
- [ ] 1.9 Write unit tests `packages/core/src/tools/registry.test.ts`: test register, validate (auto-detect requires detect fn), getAll, getByName, getByTier, duplicate registration error, size getter — reference `specs/core/spec.md:24-43`
- [ ] 1.10 Write unit tests `packages/core/src/tools/resolve.test.ts`: parametric tests for all resolution scenarios — default activation, force-enable, force-disable always-on, deprecated boolean fallback, new field precedence over deprecated, mixed settings — reference `specs/runner/spec.md:57-86` and `specs/core/spec.md:159-194`
- [ ] 1.11 Write unit tests `packages/core/src/tools/budget.test.ts`: equal split (10 tools / 600s = 60s each), minimum enforcement (25 tools), rollover from fast tools, total budget exhaustion, single tool, always-on priority when budget tight — reference `specs/runner/spec.md:118-149`
- [ ] 1.12 Write unit tests `packages/core/src/tools/orchestrator.test.ts` with `MockExecutionContext`: success path, one tool crash mid-run, tool timeout, parse failure, install failure isolation, legacy keys always present (semgrep/trivy/cpd even when skipped), total budget exhaustion — reference `specs/runner/spec.md:178-254`
- [ ] 1.13 Verify TypeScript compilation: `result.semgrep` is `ToolResult` (not `ToolResult | undefined`), `result.gitleaks` is `ToolResult | undefined`, `Object.entries(result)` yields `[string, ToolResult][]` — reference `specs/core/spec.md:125-157`

---

## Phase 2: Migrate Existing 3 Tools to Plugin Pattern

> **Goal**: Convert semgrep, trivy, and cpd into `ToolDefinition` plugins inside `packages/core/src/tools/plugins/`. Wire up the feature flag `GHAGGA_TOOL_REGISTRY` so the old path still works when disabled. All existing tests must pass.
- [ ] 2.1 Create `packages/core/src/tools/plugins/semgrep.ts` implementing `ToolDefinition` — adapt install/run/parse from existing `packages/core/src/tools/semgrep.ts` (uses `ExecutionContext.exec()` instead of direct `child_process`); pin version `1.90.0`; `category: 'security'`; `tier: 'always-on'`; `outputFormat: 'json'`; severity mapping ERROR→high, WARNING→medium, INFO→info — reference `specs/tools/spec.md:14-40`
- [ ] 2.2 Create `packages/core/src/tools/plugins/trivy.ts` implementing `ToolDefinition` — adapt from `packages/core/src/tools/trivy.ts`; enhance run command with `--scanners vuln,license`; add license finding parser (severity `info`, category `license`); pin version `0.69.3`; `category: 'sca'`; `tier: 'always-on'` — reference `specs/tools/spec.md:42-78`
- [ ] 2.3 Create `packages/core/src/tools/plugins/cpd.ts` implementing `ToolDefinition` — adapt from `packages/core/src/tools/cpd.ts`; `successExitCodes: [4]` for duplications-found exit; pin version `7.8.0`; `category: 'duplication'`; `tier: 'always-on'`; `outputFormat: 'xml'` — reference `specs/tools/spec.md:80-106`
- [ ] 2.4 Create `packages/core/src/tools/plugins/index.ts` — imports and registers semgrep, trivy, cpd plugins with `toolRegistry.register()` (will grow as more plugins are added in Phases 3-5)
- [ ] 2.5 Modify `packages/core/src/tools/runner.ts`: add feature flag gate `GHAGGA_TOOL_REGISTRY` at top of `runStaticAnalysis()`; when enabled, call `runToolsWithRegistry()` via registry path; when disabled, keep existing hardcoded path unchanged — reference `design.md:58-64` and `specs/runner/spec.md:258-272`
- [ ] 2.6 Modify `packages/core/src/tools/runner.ts` `formatStaticAnalysisContext()`: iterate `Object.values(result)` instead of hardcoded `result.semgrep`/`trivy`/`cpd`; add finding cap at 200 with severity-priority sort and "Showing X of Y" summary — reference `specs/core/spec.md:217-232` and `design.md:170-178`
- [ ] 2.7 Create `apps/action/src/tools/execution.ts` with `ActionsExecutionContext` implementing `ExecutionContext` — wraps `@actions/exec` for `exec()`, `@actions/cache` for `cacheRestore()`/`cacheSave()`, `@actions/core.info()` for `log()` — reference `design.md:28-38`
- [ ] 2.8 Modify `apps/action/src/tools/orchestrator.ts`: add feature flag gate `GHAGGA_TOOL_REGISTRY`; when enabled, create `ActionsExecutionContext`, call `runToolsWithRegistry()` from core; when disabled, keep existing `executeSemgrep`/`executeTrivy`/`executeCpd` path — reference `design.md:214`
- [ ] 2.9 Write unit tests for each adapted plugin's `parse()` function using fixture JSON/XML from existing test data in `packages/core/src/tools/*.test.ts`; verify output matches existing behavior exactly — reference `specs/tools/spec.md:28-33`, `specs/tools/spec.md:58-78`, `specs/tools/spec.md:94-106`
- [ ] 2.10 Run full existing test suite (`pnpm test`) to verify backward compatibility — no test modifications should be needed; all hardcoded `result.semgrep`/`.trivy`/`.cpd` accesses still work via intersection type

---

## Phase 3: Always-On New Tools — Gitleaks, ShellCheck, markdownlint, Lizard

> **Goal**: Add 4 new always-on tool plugins. Each is a single file + test. Register in `plugins/index.ts`. System remains backward compat because these only activate when `GHAGGA_TOOL_REGISTRY=true`.
- [ ] 3.1 Create `packages/core/src/tools/plugins/gitleaks.ts` — `tier: 'always-on'`; `category: 'secrets'`; version `8.21.2`; install from GitHub Releases (`linux_x64.tar.gz`); run `gitleaks detect --source {repoDir} --report-format json --no-git --exit-code 0`; parse JSON findings as severity `critical`; verify binary after install — reference `specs/tools/spec.md:112-147` and `design.md:497-563`
- [ ] 3.2 Write tests `packages/core/src/tools/plugins/gitleaks.test.ts`: test `parse()` with fixture JSON (leaked AWS key → critical finding with file+line), empty results, malformed JSON handling, timeout → empty findings
- [ ] 3.3 Create `packages/core/src/tools/plugins/shellcheck.ts` — `tier: 'always-on'`; `category: 'linting'`; version `0.10.0`; install = verify pre-installed or download from GitHub; run `shellcheck --format=json` scoped to `*.sh`/`*.bash` files from `files` param; parse `level` → severity (error→high, warning→medium, info→info, style→low); return empty findings if no shell files — reference `specs/tools/spec.md:148-182`
- [ ] 3.4 Write tests `packages/core/src/tools/plugins/shellcheck.test.ts`: test `parse()` with fixture JSON (SC2086 warning), empty shell files list, `detect` behavior (optional for always-on)
- [ ] 3.5 Create `packages/core/src/tools/plugins/markdownlint.ts` — `tier: 'always-on'`; `category: 'docs'`; version `0.17.1`; install `npm install -g markdownlint-cli2@{version}`; run scoped to changed `*.md` files only; parse findings as severity `low`; return empty findings if no markdown files — reference `specs/tools/spec.md:183-215`
- [ ] 3.6 Write tests `packages/core/src/tools/plugins/markdownlint.test.ts`: test `parse()` with fixture output (MD001 heading violation), empty input, no-markdown-files shortcircuit
- [ ] 3.7 Create `packages/core/src/tools/plugins/lizard.ts` — `tier: 'always-on'`; `category: 'complexity'`; version `1.17.13`; install `pip install lizard=={version}`; run `lizard --json` scoped to changed files; parse: complexity >15 → medium, >25 → high; include function name and score in message — reference `specs/tools/spec.md:217-248`
- [ ] 3.8 Write tests `packages/core/src/tools/plugins/lizard.test.ts`: test `parse()` with fixture JSON (complexity 20 → medium, 30 → high), all below threshold → empty, malformed output
- [ ] 3.9 Update `packages/core/src/tools/plugins/index.ts` — register gitleaks, shellcheck, markdownlint, lizard plugins (total: 7 always-on)

---

## Phase 4: Auto-Detect Tools — Python + Go

> **Goal**: Add 3 auto-detect plugins for Python (Ruff, Bandit) and Go (golangci-lint). Each includes a `detect()` function tested against file lists.
- [ ] 4.1 Create `packages/core/src/tools/plugins/ruff.ts` — `tier: 'auto-detect'`; `category: 'linting'`; version `0.9.7`; `detect`: `files.some(f => f.endsWith('.py') || f.endsWith('.pyi'))`; install `pip install ruff`; run `ruff check --output-format json` scoped to changed Python files; parse `code` prefix E→high, W→medium, C/R/I→low — reference `specs/tools/spec.md:270-295`
- [ ] 4.2 Write tests `packages/core/src/tools/plugins/ruff.test.ts`: test `detect()` (`.py` → true, `.go` → false), `parse()` with fixture JSON (unused import, line length)
- [ ] 4.3 Create `packages/core/src/tools/plugins/bandit.ts` — `tier: 'auto-detect'`; `category: 'security'`; version `1.8.3`; `detect`: `files.some(f => f.endsWith('.py'))`; install `pip install bandit`; run `bandit -r {repoDir} -f json --quiet`; parse severity HIGH→high, MEDIUM→medium, LOW→low — reference `specs/tools/spec.md:297-323`
- [ ] 4.4 Write tests `packages/core/src/tools/plugins/bandit.test.ts`: test `detect()` (same as ruff), `parse()` with fixture JSON (eval() usage → high severity)
- [ ] 4.5 Create `packages/core/src/tools/plugins/golangci-lint.ts` — `tier: 'auto-detect'`; `category: 'linting'`; version `1.63.4`; `detect`: `files.some(f => f === 'go.mod' || f.endsWith('.go'))`; install from GitHub Releases (`linux-amd64`); run `golangci-lint run --out-format json --timeout {timeout}s`; parse `Issues[].Severity` — reference `specs/tools/spec.md:325-357`
- [ ] 4.6 Write tests `packages/core/src/tools/plugins/golangci-lint.test.ts`: test `detect()` (`go.mod` → true, `.go` → true, `.ts` → false), `parse()` with fixture JSON
- [ ] 4.7 Update `packages/core/src/tools/plugins/index.ts` — register ruff, bandit, golangci-lint (total: 7 always-on + 3 auto-detect = 10)

---

## Phase 5: Auto-Detect Tools — JS/TS, Java, PHP, Rust, Docker

> **Goal**: Add 5 more auto-detect plugins. After this phase, all 15 tools are registered.
- [ ] 5.1 Create `packages/core/src/tools/plugins/biome.ts` — `tier: 'auto-detect'`; `category: 'linting'`; version `1.9.4`; `detect`: regex `/\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/`; install from GitHub Releases (`biome-linux-x64`); run `biome lint --reporter json`; respect repo `biome.json` — reference `specs/tools/spec.md:358-389`
- [ ] 5.2 Write tests `packages/core/src/tools/plugins/biome.test.ts`: test `detect()` (`.ts` → true, `.py` → false), `parse()` with fixture JSON
- [ ] 5.3 Create `packages/core/src/tools/plugins/pmd.ts` — `tier: 'auto-detect'`; `category: 'quality'`; version `7.8.0` (shared install with CPD at `/opt/pmd`); `detect`: `files.some(f => f.endsWith('.java'))`; install = verify CPD already installed, fallback to download; run `pmd check --format xml --rulesets rulesets/java/quickstart.xml`; parse violation `priority` 1→critical, 2→high, 3→medium, 4→low, 5→info — reference `specs/tools/spec.md:391-417`
- [ ] 5.4 Write tests `packages/core/src/tools/plugins/pmd.test.ts`: test `detect()` (`.java` → true), `parse()` with fixture XML, shared install detection
- [ ] 5.5 Create `packages/core/src/tools/plugins/psalm.ts` — `tier: 'auto-detect'`; `category: 'quality'`; version `6.5.1`; `detect`: `files.some(f => f.endsWith('.php'))`; install PHAR from GitHub Releases; run `php psalm.phar --output-format=json --no-cache`; check PHP runtime availability on install (return error if missing) — reference `specs/tools/spec.md:419-445`
- [ ] 5.6 Write tests `packages/core/src/tools/plugins/psalm.test.ts`: test `detect()`, `parse()` with fixture JSON, PHP-not-available error handling
- [ ] 5.7 Create `packages/core/src/tools/plugins/clippy.ts` — `tier: 'auto-detect'`; `category: 'linting'`; `detect`: `files.some(f => f === 'Cargo.toml' || f.endsWith('.rs'))`; install = verify `cargo` available; run `cargo clippy --message-format json -- -W clippy::all` with timeout; parse `level` error→high, warning→medium, note/help→info; compilation time counts against budget — reference `specs/tools/spec.md:447-480`
- [ ] 5.8 Write tests `packages/core/src/tools/plugins/clippy.test.ts`: test `detect()` (`Cargo.toml` → true, `.rs` → true), `parse()` with fixture JSON, cargo-not-available error
- [ ] 5.9 Create `packages/core/src/tools/plugins/hadolint.ts` — `tier: 'auto-detect'`; `category: 'linting'`; version `2.12.0`; `detect`: `files.some(f => /Dockerfile/.test(f.split('/').pop() ?? ''))`; install from GitHub Releases (`Linux-x86_64`); run `hadolint --format json {dockerfiles}`; parse `level` error→high, warning→medium, info→info, style→low — reference `specs/tools/spec.md:482-515`
- [ ] 5.10 Write tests `packages/core/src/tools/plugins/hadolint.test.ts`: test `detect()` (`Dockerfile` → true, `Dockerfile.prod` → true, `src/main.ts` → false), `parse()` with fixture JSON
- [ ] 5.11 Update `packages/core/src/tools/plugins/index.ts` — register biome, pmd, psalm, clippy, hadolint (total: 7 always-on + 8 auto-detect = 15)
- [ ] 5.12 Write integration test `packages/core/src/tools/orchestrator.integration.test.ts` with `MockExecutionContext`: register all 15 plugins, run orchestrator with various file lists, verify `StaticAnalysisResult` shape has correct tool entries, verify auto-detect activation for Python/Go/JS/Java/PHP/Rust/Docker file lists

---

## Phase 6: Settings Migration — DB Schema, Server API, Dashboard

> **Goal**: Extend DB schema, settings API, and dashboard to support `enabledTools`/`disabledTools` arrays alongside deprecated boolean fields.
- [ ] 6.1 Modify `packages/db/src/schema.ts`: extend `RepoSettings` interface with `enabledTools?: string[]` and `disabledTools?: string[]`; update `DEFAULT_REPO_SETTINGS` with `enabledTools: undefined` (use defaults) and `disabledTools: []` — reference `design.md:476-493`
- [ ] 6.2 Create DB migration script for backfilling `disabledTools` from existing boolean flags: for repos where `enableSemgrep=false`, add `'semgrep'` to `disabledTools` in the `settings` JSONB; same for trivy and cpd; apply to both `repositories.settings` and `installation_settings.settings` — reference `design.md:639-661` and `specs/settings/spec.md:66-91`
- [ ] 6.3 Modify `apps/server/src/routes/api/settings.ts`: extend `RepoSettingsSchema` Zod schema to accept `enabledTools: z.array(z.string()).optional()` and `disabledTools: z.array(z.string()).optional()`; validate tool names against known registry names on PUT (400 for unknown tool); GET response includes `registeredTools` array with `name`, `displayName`, `category`, `tier` from registry — reference `specs/settings/spec.md:121-165`
- [ ] 6.4 Modify `apps/server/src/routes/api/settings.ts` PUT handler: translate old boolean fields to new arrays on write (e.g., `enableSemgrep: false` → ensure `semgrep` in `disabledTools`); translate new arrays back to old booleans for backward compat (e.g., `disabledTools: ['semgrep']` → `enableSemgrep: false`) — reference `specs/settings/spec.md:134-146`
- [ ] 6.5 Modify `apps/server/src/inngest/client.ts`: add `enabledTools?` and `disabledTools?` to `ReviewRequestedData.settings` type — reference `design.md:222`
- [ ] 6.6 Modify `apps/server/src/inngest/review.ts`: pass `enabledTools`/`disabledTools` from resolved settings to runner dispatch; keep old boolean fields for backward compat — reference `design.md:223` and `specs/settings/spec.md:186-197`
- [ ] 6.7 Modify `apps/server/src/github/runner.ts`: update `WorkflowDispatchInputs` and `DispatchParams` to include `enabledTools`/`disabledTools` as JSON string inputs; keep deprecated `enableSemgrep`/`enableTrivy`/`enableCpd` — reference `design.md:219`
- [ ] 6.8 Modify `apps/dashboard/` settings page: replace the 3 individual semgrep/trivy/cpd checkboxes with a tool grid component reading from `registeredTools` API response; group by category; show tier badges (always-on / auto-detect); toggle switches save to `disabledTools` array; read-only mode when `useGlobalSettings: true` with "Inherited" badges — reference `specs/settings/spec.md:199-248`
- [ ] 6.9 Write tests for settings API: GET returns both old and new fields + `registeredTools`; PUT accepts old boolean format; PUT accepts new array format; PUT rejects invalid tool names (400); PUT translates between formats bidirectionally — reference `specs/settings/spec.md:121-165`

---

## Phase 7: CLI Update — Flags, Deprecations, Config File

> **Goal**: Add `--disable-tool`, `--enable-tool`, `--list-tools` flags. Deprecate `--no-semgrep`/`--no-trivy`/`--no-cpd` with warnings.
- [ ] 7.1 Modify `apps/cli/src/index.ts`: add `--disable-tool <name>` (repeatable), `--enable-tool <name>` (repeatable), `--list-tools` options to the `review` command; keep `--no-semgrep`/`--no-trivy`/`--no-cpd` as hidden deprecated aliases — reference `specs/cli/spec.md:9-86`
- [ ] 7.2 Modify `apps/cli/src/commands/review.ts` `ReviewOptions` interface: add `disableTools: string[]` and `enableTools: string[]` fields — reference `specs/cli/spec.md:125-145`
- [ ] 7.3 Modify `apps/cli/src/commands/review.ts` `mergeSettings()`: map `disableTools` → `ReviewSettings.disabledTools`, `enableTools` → `ReviewSettings.enabledTools`; translate deprecated `--no-semgrep` → `disabledTools: ['semgrep']` with deprecation warning printed to stderr; `--disable-tool` takes precedence over `--enable-tool` for same tool — reference `specs/cli/spec.md:140-145` and `specs/cli/spec.md:62-67`
- [ ] 7.4 Implement `--list-tools` handler: print table (Name, Category, Tier, Version) from `toolRegistry.getAll()`; support `--format json` for JSON array output; exit 0 without running review — reference `specs/cli/spec.md:69-86`
- [ ] 7.5 Add deprecation warnings: when `--no-semgrep`, `--no-trivy`, or `--no-cpd` is used, print `Warning: --no-{tool} is deprecated. Use --disable-tool {tool} instead.` before proceeding — reference `specs/cli/spec.md:92-123`
- [ ] 7.6 Add unknown tool name validation: when `--disable-tool nonexistent` is used, print `Warning: Unknown tool "nonexistent". Known tools: semgrep, trivy, ...` and proceed (non-blocking) — reference `specs/cli/spec.md:30-33`
- [ ] 7.7 Modify `apps/cli/src/commands/review.ts` `GhaggaConfig` interface: add `disabledTools?: string[]` and `enabledTools?: string[]`; merge config file values with CLI flags (CLI takes precedence) — reference `specs/cli/spec.md:147-171`
- [ ] 7.8 Modify `apps/cli/src/ui/theme.ts`: change `SOURCE_LABELS` from hardcoded map to dynamically generated from registry `getAll()` — reference `design.md:227`
- [ ] 7.9 Modify `apps/cli/src/ui/format.ts`: render all tool sources dynamically instead of hardcoded `['semgrep', 'trivy', 'cpd', 'ai']`; show tool status summary (name, status, findings count, time) in review output — reference `design.md:228` and `specs/cli/spec.md:189-205`
- [ ] 7.10 Modify verbose progress handler: when `--verbose`, log activated tools with reasons (always-on, auto-detect: *.py, force-enabled) and skipped tools — reference `specs/cli/spec.md:173-187`
- [ ] 7.11 Write tests for CLI flags: `--disable-tool gitleaks` → gitleaks absent; `--no-semgrep` → deprecation warning + semgrep disabled; `--list-tools` → 15 tools listed; `--disable-tool unknown` → warning but not error; `--enable-tool ruff --disable-tool ruff` → ruff disabled — reference `specs/cli/spec.md` scenarios

---

## Phase 8: Action & Runner Update

> **Goal**: Wire up the action entry point and runner template to use the registry-driven orchestrator.
- [ ] 8.1 Modify `apps/action/src/index.ts`: read new inputs `enabled-tools` and `disabled-tools` (comma-separated strings); parse into `string[]`; pass to `runLocalAnalysis()` alongside existing boolean flags; keep reading `enable-semgrep`/`enable-trivy`/`enable-cpd` for backward compat — reference `design.md:218` and `design.md:229`
- [ ] 8.2 Modify `apps/action/src/tools/types.ts`: re-export `ToolName` from `packages/core` (replacing local `'semgrep' | 'trivy' | 'cpd'` literal type); keep `TOOL_VERSIONS` for backward compat — reference `design.md:216`
- [ ] 8.3 Modify `apps/action/src/tools/cache.ts`: make `CACHE_PATHS` dynamic based on registered `ToolDefinition.cachePaths` instead of hardcoded tool-specific paths — reference `design.md:217`
- [ ] 8.4 Modify `action.yml`: add `enabled-tools` and `disabled-tools` inputs (type: string, default: ''); deprecate `enable-semgrep`, `enable-trivy`, `enable-cpd` in descriptions — reference `design.md:229`
- [ ] 8.5 Modify `packages/core/src/pipeline.ts`: update `runStaticAnalysisSafe()` to pass `enabledTools`/`disabledTools` from settings; update step 7 finding merge to use `Object.values(result)` instead of hardcoded semgrep/trivy/cpd; update `createStaticOnlyResult()` and `createSkippedResult()` to use dynamic tool list — reference `design.md:208`
- [ ] 8.6 Modify `packages/core/src/format.ts`: generate `SOURCE_LABELS` from registry; render dynamic sources in `formatReviewComment()` — reference `design.md:209`
- [ ] 8.7 Write integration test for action orchestrator: mock `ActionsExecutionContext`, register all 15 plugins, verify `runLocalAnalysis()` with `GHAGGA_TOOL_REGISTRY=true` produces correct `StaticAnalysisResult` shape with expected tool entries

---

## Phase 9: Verification & Cleanup

> **Goal**: Full test suite pass, lint clean, manual smoke test on all distribution modes.
- [ ] 9.1 Run full test suite: `pnpm test` across all packages — all existing tests must pass without modification; new tests must pass
- [ ] 9.2 Run lint: `pnpm lint:fix` across the monorepo — ensure no lint errors from new code
- [ ] 9.3 Run TypeScript type-check: `pnpm typecheck` — verify no type errors from the `StaticAnalysisResult` intersection type change or `FindingSource` extension
- [ ] 9.4 Manual smoke test — CLI mode: run `ghagga review --list-tools` (verify 15 tools listed); run `ghagga review --disable-tool gitleaks` on a test repo; run `ghagga review --no-semgrep` and verify deprecation warning
- [ ] 9.5 Manual smoke test — Action mode: trigger a test workflow with `GHAGGA_TOOL_REGISTRY=true` on a multi-language repo; verify all activated tools appear in the review comment
- [ ] 9.6 Verify feature flag backward compat: run with `GHAGGA_TOOL_REGISTRY` unset or `false` — confirm the old 3-tool hardcoded path executes identically to pre-change behavior
- [ ] 9.7 Verify DB migration: on a test database with existing repos that have `enableSemgrep: false`, run migration and confirm `disabledTools: ['semgrep']` is backfilled correctly

---

## Dependency Graph

```
Phase 1 (Foundation)
  └── Phase 2 (Migrate 3 existing tools)
        ├── Phase 3 (4 new always-on tools)
        │     └── Phase 4 (Python + Go auto-detect)
        │           └── Phase 5 (JS/TS + Java + PHP + Rust + Docker)
        ├── Phase 6 (Settings migration) ← can start after Phase 2
        ├── Phase 7 (CLI update) ← can start after Phase 2
        └── Phase 8 (Action/Runner update) ← needs Phase 5 complete
              └── Phase 9 (Verification) ← needs all phases complete
```

> **Parallelism opportunity**: Phases 3-5 (tool plugins), Phase 6 (settings), and Phase 7 (CLI) can be developed in parallel after Phase 2 is complete, by different developers or in separate branches.
