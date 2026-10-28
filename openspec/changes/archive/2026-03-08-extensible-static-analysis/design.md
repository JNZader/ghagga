# Design: Extensible Static Analysis — From 3 Hardcoded Tools to 15 via Plugin Registry

## Technical Approach

Replace the hardcoded 3-tool architecture (Semgrep, Trivy, CPD) spread across `packages/core/src/tools/`, `apps/action/src/tools/`, and `apps/server/` with a **registry-driven plugin pattern** in `packages/core`. Each tool is a self-contained `ToolDefinition` object. The orchestrator discovers tools from the registry, resolves activation (tier + auto-detect + settings overrides), manages time budgets, and aggregates results into an extensible `Record<ToolName, ToolResult>`. All distribution modes (SaaS, Action, CLI, 1-click deploy) consume the same `packages/core` registry.

## Architecture Decisions

### Decision: Tools live in `packages/core`, not `apps/action`

**Choice**: All 15 tool plugins and the registry live in `packages/core/src/tools/plugins/`.

**Alternatives considered**:
1. Keep tools in `apps/action/src/tools/` — action-specific, CLI would need to duplicate or import cross-package.
2. New `packages/tools/` workspace package — additional build/dependency overhead.

**Rationale**: The CLI (`apps/cli`) already imports from `ghagga-core` and runs the pipeline locally via `reviewPipeline()`. The action currently duplicates tool logic between `packages/core/src/tools/` (semgrep.ts, trivy.ts, cpd.ts) and `apps/action/src/tools/` (semgrep.ts, trivy.ts, cpd.ts) — each with slightly different execution strategies (core uses `child_process`, action uses `@actions/exec`). By consolidating into `packages/core`, both action and CLI share the same plugin code. The action wrapper (`apps/action/src/tools/`) becomes a thin shim that calls `packages/core`'s registry-driven runner, passing `@actions/exec` and `@actions/cache` adapters via dependency injection.

### Decision: Execution abstraction layer for install/run

**Choice**: `ToolDefinition.install` and `ToolDefinition.run` receive an `ExecutionContext` object rather than directly calling `child_process` or `@actions/exec`.

**Alternatives considered**:
1. Tools call `child_process` directly — works for CLI, but action needs `@actions/exec` for proper log streaming and output capture.
2. Tools call `@actions/exec` directly — creates a hard dependency on GitHub Actions packages in core.

**Rationale**: The existing codebase already has two parallel implementations: `packages/core/src/tools/semgrep.ts` uses `node:child_process`, while `apps/action/src/tools/semgrep.ts` uses `@actions/exec`. An `ExecutionContext` interface abstracts this:

```typescript
interface ExecutionContext {
  exec(command: string, args: string[], opts: ExecOpts): Promise<RawToolOutput>;
  cacheRestore(tool: string, paths: string[]): Promise<boolean>;
  cacheSave(tool: string, paths: string[]): Promise<void>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
```

The CLI provides a `NodeExecutionContext` (using `child_process`), the action provides an `ActionsExecutionContext` (using `@actions/exec` + `@actions/cache`), and tests provide a `MockExecutionContext`.

### Decision: Sequential execution preserved (no parallelism)

**Choice**: Tools execute sequentially, one at a time.

**Alternatives considered**: Parallel execution with a concurrency limiter (e.g., `p-limit(2)`).

**Rationale**: The proposal explicitly defers parallelism. Runner target is 7GB / 2 CPUs. Semgrep (Python, ~1GB) + CPD/PMD (JVM, ~1.5GB) running simultaneously could exceed memory. Sequential execution matches the existing proven pattern in both `packages/core/src/tools/runner.ts:49-50` and `apps/action/src/tools/orchestrator.ts:39-51`. The time budget allocator handles fair distribution across sequential tools.

### Decision: `StaticAnalysisResult` intersection type for backward compatibility

**Choice**: Use a TypeScript intersection type: `StaticAnalysisResult = LegacyStaticAnalysisResult & Record<string, ToolResult>` where `LegacyStaticAnalysisResult = { semgrep: ToolResult; trivy: ToolResult; cpd: ToolResult }`.

**Alternatives considered**:
1. Pure `Record<ToolName, ToolResult>` — breaks `result.semgrep` type narrowing; callers get `ToolResult | undefined`.
2. Branded type with getters — over-engineered for the migration window.

**Rationale**: The intersection ensures `result.semgrep`, `result.trivy`, `result.cpd` are always typed as `ToolResult` (not `ToolResult | undefined`) while `result.gitleaks` is `ToolResult | undefined`. This preserves type safety in all existing consumers (`pipeline.ts:260-264`, `format.ts:53-58`, `apps/cli/src/ui/format.ts:114`) without code changes. After migration window, the legacy part can be removed, making it pure `Record<ToolName, ToolResult>`.

### Decision: Feature flag gates the entire registry path

**Choice**: `GHAGGA_TOOL_REGISTRY=true` env var. When false/unset, fall back to existing hardcoded 3-tool path.

**Alternatives considered**: Per-tool feature flags — too granular, hard to manage.

**Rationale**: Binary toggle keeps rollout simple. The runner checks the flag once at the top of `runStaticAnalysis()` / `runLocalAnalysis()`. When disabled, existing code path is untouched. When enabled, the registry-driven path runs. This allows safe deployment and instant rollback.

### Decision: `disabledTools` takes precedence over everything

**Choice**: Resolution order: `always-on` → `auto-detect(files)` → `+enabledTools` → `-disabledTools` → `-deprecated booleans` (only when new fields are absent).

**Alternatives considered**: Deprecated booleans having equal priority with new fields — creates ambiguity.

**Rationale**: The spec explicitly states `disabledTools` overrides `always-on` (spec `specs/core/spec.md:190-194`) and new fields take precedence over deprecated booleans (spec `specs/core/spec.md:179-182`). This hierarchy is simple and deterministic. The deprecated boolean flags are only consulted as a fallback when `disabledTools` is undefined/empty, ensuring backward compatibility without conflicts.

### Decision: Tool version pinning in plugin definition, not external config

**Choice**: Each `ToolDefinition` has a `version: string` field. Version bumps require a code change to the plugin file.

**Alternatives considered**: External `tool-versions.json` config file — adds indirection, no clear benefit since tool updates need testing anyway.

**Rationale**: Matches the existing pattern in `apps/action/src/tools/types.ts:20-24` where `TOOL_VERSIONS` is a const object. A plugin file is the single source of truth for everything about a tool. Version changes trigger CI (which validates the tool works). No risk of runtime version mismatches.

### Decision: Shared install for CPD and PMD

**Choice**: PMD plugin's `install` function checks if `/opt/pmd` exists (installed by CPD) and skips download if present. CPD runs first (always-on), PMD runs later (auto-detect, Java only).

**Alternatives considered**: Separate installations — wastes 2 minutes downloading the same PMD zip twice.

**Rationale**: Both tools use the same PMD distribution (v7.8.0). The existing CPD install (`apps/action/src/tools/cpd.ts:90-106`) already downloads PMD to `/opt/pmd`. The PMD plugin simply verifies the binary exists and is functional, falling back to download only if CPD was somehow skipped.

## Data Flow

### Tool Execution Flow

```
                        ┌─────────────────────────────────────────────┐
                        │            ReviewInput                       │
                        │  .settings.disabledTools                     │
                        │  .settings.enabledTools                      │
                        │  .context.fileList                           │
                        └──────────────────┬──────────────────────────┘
                                           │
                                           ▼
                        ┌──────────────────────────────────────────────┐
                        │         resolveActivatedTools()              │
                        │  1. Start: all always-on tools               │
                        │  2. Auto-detect: run detect(files) per tool  │
                        │  3. +enabledTools (force-enable)             │
                        │  4. -disabledTools (force-disable)           │
                        │  5. -deprecated booleans (fallback)          │
                        └──────────────────┬───────────────────────────┘
                                           │
                                           ▼
                        ┌──────────────────────────────────────────────┐
                        │         allocateTimeBudget()                  │
                        │  totalBudget / activatedTools.length          │
                        │  min 30s per tool                            │
                        └──────────────────┬───────────────────────────┘
                                           │
                                           ▼
                       ┌───────────────────────────────────────────────┐
                       │  for (tool of activatedTools) {               │
                       │    try {                                      │
                       │      await tool.install(ctx)                  │
                       │      raw = await tool.run(ctx, budget)        │
                       │      findings = tool.parse(raw)               │
                       │      result[tool.name] = { success, findings }│
                       │    } catch {                                  │
                       │      result[tool.name] = { error }            │
                       │    }                                          │
                       │    rolloverUnusedBudget()                     │
                       │  }                                            │
                       └───────────────────┬───────────────────────────┘
                                           │
                                           ▼
                       ┌───────────────────────────────────────────────┐
                       │  ensureLegacyKeys(result)                     │
                       │  // semgrep, trivy, cpd always present        │
                       │  // missing → { status: 'skipped' }           │
                       └───────────────────┬───────────────────────────┘
                                           │
                                           ▼
                                 StaticAnalysisResult
```

### Settings Flow (SaaS → Runner)

```
  Dashboard UI                      Server API                    DB
  ┌──────────┐     PUT /settings    ┌──────────┐    UPDATE       ┌──────────┐
  │ Tool Grid │ ──────────────────→ │ Validate │ ────────────→   │ repos    │
  │ Toggles   │  { disabledTools:   │ Zod +    │  disabled_tools │ .settings│
  │           │    ['cpd'] }        │ translate │  JSONB column   │ JSONB    │
  └──────────┘                      └──────────┘                 └──────────┘
                                          │
                                          │ on PR webhook
                                          ▼
                                    ┌──────────┐
                                    │ Inngest  │  event.data.settings
                                    │ dispatch │  .disabledTools: ['cpd']
                                    └────┬─────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │ Runner (Action/CLI)   │
                              │ resolveActivatedTools()│
                              └──────────────────────┘
```

### Finding Cap Flow

```
  Tool 1 findings ─┐
  Tool 2 findings ─┤
  ...              ├──→ allFindings[] ──→ sortBySeverity() ──→ slice(0, 200) ──→ LLM context
  Tool N findings ─┘                              │
                                      if total > 200:
                                      append "Showing 200 of {total} findings"
```

## File Changes

| File                                               | Action    | Description                                                                                                                                                                                                                |
| -------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/tools/types.ts`                 | Create    | `ToolDefinition`, `ToolCategory`, `ToolName`, `RawToolOutput`, `ExecutionContext`, `TimeBudget` interfaces                                                                                                                 |
| `packages/core/src/tools/registry.ts`              | Create    | `ToolRegistry` class: `register()`, `getAll()`, `getByName()`, `getByTier()`, `validateAll()`                                                                                                                              |
| `packages/core/src/tools/resolve.ts`               | Create    | `resolveActivatedTools()` — tier + detect + settings override resolution logic                                                                                                                                             |
| `packages/core/src/tools/budget.ts`                | Create    | `allocateTimeBudget()`, `rolloverBudget()` — time budget allocator                                                                                                                                                         |
| `packages/core/src/tools/orchestrator.ts`          | Create    | `runToolsWithRegistry()` — registry-driven sequential execution loop with isolation                                                                                                                                        |
| `packages/core/src/tools/execution.ts`             | Create    | `NodeExecutionContext` — child_process-based context for CLI/server                                                                                                                                                        |
| `packages/core/src/tools/plugins/semgrep.ts`       | Create    | Semgrep `ToolDefinition` — adapted from existing `packages/core/src/tools/semgrep.ts`                                                                                                                                      |
| `packages/core/src/tools/plugins/trivy.ts`         | Create    | Trivy `ToolDefinition` — adapted from `packages/core/src/tools/trivy.ts` + license scanning                                                                                                                                |
| `packages/core/src/tools/plugins/cpd.ts`           | Create    | CPD `ToolDefinition` — adapted from `packages/core/src/tools/cpd.ts`                                                                                                                                                       |
| `packages/core/src/tools/plugins/gitleaks.ts`      | Create    | Gitleaks plugin — secret detection                                                                                                                                                                                         |
| `packages/core/src/tools/plugins/shellcheck.ts`    | Create    | ShellCheck plugin — shell script linting                                                                                                                                                                                   |
| `packages/core/src/tools/plugins/markdownlint.ts`  | Create    | markdownlint-cli2 plugin — Markdown quality                                                                                                                                                                                |
| `packages/core/src/tools/plugins/lizard.ts`        | Create    | Lizard plugin — cyclomatic complexity                                                                                                                                                                                      |
| `packages/core/src/tools/plugins/ruff.ts`          | Create    | Ruff plugin — Python linting (auto-detect)                                                                                                                                                                                 |
| `packages/core/src/tools/plugins/bandit.ts`        | Create    | Bandit plugin — Python security (auto-detect)                                                                                                                                                                              |
| `packages/core/src/tools/plugins/golangci-lint.ts` | Create    | golangci-lint plugin — Go analysis (auto-detect)                                                                                                                                                                           |
| `packages/core/src/tools/plugins/biome.ts`         | Create    | Biome plugin — JS/TS linting (auto-detect)                                                                                                                                                                                 |
| `packages/core/src/tools/plugins/pmd.ts`           | Create    | PMD full plugin — Java quality (auto-detect, shared install with CPD)                                                                                                                                                      |
| `packages/core/src/tools/plugins/psalm.ts`         | Create    | Psalm plugin — PHP analysis (auto-detect)                                                                                                                                                                                  |
| `packages/core/src/tools/plugins/clippy.ts`        | Create    | Clippy plugin — Rust linting (auto-detect)                                                                                                                                                                                 |
| `packages/core/src/tools/plugins/hadolint.ts`      | Create    | Hadolint plugin — Dockerfile linting (auto-detect)                                                                                                                                                                         |
| `packages/core/src/tools/plugins/index.ts`         | Create    | Auto-registers all 15 plugins with the registry                                                                                                                                                                            |
| `packages/core/src/types.ts`                       | Modify    | `StaticAnalysisResult` → intersection type; `FindingSource` → `'ai' \| ToolName`; `ReviewSettings` adds `enabledTools?`, `disabledTools?`; `DEFAULT_SETTINGS` updated                                                      |
| `packages/core/src/tools/runner.ts`                | Modify    | `runStaticAnalysis()` gates on `GHAGGA_TOOL_REGISTRY` flag; new path calls `runToolsWithRegistry()`; `formatStaticAnalysisContext()` iterates `Object.entries()` instead of hardcoded keys; add finding cap (200)          |
| `packages/core/src/pipeline.ts`                    | Modify    | `runStaticAnalysisSafe()` passes new settings fields; step 7 finding merge uses `Object.values()` instead of hardcoded `semgrep`/`trivy`/`cpd`; `createStaticOnlyResult()` + `createSkippedResult()` use dynamic tool list |
| `packages/core/src/format.ts`                      | Modify    | `SOURCE_LABELS` generated from registry; `formatReviewComment()` renders all sources dynamically                                                                                                                           |
| `packages/core/src/index.ts`                       | Modify    | Export new types (`ToolDefinition`, `ToolCategory`, `ToolName`, `RawToolOutput`) and registry                                                                                                                              |
| `packages/core/src/tools/semgrep.ts`               | Deprecate | Keep for backward compat during migration window; `GHAGGA_TOOL_REGISTRY=false` still uses this                                                                                                                             |
| `packages/core/src/tools/trivy.ts`                 | Deprecate | Same as above                                                                                                                                                                                                              |
| `packages/core/src/tools/cpd.ts`                   | Deprecate | Same as above                                                                                                                                                                                                              |
| `apps/action/src/tools/orchestrator.ts`            | Modify    | `runLocalAnalysis()` gates on feature flag; new path creates `ActionsExecutionContext`, calls `runToolsWithRegistry()`                                                                                                     |
| `apps/action/src/tools/execution.ts`               | Create    | `ActionsExecutionContext` — wraps `@actions/exec` + `@actions/cache`                                                                                                                                                       |
| `apps/action/src/tools/types.ts`                   | Modify    | `ToolName` re-exported from `packages/core`; `TOOL_VERSIONS` kept for backward compat                                                                                                                                      |
| `apps/action/src/tools/cache.ts`                   | Modify    | `CACHE_PATHS` becomes dynamic (registered via `ToolDefinition.cachePaths`)                                                                                                                                                 |
| `apps/action/src/index.ts`                         | Modify    | Replace per-tool `enable-*` input reading with `enabled-tools`/`disabled-tools` inputs; pass to `runLocalAnalysis()`                                                                                                       |
| `apps/server/src/github/runner.ts`                 | Modify    | `WorkflowDispatchInputs` and `DispatchParams`: replace `enableSemgrep`/`enableTrivy`/`enableCpd` with `enabledTools`/`disabledTools` string fields                                                                         |
| `apps/server/src/routes/runner-callback.ts`        | Modify    | `CallbackPayload.staticAnalysis` already typed as `StaticAnalysisResult` — no change needed (type widens automatically)                                                                                                    |
| `apps/server/src/routes/api/settings.ts`           | Modify    | `RepoSettingsSchema` adds `enabledTools`, `disabledTools` Zod fields; GET response includes `registeredTools` list; PUT handles translation between old booleans and new arrays                                            |
| `apps/server/src/inngest/client.ts`                | Modify    | `ReviewRequestedData.settings` adds `enabledTools?`, `disabledTools?` fields                                                                                                                                               |
| `apps/server/src/inngest/review.ts`                | Modify    | Pass `enabledTools`/`disabledTools` to runner dispatch                                                                                                                                                                     |
| `packages/db/src/schema.ts`                        | Modify    | `RepoSettings` interface adds `enabledTools?`, `disabledTools?`; `repositories` table: no new columns (stored in existing `settings` JSONB)                                                                                |
| `apps/cli/src/index.ts`                            | Modify    | Add `--disable-tool <name>`, `--enable-tool <name>`, `--list-tools` options; deprecation warnings for `--no-semgrep`/`--no-trivy`/`--no-cpd`                                                                               |
| `apps/cli/src/commands/review.ts`                  | Modify    | `ReviewOptions` adds `disableTools: string[]`, `enableTools: string[]`; `mergeSettings()` maps to `ReviewSettings.disabledTools`/`enabledTools`                                                                            |
| `apps/cli/src/ui/theme.ts`                         | Modify    | `SOURCE_LABELS` generated from registry `getAll().map()`                                                                                                                                                                   |
| `apps/cli/src/ui/format.ts`                        | Modify    | `formatMarkdownResult()` renders all sources dynamically instead of hardcoded `['semgrep', 'trivy', 'cpd', 'ai']`                                                                                                          |
| `action.yml`                                       | Modify    | Add `enabled-tools` and `disabled-tools` inputs; deprecate `enable-semgrep`, `enable-trivy`, `enable-cpd`                                                                                                                  |

## Interfaces / Contracts

### ToolDefinition Interface

```typescript
// packages/core/src/tools/types.ts

export type ToolName =
  | 'semgrep'
  | 'trivy'
  | 'cpd'
  | 'gitleaks'
  | 'shellcheck'
  | 'markdownlint'
  | 'lizard'
  | 'ruff'
  | 'bandit'
  | 'golangci-lint'
  | 'biome'
  | 'pmd'
  | 'psalm'
  | 'clippy'
  | 'hadolint';

export type ToolCategory =
  | 'security'
  | 'quality'
  | 'secrets'
  | 'complexity'
  | 'duplication'
  | 'sca'
  | 'docs'
  | 'linting';

export type ToolTier = 'always-on' | 'auto-detect';

export interface RawToolOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ToolDefinition {
  /** Unique identifier (lowercase kebab-case) */
  name: ToolName;

  /** Human-readable display name for UI */
  displayName: string;

  /** Purpose category */
  category: ToolCategory;

  /** Activation tier */
  tier: ToolTier;

  /** File-based activation (required for auto-detect, optional for always-on) */
  detect?: (files: string[]) => boolean;

  /** Install the tool binary. Receives execution context for DI. */
  install: (ctx: ExecutionContext) => Promise<void>;

  /** Run the tool. Returns raw stdout/stderr/exitCode. */
  run: (
    ctx: ExecutionContext,
    repoDir: string,
    files: string[],
    timeout: number,
  ) => Promise<RawToolOutput>;

  /** Parse raw output into normalized findings. */
  parse: (raw: RawToolOutput, repoDir: string) => ReviewFinding[];

  /** Pinned tool version */
  version: string;

  /** Expected output format (for documentation; parse handles actual parsing) */
  outputFormat: 'json' | 'sarif' | 'xml' | 'text';

  /** Cache paths for binary caching (relative or absolute) */
  cachePaths?: string[];

  /** Expected non-zero exit codes that are NOT errors (e.g., CPD returns 4 on duplications) */
  successExitCodes?: number[];
}
```

### ExecutionContext Interface

```typescript
// packages/core/src/tools/types.ts

export interface ExecOpts {
  timeoutMs: number;
  cwd?: string;
  /** Treat these exit codes as success (in addition to 0) */
  allowExitCodes?: number[];
  /** Environment variables to add/override */
  env?: Record<string, string>;
}

export interface ExecutionContext {
  /** Execute a command and capture output */
  exec(command: string, args: string[], opts: ExecOpts): Promise<RawToolOutput>;

  /** Attempt to restore cached tool binaries. Returns true on hit. */
  cacheRestore(toolName: string, paths: string[]): Promise<boolean>;

  /** Save tool binaries to cache. Non-fatal on failure. */
  cacheSave(toolName: string, paths: string[]): Promise<void>;

  /** Structured logging */
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
```

### ToolRegistry

```typescript
// packages/core/src/tools/registry.ts

export class ToolRegistry {
  private tools = new Map<ToolName, ToolDefinition>();

  /** Register a tool. Validates auto-detect tools have detect function. */
  register(tool: ToolDefinition): void;

  /** Get all registered tools */
  getAll(): ToolDefinition[];

  /** Get tool by name, or undefined */
  getByName(name: ToolName): ToolDefinition | undefined;

  /** Get tools by tier */
  getByTier(tier: ToolTier): ToolDefinition[];

  /** Get registered tool count */
  get size(): number;

  /** Validate all registrations (called once at startup) */
  validateAll(): void;
}

/** Singleton registry instance — populated by plugins/index.ts */
export const toolRegistry: ToolRegistry;
```

### Tool Activation Resolution

```typescript
// packages/core/src/tools/resolve.ts

export interface ToolActivationInput {
  registry: ToolRegistry;
  files: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  /** Deprecated boolean flags (backward compat) */
  enableSemgrep?: boolean;
  enableTrivy?: boolean;
  enableCpd?: boolean;
}

export interface ActivatedTool {
  definition: ToolDefinition;
  reason: 'always-on' | 'auto-detect' | 'force-enabled';
}

/**
 * Resolve which tools should run.
 * Returns activated tools in execution order: always-on first, then auto-detect.
 */
export function resolveActivatedTools(input: ToolActivationInput): ActivatedTool[];
```

### Time Budget

```typescript
// packages/core/src/tools/budget.ts

export interface TimeBudget {
  totalMs: number;
  perToolMs: Map<ToolName, number>;
  minimumPerToolMs: number;
}

/**
 * Allocate time budget across activated tools.
 * totalBudgetMs defaults to 600_000 (10 minutes).
 * minimumPerToolMs defaults to 30_000 (30 seconds).
 *
 * Always-on tools get priority when budget is tight.
 */
export function allocateTimeBudget(
  activatedTools: ActivatedTool[],
  totalBudgetMs?: number,
): TimeBudget;

/**
 * Calculate effective budget for next tool, adding rollover from fast tools.
 */
export function getEffectiveBudget(
  toolName: ToolName,
  budget: TimeBudget,
  elapsedByTool: Map<ToolName, number>,
): number;
```

### Extended StaticAnalysisResult

```typescript
// packages/core/src/types.ts (modified)

/** Legacy keys that are always guaranteed present */
interface LegacyStaticAnalysisResult {
  semgrep: ToolResult;
  trivy: ToolResult;
  cpd: ToolResult;
}

/**
 * Extensible static analysis result.
 * Legacy keys (semgrep, trivy, cpd) are always present for backward compat.
 * Additional tool keys are present when those tools ran.
 */
export type StaticAnalysisResult = LegacyStaticAnalysisResult & Record<string, ToolResult>;

/** Updated FindingSource — any registered tool name or 'ai' */
export type FindingSource = 'ai' | ToolName;
```

### Extended ReviewSettings

```typescript
// packages/core/src/types.ts (modified)

export interface ReviewSettings {
  // Existing fields (preserved)
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  customRules: string[];
  ignorePatterns: string[];
  reviewLevel: ReviewLevel;

  // New fields
  /** Force-enable specific tools (overrides auto-detect) */
  enabledTools?: string[];
  /** Force-disable specific tools (overrides always-on and auto-detect) */
  disabledTools?: string[];
}

export const DEFAULT_SETTINGS: ReviewSettings = {
  enableSemgrep: true,
  enableTrivy: true,
  enableCpd: true,
  enableMemory: true,
  customRules: [],
  ignorePatterns: ['*.md', '*.txt', '.gitignore', 'LICENSE', '*.lock'],
  reviewLevel: 'normal',
  enabledTools: [],
  disabledTools: [],
};
```

### Extended RepoSettings (DB)

```typescript
// packages/db/src/schema.ts (modified)

export interface RepoSettings {
  // Existing fields (preserved)
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  customRules: string[];
  ignorePatterns: string[];
  reviewLevel: 'soft' | 'normal' | 'strict';

  // New fields (stored in existing settings JSONB column)
  enabledTools?: string[];
  disabledTools?: string[];
}
```

### Example Plugin: Gitleaks

```typescript
// packages/core/src/tools/plugins/gitleaks.ts

import type { ToolDefinition, ReviewFinding } from '../types.js';

const GITLEAKS_VERSION = '8.21.2';

export const gitleaksPlugin: ToolDefinition = {
  name: 'gitleaks',
  displayName: 'Gitleaks',
  category: 'secrets',
  tier: 'always-on',
  version: GITLEAKS_VERSION,
  outputFormat: 'json',
  cachePaths: ['/usr/local/bin/gitleaks'],

  async install(ctx) {
    const cached = await ctx.cacheRestore('gitleaks', ['/usr/local/bin/gitleaks']);
    if (cached) {
      try {
        await ctx.exec('gitleaks', ['version'], { timeoutMs: 10_000 });
        return;
      } catch {
        ctx.log('warn', 'Gitleaks cache restored but binary not functional, reinstalling');
      }
    }

    const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
    await ctx.exec('bash', ['-c', `curl -sL ${url} | tar xz -C /usr/local/bin gitleaks`], {
      timeoutMs: 60_000,
    });
    await ctx.exec('gitleaks', ['version'], { timeoutMs: 10_000 });
    await ctx.cacheSave('gitleaks', ['/usr/local/bin/gitleaks']);
  },

  async run(ctx, repoDir, _files, timeout) {
    return ctx.exec(
      'gitleaks',
      [
        'detect',
        '--source',
        repoDir,
        '--report-format',
        'json',
        '--report-path',
        '/tmp/gitleaks.json',
        '--no-git',
        '--exit-code',
        '0',
      ],
      { timeoutMs: timeout, allowExitCodes: [0, 1] },
    );
  },

  parse(raw, _repoDir): ReviewFinding[] {
    if (raw.timedOut) return [];
    try {
      const results = JSON.parse(raw.stdout || '[]') as Array<{
        RuleID: string;
        Description: string;
        File: string;
        StartLine: number;
      }>;
      return results.map((r) => ({
        severity: 'critical' as const,
        category: 'secrets',
        file: r.File,
        line: r.StartLine,
        message: `${r.RuleID}: ${r.Description}`,
        source: 'gitleaks' as const,
      }));
    } catch {
      return [];
    }
  },
};
```

## File Structure

```
packages/core/src/tools/
├── types.ts               ← ToolDefinition, ExecutionContext, RawToolOutput, TimeBudget
├── registry.ts            ← ToolRegistry class + singleton instance
├── resolve.ts             ← resolveActivatedTools() — tier + detect + override resolution
├── budget.ts              ← allocateTimeBudget(), getEffectiveBudget()
├── orchestrator.ts        ← runToolsWithRegistry() — sequential loop with isolation
├── execution.ts           ← NodeExecutionContext (child_process-based, for CLI)
├── plugins/
│   ├── index.ts           ← imports + registers all 15 plugins
│   ├── semgrep.ts         ← always-on, security
│   ├── trivy.ts           ← always-on, SCA (enhanced: +license scanning)
│   ├── cpd.ts             ← always-on, duplication
│   ├── gitleaks.ts        ← always-on, secrets
│   ├── shellcheck.ts      ← always-on, linting (shell)
│   ├── markdownlint.ts    ← always-on, docs
│   ├── lizard.ts          ← always-on, complexity
│   ├── ruff.ts            ← auto-detect, linting (Python)
│   ├── bandit.ts          ← auto-detect, security (Python)
│   ├── golangci-lint.ts   ← auto-detect, linting (Go)
│   ├── biome.ts           ← auto-detect, linting (JS/TS)
│   ├── pmd.ts             ← auto-detect, quality (Java)
│   ├── psalm.ts           ← auto-detect, quality (PHP)
│   ├── clippy.ts          ← auto-detect, linting (Rust)
│   └── hadolint.ts        ← auto-detect, linting (Dockerfile)
├── runner.ts              ← MODIFIED: feature flag gate, finding cap
├── semgrep.ts             ← DEPRECATED: kept for GHAGGA_TOOL_REGISTRY=false path
├── trivy.ts               ← DEPRECATED: kept for GHAGGA_TOOL_REGISTRY=false path
└── cpd.ts                 ← DEPRECATED: kept for GHAGGA_TOOL_REGISTRY=false path

apps/action/src/tools/
├── execution.ts           ← NEW: ActionsExecutionContext (@actions/exec + @actions/cache)
├── orchestrator.ts        ← MODIFIED: feature flag gate → registry path
├── index.ts               ← MODIFIED: re-exports
├── types.ts               ← MODIFIED: ToolName from core
├── cache.ts               ← MODIFIED: dynamic cache paths
├── exec.ts                ← KEPT: used by ActionsExecutionContext
├── semgrep.ts             ← DEPRECATED: kept for feature flag=false path
├── trivy.ts               ← DEPRECATED: kept for feature flag=false path
└── cpd.ts                 ← DEPRECATED: kept for feature flag=false path
```

## Testing Strategy

| Layer       | What to Test                                                        | Approach                                                               |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Unit        | `ToolRegistry` — register, validate, getByTier                      | Pure unit tests; no I/O                                                |
| Unit        | `resolveActivatedTools()` — all 5 resolution steps                  | Parametric tests for each scenario in `specs/runner/spec.md:50-86`     |
| Unit        | `allocateTimeBudget()` — equal split, minimum enforcement, rollover | Parametric tests with edge cases (25 tools, 1 tool, 0 tools)           |
| Unit        | Each plugin's `parse()` function                                    | Fixture-based: sample JSON/XML/text output → expected findings         |
| Unit        | Each plugin's `detect()` function (auto-detect)                     | File list → boolean (per spec scenarios)                               |
| Unit        | Backward compat: `result.semgrep` type access                       | TypeScript compile-time test (type assertion)                          |
| Unit        | `formatStaticAnalysisContext()` with dynamic keys                   | Finding cap at 200, severity sort order                                |
| Integration | Full orchestrator with `MockExecutionContext`                       | 15 plugins installed, run, parsed; verify `StaticAnalysisResult` shape |
| Integration | Feature flag toggle                                                 | `GHAGGA_TOOL_REGISTRY=false` → old 3-tool path; `true` → registry path |
| Integration | Settings migration backward compat                                  | `enableSemgrep: false` → semgrep not in activated tools                |
| E2E         | CLI `--disable-tool gitleaks`                                       | Spawn CLI process, verify gitleaks absent from output                  |
| E2E         | CLI `--list-tools`                                                  | Verify 15 tools listed with name, category, tier, version              |
| E2E         | Action with registry on real runner                                 | GitHub Actions workflow with `GHAGGA_TOOL_REGISTRY=true`               |

## Migration / Rollout

### Phase 1: Feature Flag (deploy with flag off)

1. Deploy all code changes with `GHAGGA_TOOL_REGISTRY` defaulting to `false`
2. Existing behavior is completely preserved — zero user impact
3. Internal testing with flag `true` on test repos

### Phase 2: DB Migration (additive, non-breaking)

The new `enabledTools` and `disabledTools` fields are stored in the **existing** `settings` JSONB column on the `repositories` table. No new columns needed. The JSONB column already stores `RepoSettings` which is extended with optional fields — existing rows simply don't have these keys, which TypeScript treats as `undefined` (default behavior).

Backfill logic (runs once at migration):
```sql
-- Backfill disabled_tools for repos that had tools explicitly disabled
UPDATE repositories
SET settings = settings || jsonb_build_object(
  'disabledTools',
  (
    SELECT jsonb_agg(tool)
    FROM (
      SELECT 'semgrep' AS tool WHERE (settings->>'enableSemgrep')::boolean = false
      UNION ALL
      SELECT 'trivy' WHERE (settings->>'enableTrivy')::boolean = false
      UNION ALL
      SELECT 'cpd' WHERE (settings->>'enableCpd')::boolean = false
    ) disabled
  )
)
WHERE (settings->>'enableSemgrep')::boolean = false
   OR (settings->>'enableTrivy')::boolean = false
   OR (settings->>'enableCpd')::boolean = false;
```

The `installation_settings.settings` JSONB column receives the same treatment.

### Phase 3: Enable for SaaS Users (flag on)

1. Set `GHAGGA_TOOL_REGISTRY=true` in server environment
2. All new reviews use registry path
3. Monitor for regressions via existing review error tracking

### Phase 4: Runner Template Update

1. Update `JNZader/ghagga-runner-template` workflow to:
   - Accept `enabledTools`/`disabledTools` as workflow dispatch inputs (JSON strings)
   - Pass them to the action step
   - Continue to accept deprecated `enableSemgrep`/`enableTrivy`/`enableCpd` for backward compat
2. Users re-sync their fork to get the template update (or auto-sync if configured)

### Phase 5: Dashboard Update

1. Settings page replaces 3 checkboxes with tool grid
2. Tool grid reads `registeredTools` from GET /api/settings response
3. Saves `disabledTools` array via PUT /api/settings

### Phase 6: Cleanup (future, after stabilization)

1. Remove `GHAGGA_TOOL_REGISTRY` feature flag (always use registry)
2. Remove deprecated `packages/core/src/tools/semgrep.ts`, `trivy.ts`, `cpd.ts`
3. Remove deprecated `apps/action/src/tools/semgrep.ts`, `trivy.ts`, `cpd.ts`
4. Remove deprecated `enableSemgrep`/`enableTrivy`/`enableCpd` fields from API
5. Remove `LegacyStaticAnalysisResult` from intersection type

## Open Questions

- [x] Tools in core vs action? **Resolved: core** (shared by action + CLI)
- [x] Sequential vs parallel? **Resolved: sequential** (memory safety on 7GB runner)
- [x] How to handle tools that need compilation (clippy, Psalm)? **Resolved: compilation time counts against tool's time budget; if cargo/php not available, tool returns `status: 'error'` with descriptive message**
- [x] How to handle tool version pinning? **Resolved: pinned in `ToolDefinition.version` field per plugin file**
- [ ] Should `ignorePatterns` from `DEFAULT_SETTINGS` (`['*.md', '*.txt', ...]`) be updated now that markdownlint is always-on? markdownlint would never see findings if `*.md` is in `ignorePatterns`. **Recommendation**: `ignorePatterns` applies to the LLM diff filter, NOT to static analysis tool scoping. Verify this is the current behavior — if so, no change needed. If `ignorePatterns` also filters tool input, markdownlint needs an exemption.
- [ ] Should the finding cap (200) apply globally or per-category? 200 global means a noisy tool (e.g., Ruff on a large Python codebase) could crowd out security findings. **Recommendation**: Global cap of 200 with severity-priority sort ensures critical/high findings from any tool are always included. Per-tool caps add complexity without clear benefit. Monitor after rollout.
