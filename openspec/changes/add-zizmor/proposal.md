# Proposal: Add zizmor — GitHub Actions Security Analysis

## Status
Draft

## Problem

GHAGGA currently runs 15 static analysis tools covering security (semgrep, trivy, gitleaks, bandit), quality (shellcheck, biome, pmd, psalm, markdownlint, hadolint, clippy), complexity (lizard), duplication (cpd), and linting (ruff, golangci-lint). However, **no tool analyzes GitHub Actions workflow files for security vulnerabilities**.

This is a significant blind spot. GitHub Actions workflows are a prime attack surface:
- **Template injection** via `${{ }}` expressions in `run:` blocks can lead to arbitrary code execution
- **Unpinned actions** (using `@main` or `@v1` tags instead of SHA pins) allow supply-chain attacks
- **Excessive permissions** (`permissions: write-all`) violate principle of least privilege
- **Credential leaks** through exposed secrets in workflow outputs or logs
- **Impostor commits** from actions that don't verify commit authorship

Repositories reviewed by GHAGGA routinely contain `.github/workflows/*.yml` files, yet these receive zero security analysis. For a tool that positions itself as a comprehensive code review system, this gap undermines user trust in its security coverage.

## Goal

Integrate [zizmor](https://github.com/zizmorcore/zizmor) as the 16th tool plugin in GHAGGA's analysis pipeline, following the established `ToolDefinition` pattern. Zizmor is a purpose-built GitHub Actions security analyzer (Rust, MIT, v1.23.1, 3.8k stars, backed by Grafana Labs and Trail of Bits) that detects workflow-level security issues invisible to general-purpose SAST tools like semgrep.

After integration:
- GHAGGA automatically detects and analyzes `.github/workflows/*.yml` files
- Security findings from workflow files appear in reviews alongside existing tool results
- Users can enable/disable zizmor via the existing `enabledTools`/`disabledTools` config

## Approach

Zizmor integrates as an **auto-detect tier** plugin, following the exact same pattern used by hadolint (Dockerfiles) and shellcheck (shell scripts). The implementation touches these layers:

### 1. Type Registration
Add `'zizmor'` to the `ToolName` union type in `packages/core/src/tools/types.ts` (line 15-30). This is the same union that currently lists all 15 tools.

### 2. Plugin Implementation
Create `packages/core/src/tools/plugins/zizmor.ts` implementing `ToolDefinition` (interface at `packages/core/src/tools/types.ts:97-138`):

- **`name`**: `'zizmor'`
- **`category`**: `'security'` (same as semgrep, trivy, gitleaks, bandit)
- **`tier`**: `'auto-detect'` — activates when `.github/workflows/*.yml` or `.github/workflows/*.yaml` files are present in the changed file list
- **`detect(files)`**: Matches `**/.github/workflows/*.{yml,yaml}` patterns
- **`install(ctx)`**: Downloads the standalone Rust binary from GitHub releases, with cache support via `ctx.cacheRestore`/`ctx.cacheSave` (same pattern as hadolint at `hadolint.ts:84-105`)
- **`run(ctx, repoDir, files, timeout)`**: Executes `zizmor --format sarif <workflow-files>` with `allowExitCodes: [1]` for findings-present exit code
- **`parse(raw, repoDir)`**: Parses SARIF output into `ReviewFinding[]` with severity mapping to GHAGGA's `FindingSeverity` (`critical | high | medium | low | info` at `types.ts:164`)
- **`outputFormat`**: `'sarif'` — zizmor's SARIF output is structured and well-documented, making it the most reliable format for parsing
- **`version`**: `'1.23.1'` (current stable)

### 3. Registry Registration
Import and add `zizmorPlugin` to the `DEFAULT_PLUGINS` array in `packages/core/src/tools/plugins/index.ts` (line 35-55), as a Phase 6 auto-detect tool.

### 4. Severity Mapping
Map zizmor's SARIF severity levels to GHAGGA's `FindingSeverity`:
- `error` → `high`
- `warning` → `medium`
- `note` → `info`
- `none` → `low`

Use `'critical'` for zizmor rules known to indicate direct code execution risk (e.g., template injection).

### 5. Tests
Create `packages/core/src/tools/plugins/__tests__/zizmor.test.ts` following the hadolint test pattern (`__tests__/hadolint.test.ts`):
- Plugin metadata validation
- `detect()` function with positive/negative cases
- Severity mapping
- SARIF parse with fixture data (`__tests__/fixtures/zizmor-output.json`)
- Edge cases: empty output, malformed JSON, timeout

### 6. Activation Flow
No changes needed to the resolver (`packages/core/src/tools/resolve.ts`) or orchestrator (`packages/core/src/tools/orchestrator.ts`). The existing auto-detect flow (resolve.ts:50-55) automatically picks up any registered tool with `tier: 'auto-detect'` and a `detect()` function. The orchestrator's sequential install → run → parse loop (orchestrator.ts:51-121) handles failure isolation per tool.

## Scope

### In scope
- New file: `packages/core/src/tools/plugins/zizmor.ts` — plugin implementation
- New file: `packages/core/src/tools/plugins/__tests__/zizmor.test.ts` — unit tests
- New file: `packages/core/src/tools/plugins/__tests__/fixtures/zizmor-output.json` — SARIF fixture
- Modified: `packages/core/src/tools/types.ts` — add `'zizmor'` to `ToolName` union
- Modified: `packages/core/src/tools/plugins/index.ts` — import and register plugin
- Documentation update for the new tool in docs/

### Out of scope
- Custom zizmor rules or rule configuration (use zizmor defaults)
- `.zizmor.yml` config file support (can be added later)
- Scanning non-workflow YAML files (actions, reusable workflows) — focus on `.github/workflows/` only for initial release
- Changes to the orchestrator, resolver, or budget system
- Changes to the reviewer formatting or AI enhance layer
- SARIF upload to GitHub Security tab (separate feature)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| zizmor binary unavailable in CI environment | Medium | Medium | Binary install with cache, same pattern as hadolint; graceful skip on install failure per orchestrator isolation (orchestrator.ts:107-120) |
| SARIF output format changes between zizmor versions | Low | Medium | Pin version (`1.23.1`), validate fixture-based parse tests, SARIF is a standard format |
| False positives in workflow analysis | Medium | Low | Findings are surfaced alongside AI review which can contextualize; users can disable via `disabledTools: ['zizmor']` |
| Large repos with many workflows slow down pipeline | Low | Medium | Per-tool timeout via `TimeBudget` system (budget.ts), only scans changed files |
| Platform compatibility (Rust binary, x86_64/arm64) | Low | Medium | Use multi-platform release assets from zizmor releases; Docker image already runs on x86_64 |

## Acceptance Criteria

1. **Registration**: `toolRegistry.getByName('zizmor')` returns a valid `ToolDefinition` with `category: 'security'` and `tier: 'auto-detect'`
2. **Detection**: Plugin activates when changed files include `.github/workflows/*.yml` or `.github/workflows/*.yaml`; does not activate for other YAML files
3. **Installation**: `install()` downloads and caches the zizmor binary; subsequent runs use cached binary
4. **Execution**: `run()` produces SARIF output for workflow files with security issues; returns empty findings for clean workflows
5. **Parsing**: `parse()` converts SARIF findings to `ReviewFinding[]` with correct severity mapping, file paths (relative to repo root), line numbers, and `source: 'zizmor'`
6. **Isolation**: If zizmor fails (install error, runtime crash, timeout), other tools' findings are unaffected — verified by orchestrator's existing try/catch (orchestrator.ts:69-120)
7. **Config**: Users can disable zizmor via `disabledTools: ['zizmor']` and force-enable it via `enabledTools: ['zizmor']`
8. **Tests pass**: All unit tests pass including metadata, detect, severity mapping, parse (happy path + edge cases), and fixture validation
9. **No regression**: Existing 15 tools continue to work unchanged; `registry.test.ts` passes with updated tool count (16)
