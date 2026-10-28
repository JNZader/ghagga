# Proposal: Extensible Static Analysis — From 3 Hardcoded Tools to 15 via Plugin Registry

## Intent

GHAGGA's core value is offloading mechanical detection to static tools so the LLM focuses on high-level logic, design, and business concerns. Today only 3 tools (Semgrep, Trivy, CPD) are hardcoded across ~9 files in 4 packages. Adding a single tool requires touching types, orchestrator, runner, parsers, settings, DB schema, API routes, dashboard UI, and CLI flags — a prohibitive cost.

This change introduces a **tool registry pattern** with auto-detection, making it trivial to add tools. The goal is to expand from 3 to 15 tool activations (7 always-on + 8 language-specific auto-detect) without any architecture regressions.

## Scope

### In Scope

1. **Refactor `StaticAnalysisResult`** from closed interface (`{ semgrep, trivy, cpd }`) to extensible `Record<ToolName, ToolResult>` with backward-compatible accessors
2. **Tool registry pattern** — each tool is a self-contained plugin: name, tier (always-on / auto-detect), detect function, install command, run command, parse function
3. **Auto-detect in runner** — scan PR changed-file extensions, activate only matching tools
4. **On-demand install** — tools downloaded at runtime only when activated (not pre-baked in Docker)
5. **Time-budget manager** — 10-min total budget, fair-share allocation per tool, graceful timeout
6. **Add 12 new tool plugins** (7 always-on total, 8 auto-detect activations):
   - **Always-on (new):** Gitleaks (secrets), ShellCheck (shell), markdownlint-cli2 (markdown), Lizard (complexity)
   - **Auto-detect:** Ruff + Bandit (Python), golangci-lint (Go), Biome (JS/TS), PMD full (Java), Psalm (PHP), clippy (Rust), Hadolint (Dockerfile)
7. **Replace `enableSemgrep`/`enableTrivy`/`enableCpd` booleans** with `enabledTools: string[]` and `disabledTools: string[]` in settings/DB
8. **Update CLI flags** from `--no-semgrep`/`--no-trivy` to `--disable-tool <name>` and `--enable-tool <name>`
9. **Update dashboard settings UI** to show tool grid with enable/disable toggles
10. **Update runner template** (`JNZader/ghagga-runner-template`) with auto-detect workflow

### Out of Scope

- **Custom user-provided tools** — users cannot register arbitrary tools (future work)
- **Tool result caching across PRs** — each PR runs tools fresh
- **Docker pre-baked images** — tools remain installed on-demand
- **New LLM agent specializations** — existing specialists unchanged
- **Parallel execution across tools** — sequential execution kept for memory safety (7GB / 2 CPUs); parallelism deferred to future profiling
- **SARIF upload to GitHub Security tab** — future enhancement
- **Dashboard per-tool analytics** — future enhancement

## Approach

### Architecture: Plugin Registry

```
packages/core/src/tools/registry.ts    ← ToolDefinition interface + registry
packages/core/src/tools/plugins/       ← One file per tool (semgrep.ts, gitleaks.ts, ...)
packages/core/src/tools/detect.ts      ← File-extension auto-detection
packages/core/src/tools/budget.ts      ← Time-budget allocator
```

Each tool implements:
```typescript
interface ToolDefinition {
  name: ToolName; // e.g., 'gitleaks'
  displayName: string; // e.g., 'Gitleaks'
  tier: 'always-on' | 'auto-detect';
  detect?: (files: string[]) => boolean; // for auto-detect tier
  install: (cacheDir: string) => Promise<void>;
  run: (repoDir: string, timeout: number) => Promise<RawToolOutput>;
  parse: (raw: RawToolOutput) => ReviewFinding[];
  version: string; // pinned version
  outputFormat: 'json' | 'sarif' | 'xml' | 'text';
}
```

### Migration: Backward Compatibility

1. `StaticAnalysisResult` becomes `Record<ToolName, ToolResult>` with a type guard that ensures `semgrep`, `trivy`, `cpd` keys always exist (preserving existing consumer code)
2. DB migration: add `enabled_tools` JSONB column with default `['semgrep','trivy','cpd','gitleaks','shellcheck','markdownlint','lizard']`, keep old boolean columns as deprecated aliases during migration window
3. API: old `enableSemgrep`/`enableTrivy`/`enableCpd` fields remain readable but write to the new `enabledTools` array
4. Runner callback: server accepts any `Record<string, ToolResult>` shape, validates tool names against known registry

### Execution Model

- **Sequential** within the runner (memory safety on 2-CPU / 7GB runner)
- **Time budget**: 10 min total, divided equally among activated tools, minimum 30s per tool
- **Graceful timeout**: tool killed after its share, result = `{ status: 'error', error: 'timeout' }`
- **Isolation**: one tool failure does not affect others (existing pattern preserved)

### Tool Tiers

| Tier        | Activation    | Tools                                                                                                                                        |
| ----------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Always-on   | Every PR      | Semgrep, Trivy (+license), CPD, Gitleaks, ShellCheck, markdownlint-cli2, Lizard                                                              |
| Auto-detect | File presence | Ruff+Bandit (_.py), golangci-lint (go.mod), Biome (_.ts/js/jsx/tsx), PMD (_.java), Psalm (_.php), clippy (Cargo.toml), Hadolint (Dockerfile) |

### Distribution Mode Impact

| Mode               | Impact                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| **SaaS (server)**  | Receives extended `StaticAnalysisResult` from runner callback; settings API exposes tool grid             |
| **GitHub Action**  | Runner installs + executes tools via registry; orchestrator uses registry loop instead of hardcoded calls |
| **CLI**            | Uses `packages/core` runner with registry; `--disable-tool` / `--enable-tool` flags                       |
| **1-click deploy** | Runner template updated with auto-detect workflow                                                         |

## Affected Areas

| Area                                          | Impact         | Description                                                                                    |
| --------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`                  | Modified       | `StaticAnalysisResult` → `Record<ToolName, ToolResult>`, `ReviewSettings` tool fields          |
| `packages/core/src/tools/`                    | Modified + New | Add `registry.ts`, `detect.ts`, `budget.ts`, `plugins/` directory with 15 tool files           |
| `packages/core/src/tools/runner.ts`           | Modified       | Replace hardcoded tool calls with registry-driven loop                                         |
| `packages/core/src/pipeline.ts`               | Modified       | Update `createStaticOnlyResult` and `formatStaticAnalysisContext` to iterate over dynamic keys |
| `packages/core/src/index.ts`                  | Modified       | Export new types and registry                                                                  |
| `apps/action/src/tools/`                      | Modified       | Orchestrator uses registry; individual tool files become plugin implementations                |
| `apps/action/src/tools/types.ts`              | Modified       | `ToolName` becomes union from registry, not hardcoded literal                                  |
| `apps/action/src/tools/orchestrator.ts`       | Modified       | Loop over registry instead of hardcoded `executeSemgrep`/`executeTrivy`/`executeCpd`           |
| `apps/server/src/routes/runner-callback.ts`   | Modified       | Accept `Record<string, ToolResult>` payload                                                    |
| `apps/server/src/routes/api/settings.ts`      | Modified       | `enabledTools`/`disabledTools` instead of per-tool booleans                                    |
| `apps/server/src/routes/api/installations.ts` | Modified       | Settings shape change                                                                          |
| `apps/server/src/inngest/review.ts`           | Modified       | Tool-enable check uses `enabledTools` array                                                    |
| `apps/server/src/inngest/client.ts`           | Modified       | Event data type update                                                                         |
| `apps/cli/src/index.ts`                       | Modified       | Replace `--no-semgrep`/`--no-trivy` with `--disable-tool`/`--enable-tool`                      |
| `apps/cli/src/commands/review.ts`             | Modified       | Settings construction from new flags                                                           |
| `apps/cli/src/ui/theme.ts`                    | Modified       | `SOURCE_LABELS` generated from registry                                                        |
| `apps/cli/src/ui/format.ts`                   | Modified       | Dynamic tool rendering                                                                         |
| `apps/dashboard/`                             | Modified       | Settings page shows tool grid                                                                  |
| `packages/db/src/schema.ts`                   | Modified       | Add `enabled_tools` JSONB, deprecate boolean columns                                           |
| `packages/db/src/queries.ts`                  | Modified       | Migration + new column read/write                                                              |
| `templates/` (runner template)                | Modified       | Auto-detect workflow, on-demand install                                                        |
| `action.yml`                                  | Modified       | New inputs for tool configuration                                                              |

## Risks

| Risk                                                              | Likelihood | Mitigation                                                                                                                               |
| ----------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **10-min budget exceeded** with 15 tools                          | Medium     | Time-budget manager with per-tool caps; always-on tools get priority; auto-detect tools skipped on timeout                               |
| **Memory pressure** from 15 sequential tools                      | Low        | Sequential execution (existing pattern); Semgrep (Python) + CPD/PMD (JVM) are heaviest, never run simultaneously; 7GB runner is generous |
| **Install failures** for new tools on runner                      | Medium     | Each tool install is wrapped in try/catch; failure → `status: 'error'`; review continues with remaining tools                            |
| **Breaking change** for existing `StaticAnalysisResult` consumers | Medium     | Type preserves `semgrep`/`trivy`/`cpd` keys as required; old boolean settings remain as deprecated aliases; DB migration is additive     |
| **Noisy findings** from 15 tools overwhelming LLM context         | Medium     | `formatStaticAnalysisContext` already deduplicates by file:line; add finding-count cap (e.g., 200 max) with severity-priority sorting    |
| **ShellCheck/markdownlint false positives** on non-project files  | Low        | Tools scoped to PR changed files only (not full repo scan)                                                                               |
| **golangci-lint / clippy long compile times**                     | Medium     | These tools may need warm-up; budget allocator gives them larger time shares; detect function verifies build toolchain exists            |
| **DB migration on existing deployments**                          | Low        | Additive migration (new column with default); old columns kept for backward compat; one-time backfill script                             |

## Rollback Plan

1. **Type-level**: `StaticAnalysisResult` type alias can be reverted to closed interface; all existing tests use the 3 hardcoded keys
2. **Registry**: if registry pattern fails, revert to direct imports (existing orchestrator pattern); registry is additive, not destructive
3. **DB**: `enabled_tools` column is additive; old boolean columns remain functional throughout migration window; rollback = drop new column + restore boolean reads
4. **Runner template**: user's fork can pin to previous template version via git tag
5. **Settings API**: backward-compatible response shape means old dashboard versions continue working
6. **Feature flag**: add `GHAGGA_TOOL_REGISTRY=true` env var; when false, fall back to hardcoded 3-tool path. Remove flag after stabilization.

## Dependencies

- All 12 new tools must be free and available as CLI binaries
- ShellCheck is pre-installed on GitHub Actions runners (verified)
- Trivy license scanning requires only `--scanners license` flag (zero new install)
- PMD is already installed (for CPD); expanding to full PMD ruleset is config-only
- Runner template repo (`JNZader/ghagga-runner-template`) must be updated after core changes

## Success Criteria

- [ ] `StaticAnalysisResult` is `Record<ToolName, ToolResult>` — no hardcoded tool keys in type definition
- [ ] Adding a new tool requires creating ONE file (`packages/core/src/tools/plugins/<tool>.ts`) and registering it — zero changes to orchestrator, types, settings, or API routes
- [ ] All 7 always-on tools execute successfully on the GitHub Actions runner within 10-min budget
- [ ] Auto-detect correctly activates language-specific tools (e.g., Python repo triggers Ruff + Bandit, Go repo triggers golangci-lint)
- [ ] Auto-detect correctly skips tools when their language is not present in the PR
- [ ] All existing tests pass without modification (backward compatibility)
- [ ] DB migration is non-destructive — existing deployments upgrade seamlessly
- [ ] Old `enableSemgrep`/`enableTrivy`/`enableCpd` API fields continue working (deprecated but functional)
- [ ] CLI `--disable-tool gitleaks` correctly disables a single tool
- [ ] Dashboard settings page shows all registered tools with toggle switches
- [ ] Tool timeout is graceful — a stuck tool does not block the entire review
- [ ] Finding count does not overwhelm LLM context (capped + severity-sorted)
- [ ] All 4 distribution modes (SaaS, Action, CLI, 1-click) work with the new architecture
