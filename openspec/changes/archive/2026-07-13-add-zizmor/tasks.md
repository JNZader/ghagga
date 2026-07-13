# Tasks: Add zizmor — GitHub Actions Security Analysis

## Status
Ready

## Overview

Add zizmor as the 16th tool plugin in GHAGGA's static analysis pipeline to detect security vulnerabilities in GitHub Actions workflow files. The implementation follows the established `hadolintPlugin` pattern across **8 tasks in 7 phases**, touching 2 existing files and creating 3 new files.

## Task Checklist

### Phase 1: Type Registration

- [ ] **T1: Add `'zizmor'` to `ToolName` union**
  - **File**: `packages/core/src/tools/types.ts` (modify)
  - **Change**: Add `| 'zizmor'` after `| 'hadolint'` on line 30, making the union 16 members
  - **Before** (line 30):
    ```typescript
      | 'hadolint';
    ```
  - **After** (lines 30-31):
    ```typescript
      | 'hadolint'
      | 'zizmor';
    ```
  - **Why first**: This is a type-only change with zero runtime effect. All subsequent tasks depend on `'zizmor'` being a valid `ToolName` — without it, the plugin's `name: 'zizmor'` field would cause a TypeScript compilation error
  - **Verification**: `pnpm tsc --noEmit` passes (no type errors)
  - **Commit**: `feat(tools): add zizmor to ToolName union`

---

### Phase 2: Plugin Implementation

- [ ] **T2: Create zizmor plugin**
  - **File**: `packages/core/src/tools/plugins/zizmor.ts` (new, ~140 lines)
  - **Template**: `hadolintPlugin` at `packages/core/src/tools/plugins/hadolint.ts`
  - **Structure** (following design.md exactly):

    **Constants**:
    - `ZIZMOR_VERSION = '1.23.1'`
    - `ZIZMOR_BIN = '/usr/local/bin/zizmor'`
    - `WORKFLOW_PATTERN = /(^|\/)\.github\/workflows\/[^/]+\.(yml|yaml)$/` — shared by `detect()` and `run()`

    **SARIF type interfaces** (internal, not exported):
    - `SarifLog` → `{ runs?: SarifRun[] }`
    - `SarifRun` → `{ results?: SarifResult[] }`
    - `SarifResult` → `{ ruleId?, level?, message?: { text? }, locations?: SarifLocation[] }`
    - `SarifLocation` → `{ physicalLocation?: { artifactLocation?: { uri? }, region?: { startLine? } } }`
    - All fields optional (`?`) for graceful handling of malformed SARIF

    **Severity mapping**:
    - `SARIF_SEVERITY_MAP: Record<string, FindingSeverity>` — `error→high`, `warning→medium`, `note→info`, `none→low`
    - `CRITICAL_RULES: ReadonlySet<string>` — `new Set(['template-injection'])`
    - `export function mapZizmorSeverity(level: string, ruleId?: string): FindingSeverity` — checks `CRITICAL_RULES.has(ruleId)` first, then falls back to `SARIF_SEVERITY_MAP[level.toLowerCase()] ?? 'low'`

    **Parse function**:
    - `export function parseZizmorOutput(raw: RawToolOutput, repoDir: string): ReviewFinding[]`
    - Returns `[]` on: `raw.timedOut`, empty/malformed JSON, missing `runs`, missing/empty `results`
    - Maps each `SarifResult` to `ReviewFinding` with: `severity` via `mapZizmorSeverity()`, `category: 'security'`, `source: 'zizmor'`, `file` with `repoDir/` prefix stripped, `line` from `startLine`, `message` as `"${ruleId}: ${messageText}"`

    **Plugin definition** (`export const zizmorPlugin: ToolDefinition`):
    - `name: 'zizmor'`, `displayName: 'Zizmor'`, `category: 'security'`, `tier: 'auto-detect'`
    - `version: ZIZMOR_VERSION`, `outputFormat: 'sarif'`, `cachePaths: [ZIZMOR_BIN]`
    - `detect(files)`: `files.some(f => WORKFLOW_PATTERN.test(f))`
    - `install(ctx)`: cache-first flow identical to `hadolintPlugin.install()` (hadolint.ts:84-105) — `cacheRestore` → verify `--version` → on miss: `curl -sL` from GitHub Releases → `chmod +x` → verify → `cacheSave`
    - `run(ctx, _repoDir, files, timeout)`: filter `files` with `WORKFLOW_PATTERN` → early-return `{ stdout: '{}', ... }` if empty → `ctx.exec('zizmor', ['--format', 'sarif', ...workflowFiles], { timeoutMs: timeout, allowExitCodes: [1] })`
    - `parse: parseZizmorOutput`

  - **Imports**: `FindingSeverity`, `ReviewFinding` from `../../types.js`; `ExecutionContext`, `RawToolOutput`, `ToolDefinition` from `../types.js`
  - **Verification**: `pnpm tsc --noEmit` passes; file structure matches hadolint.ts layout
  - **Commit**: `feat(tools): implement zizmor plugin for GitHub Actions security`

---

### Phase 3: Registry Registration

- [ ] **T3: Register zizmor in plugin index**
  - **File**: `packages/core/src/tools/plugins/index.ts` (modify, 4 changes)
  - **Change 1 — Import** (after line 24 `hadolintPlugin` import):
    ```typescript
    import { zizmorPlugin } from './zizmor.js';
    ```
  - **Change 2 — Registration** (after line 54 `hadolintPlugin,`):
    ```typescript
      // Phase 6: auto-detect (CI/CD security)
      zizmorPlugin,
    ```
  - **Change 3 — Header comment update** (add Phase 6 to the docblock at lines 7-10):
    ```typescript
     * Phase 6: zizmor (auto-detect)
    ```
  - **Change 4 — Re-export** (after line 99 `trivyPlugin` export):
    ```typescript
    export { zizmorPlugin } from './zizmor.js';
    ```
  - **Why Phase 6**: Phase 5 groups the original auto-detect batch (biome, pmd, psalm, clippy, hadolint). Zizmor is a distinct later addition. Phase 6 is self-documenting per design.md AD-5
  - **Verification**: `pnpm tsc --noEmit` passes; `toolRegistry.getByName('zizmor')` returns a valid `ToolDefinition` after `initializeDefaultTools()`
  - **Commit**: `feat(tools): register zizmor plugin in tool registry`

---

### Phase 4: Test Fixture

- [ ] **T4: Create SARIF test fixture**
  - **File**: `packages/core/src/tools/plugins/__tests__/fixtures/zizmor-output.json` (new, ~55 lines)
  - **Content**: SARIF v2.1.0 document as specified in design.md (lines 482-558) with:
    - `$schema` and `version: "2.1.0"` fields
    - `runs[0].tool.driver` with `name: "zizmor"`, `version: "1.23.1"`
    - **4 results** covering 4 different rules and 3 SARIF levels:
      1. `ruleId: "template-injection"`, `level: "error"` — targets critical elevation testing
      2. `ruleId: "unpinned-uses"`, `level: "warning"` — standard medium severity
      3. `ruleId: "excessive-permissions"`, `level: "warning"` — second warning-level finding
      4. `ruleId: "artipacked"`, `level: "note"` — info-level finding
    - 2 different workflow files (`/workspace/.github/workflows/ci.yml` and `/workspace/.github/workflows/deploy.yaml`) — validates multi-file path extraction
    - All file URIs prefixed with `/workspace/` — validates `repoDir` stripping in `parse()`
    - Realistic `message.text` values matching actual zizmor output
  - **Verification**: `cat <file> | python3 -m json.tool` confirms valid JSON
  - **Commit**: (included with T5 — test fixture is not meaningful alone)

---

### Phase 5: Tests

- [ ] **T5: Write zizmor plugin tests**
  - **File**: `packages/core/src/tools/plugins/__tests__/zizmor.test.ts` (new, ~200 lines)
  - **Template**: `hadolint.test.ts` at `packages/core/src/tools/plugins/__tests__/hadolint.test.ts`
  - **Imports**: `readFileSync` from `node:fs`, `join` from `node:path`, `describe/expect/it` from `vitest`, `RawToolOutput` from `../../types.js`, `mapZizmorSeverity/parseZizmorOutput/zizmorPlugin` from `../zizmor.js`
  - **Helpers**: `makeRaw(stdout, exitCode?, timedOut?): RawToolOutput` utility, `FIXTURE_PATH`/`FIXTURE_JSON` constants

  - **Test groups** (~34 tests total):

    | Group | Tests | Validates |
    |-------|-------|-----------|
    | `zizmorPlugin metadata` | 6 | `name: 'zizmor'`, `displayName: 'Zizmor'`, `category: 'security'`, `tier: 'auto-detect'`, `version: '1.23.1'`, `outputFormat: 'sarif'` |
    | `zizmorPlugin detect` | 7 | ✅ `.github/workflows/ci.yml`, ✅ `.github/workflows/deploy.yaml`, ✅ `apps/web/.github/workflows/test.yml` (monorepo), ✗ `.github/dependabot.yml`, ✗ `.github/actions/my-action/action.yml`, ✗ `docker-compose.yml`, ✗ `[]` |
    | `mapZizmorSeverity` | 7 | `error→high`, `warning→medium`, `note→info`, `none→low`, `unknown→low`, `template-injection + error → critical` (elevation), `unpinned-uses + warning → medium` (non-critical stays at base) |
    | `parseZizmorOutput` (happy path) | 8 | Finding count (4), critical severity for template-injection, medium for unpinned-uses, `category: 'security'` for all, `source: 'zizmor'` for all, `/workspace/` prefix stripped from file paths, line numbers present, message format `"ruleId: text"` |
    | `parseZizmorOutput` (edge cases) | 6 | Empty SARIF `'{}'`, empty `results: []`, missing `locations` array, malformed JSON, timeout (`timedOut: true`), empty stdout `''` |

  - **Verification**: `pnpm vitest run packages/core/src/tools/plugins/__tests__/zizmor.test.ts` — all 34 tests pass
  - **Commit**: `test(tools): add zizmor plugin test suite`
  - **Note**: T4 (fixture) and T5 (tests) are committed together since the fixture has no value without its tests

---

### Phase 6: Documentation

- [ ] **T6: Update documentation**
  - **Files** (3 modifications):

  - **File 1**: `docs/static-analysis.md`
    - Update tool count: `"15 static analysis tools"` → `"16 static analysis tools"` (line 7)
    - Add table row after Hadolint (line 25):
      ```markdown
      | **Zizmor** | security | auto-detect | GitHub Actions (`.github/workflows/*.yml`) |
      ```
    - Update always-on/auto-detect count: `"8 tools activate"` → `"9 tools activate"` (line 35)
    - Add Zizmor section after Hadolint section (after line 216):
      ```markdown
      ## Zizmor (auto-detect: GitHub Actions)

      GitHub Actions security analyzer that detects workflow-level vulnerabilities — template injection, unpinned actions, excessive permissions, and credential exposure. Activates when `.github/workflows/*.yml` or `.github/workflows/*.yaml` files are in the diff.
      ```

  - **File 2**: `docs/github-action.md`
    - Update tool count reference: `"up to 15 tools"` → `"up to 16 tools"` (line 26)

  - **File 3**: `docs/configuration.md`
    - No structural changes needed — `enabledTools`/`disabledTools` documentation is generic and applies to any registered tool including zizmor

  - **Verification**: Manual review that all tool counts are consistent (16 tools, 7 always-on + 9 auto-detect)
  - **Commit**: `docs: add zizmor to supported tools documentation`

---

### Phase 7: Verification

- [ ] **T7: Run full test suite**
  - **Command**: `pnpm test`
  - **Verify**:
    - All existing tool plugin tests pass unchanged
    - New `zizmor.test.ts` passes (all 34 tests)
    - TypeScript compilation clean (`pnpm tsc --noEmit`)
    - No regressions in resolver, orchestrator, or registry tests
  - **No commit** — verification only

- [ ] **T8: Integration smoke test**
  - **Verify**: zizmor auto-detect works end-to-end:
    1. Call `initializeDefaultTools()` and confirm `toolRegistry.getByName('zizmor')` returns plugin with `category: 'security'`, `tier: 'auto-detect'`
    2. Confirm `zizmorPlugin.detect(['.github/workflows/ci.yml'])` returns `true`
    3. Confirm `zizmorPlugin.detect(['src/app.ts'])` returns `false`
    4. Confirm `parseZizmorOutput()` with fixture data produces 4 findings with correct severity mapping
  - **No commit** — verification only

---

## Dependencies

```
T1 ──→ T2 ──→ T3 ──→ T4+T5 ──→ T6 ──→ T7 ──→ T8
 │      │      │       │         │
 │      │      │       │         └─ docs (independent of tests but after code is final)
 │      │      │       └─ fixture + tests (fixture needed by tests)
 │      │      └─ registry import (needs plugin file to exist)
 │      └─ plugin impl (needs ToolName to include 'zizmor')
 └─ type union (no dependencies, pure type change)
```

All tasks are strictly sequential — each depends on the prior task. T4 and T5 are co-dependent (committed together). T7 and T8 are verification-only (no commits).

## Estimated Effort

| Phase | Tasks | Estimate | Notes |
|-------|-------|----------|-------|
| Phase 1: Type Registration | T1 | 2 min | One-line type union addition |
| Phase 2: Plugin Implementation | T2 | 25 min | Core work — 140 lines, SARIF types + parse + install/run |
| Phase 3: Registry Registration | T3 | 5 min | Import + array entry + export + comment |
| Phase 4: Test Fixture | T4 | 10 min | Craft representative SARIF JSON with 4 findings |
| Phase 5: Tests | T5 | 25 min | ~34 tests across 5 groups, ~200 lines |
| Phase 6: Documentation | T6 | 10 min | Update 2 doc files with counts and new section |
| Phase 7: Verification | T7, T8 | 5 min | Run test suite + smoke test |
| **Total** | **8 tasks** | **~80 min** | 6 commits (T4+T5 combined, T7+T8 no commit) |

## Commit Summary

| Order | Commit Message | Files Changed |
|-------|---------------|---------------|
| 1 | `feat(tools): add zizmor to ToolName union` | `packages/core/src/tools/types.ts` |
| 2 | `feat(tools): implement zizmor plugin for GitHub Actions security` | `packages/core/src/tools/plugins/zizmor.ts` (new) |
| 3 | `feat(tools): register zizmor plugin in tool registry` | `packages/core/src/tools/plugins/index.ts` |
| 4 | `test(tools): add zizmor plugin test suite` | `packages/core/src/tools/plugins/__tests__/zizmor.test.ts` (new), `packages/core/src/tools/plugins/__tests__/fixtures/zizmor-output.json` (new) |
| 5 | `docs: add zizmor to supported tools documentation` | `docs/static-analysis.md`, `docs/github-action.md` |

5 commits total. Each is atomic and independently reviewable.
