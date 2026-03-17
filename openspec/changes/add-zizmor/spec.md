# Spec: Add zizmor — GitHub Actions Security Analysis

## Status
Draft

## Proposal
[proposal.md](./proposal.md)

## Date
2026-03-16

---

## Requirements

### FR-1: Tool Registration

**Add `'zizmor'` to the `ToolName` union type** in `packages/core/src/tools/types.ts` (line 15-30).

```typescript
export type ToolName =
  | 'semgrep'
  | 'trivy'
  // ... existing tools ...
  | 'hadolint'
  | 'zizmor';   // ← new entry
```

**Register the plugin** in `packages/core/src/tools/plugins/index.ts`:
- Import `zizmorPlugin` from `./zizmor.js`
- Add to `DEFAULT_PLUGINS` array as a Phase 6 auto-detect tool (after `hadolintPlugin`)
- Add re-export: `export { zizmorPlugin } from './zizmor.js';`

After registration, `toolRegistry.getByName('zizmor')` MUST return a valid `ToolDefinition` with:
- `name: 'zizmor'`
- `displayName: 'Zizmor'`
- `category: 'security'` (same category as semgrep, trivy, bandit)
- `tier: 'auto-detect'`
- `version: '1.23.1'`
- `outputFormat: 'sarif'`
- `cachePaths: ['/usr/local/bin/zizmor']`

### FR-2: File Detection

The `detect(files: string[]): boolean` function MUST activate zizmor when **any** file in the changed file list matches the pattern `**/.github/workflows/*.{yml,yaml}`.

**Positive matches** (MUST return `true`):
- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yaml`
- `.github/workflows/release-please.yml`
- `some-path/.github/workflows/test.yml` (monorepo subdir)

**Negative matches** (MUST return `false`):
- `.github/dependabot.yml` (not in workflows/)
- `.github/workflows/README.md` (not yml/yaml)
- `src/workflows/build.yml` (not in .github/)
- `docker-compose.yml` (unrelated YAML)
- `.github/actions/my-action/action.yml` (action definition, not workflow)
- Empty file list `[]`

Implementation approach: test each file path against the regex pattern `/(^|\/)\.github\/workflows\/[^/]+\.(yml|yaml)$/`.

### FR-3: Binary Installation

The `install(ctx: ExecutionContext): Promise<void>` function follows the **identical cache-first pattern** used by `hadolintPlugin` (hadolint.ts:84-105) and `gitleaksPlugin` (gitleaks.ts:57-78):

1. **Cache restore**: Call `ctx.cacheRestore('zizmor', [ZIZMOR_BIN])` — if hit, verify with `ctx.exec('zizmor', ['--version'], { timeoutMs: 10_000 })`
2. **Download on cache miss**: Download the pre-built Rust binary from GitHub Releases:
   ```
   https://github.com/woodruffw/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu
   ```
   Save to `/usr/local/bin/zizmor`, `chmod +x`
3. **Verify**: Run `zizmor --version` with 10s timeout
4. **Cache save**: Call `ctx.cacheSave('zizmor', [ZIZMOR_BIN])`

Constants:
- `ZIZMOR_VERSION = '1.23.1'`
- `ZIZMOR_BIN = '/usr/local/bin/zizmor'`

Download timeout: `120_000` ms (same as hadolint/gitleaks).

If cache is restored but binary verification fails, log a warning via `ctx.log('warn', ...)` and re-download (same fallback as hadolint.ts:91).

### FR-4: Execution

The `run(ctx, repoDir, files, timeout): Promise<RawToolOutput>` function:

1. **Filter files**: Extract only workflow files from `files` that match the detect pattern (`/.github/workflows/*.{yml,yaml}`)
2. **Early return**: If no workflow files remain after filtering, return `{ stdout: '{}', stderr: '', exitCode: 0, timedOut: false }` — note: empty SARIF-like stub, not `[]` since output is SARIF
3. **Execute**: Run zizmor with SARIF output:
   ```
   zizmor --format sarif <workflow-file-1> <workflow-file-2> ...
   ```
   Pass individual workflow file paths (not the directory), same pattern as hadolint passing individual Dockerfiles.
4. **Exit codes**: Use `allowExitCodes: [1]` — zizmor returns exit code 1 when findings are present (non-error)
5. **Timeout**: Pass the `timeout` parameter from the orchestrator's `TimeBudget` allocation via `{ timeoutMs: timeout }`
6. **No `--offline` flag**: zizmor runs offline by default when given local files; no network calls during analysis
7. **Working directory**: Not required — workflow files are passed as absolute paths

### FR-5: Finding Normalization

The `parse(raw: RawToolOutput, repoDir: string): ReviewFinding[]` function parses SARIF v2.1.0 output into `ReviewFinding[]`.

#### SARIF Structure

zizmor outputs standard SARIF v2.1.0. The relevant path is:
```
root.runs[0].results[] → each result is one finding
```

Each SARIF result contains:
- `ruleId: string` — the zizmor rule identifier (e.g., `artipacked`, `template-injection`, `unpinned-uses`)
- `level: 'error' | 'warning' | 'note' | 'none'` — SARIF severity level
- `message.text: string` — human-readable description
- `locations[0].physicalLocation.artifactLocation.uri: string` — file path
- `locations[0].physicalLocation.region.startLine: number` — line number

#### SARIF → ReviewFinding Mapping

| SARIF Field | ReviewFinding Field | Transform |
|-------------|-------------------|-----------|
| `ruleId` | (included in `message`) | Prefix: `"${ruleId}: ${message.text}"` |
| `level` | `severity` | See severity mapping below |
| `message.text` | `message` | Combined with ruleId |
| `locations[0]...uri` | `file` | Strip `repoDir/` prefix, same as hadolint |
| `locations[0]...startLine` | `line` | Direct map, `undefined` if absent |
| (constant) | `category` | `'security'` |
| (constant) | `source` | `'zizmor'` |

#### Severity Mapping

Export function `mapZizmorSeverity(level: string, ruleId?: string): FindingSeverity`:

| SARIF `level` | `FindingSeverity` | Rationale |
|---------------|-------------------|-----------|
| `'error'` | `'high'` | Serious security issue |
| `'warning'` | `'medium'` | Moderate security concern |
| `'note'` | `'info'` | Informational / best practice |
| `'none'` | `'low'` | Minimal impact |
| (unknown) | `'low'` | Safe default |

**Critical rule elevation**: For rules in the `CRITICAL_RULES` set, override the mapped severity to `'critical'` regardless of SARIF level. Initial critical rules:
- `template-injection` — direct code execution risk via `${{ }}` in `run:` blocks

This matches the proposal's guidance (proposal.md:58) and can be extended later.

#### Edge Cases in Parsing

- **`raw.timedOut === true`**: Return `[]` immediately (same as all existing plugins)
- **Empty stdout or `'{}'`**: Return `[]`
- **Malformed JSON**: Catch parse error, return `[]` (same pattern as hadolint.ts:63-65)
- **Missing `runs` array**: Return `[]`
- **Missing `results` array**: Return `[]`
- **Result missing `locations`**: Produce finding with `line: undefined` and `file: 'unknown'`
- **Multiple `runs`**: Only process `runs[0]` (standard for single-tool SARIF)

### FR-6: Configuration

Zizmor integrates with the existing `enabledTools`/`disabledTools` mechanism in `ReviewSettings` (types.ts:142-144) via the resolver (resolve.ts).

**No changes needed to the resolver or orchestrator**. The existing flow at `resolve.ts:50-55` automatically picks up any registered tool with `tier: 'auto-detect'` and a `detect()` function.

Behaviors:
- **Default**: zizmor activates automatically when workflow files are detected (auto-detect tier)
- **Force-disable**: `disabledTools: ['zizmor']` prevents activation even if workflow files are present (resolve.ts:70-74)
- **Force-enable**: `enabledTools: ['zizmor']` activates zizmor even if no workflow files are in the diff (resolve.ts:57-67)
- **Not affected by legacy flags**: `enableSemgrep`, `enableTrivy`, `enableCpd` booleans have no effect on zizmor (resolve.ts:80-91)

### FR-7: Error Handling

Zizmor failures are isolated by the orchestrator's existing try/catch at `orchestrator.ts:69-120`. Specific failure modes:

| Failure | Source | Behavior |
|---------|--------|----------|
| Binary download fails | `install()` throws | Orchestrator catches, records `status: 'error'`, continues other tools |
| Binary not functional after cache restore | `install()` re-downloads | Warning logged, re-download attempted |
| zizmor crashes at runtime | `run()` throws | Orchestrator catches, records `status: 'error'` |
| Timeout exceeded | `run()` returns `timedOut: true` | Orchestrator records `status: 'error', error: 'timeout'` (orchestrator.ts:77-89) |
| SARIF parse failure | `parse()` catches internally | Returns `[]`, finding count is 0, `status: 'success'` |
| Budget exhausted before zizmor runs | Orchestrator skips | Records `status: 'skipped', error: 'total-budget-exhausted'` (orchestrator.ts:55-64) |

**Principle**: A zizmor failure MUST NEVER prevent other tools from running or cause the pipeline to crash. This is guaranteed by the orchestrator's per-tool isolation — no changes to the orchestrator are required.

---

## Scenarios

### SC-1: Happy path — workflow files present, findings produced

**Given** a PR touches `.github/workflows/ci.yml` which contains `${{ github.event.issue.body }}` in a `run:` block
**And** zizmor is not in `disabledTools`
**When** the tool resolver runs auto-detect (resolve.ts:50-55)
**Then** zizmor is activated with `reason: 'auto-detect'`
**And** `install()` downloads or restores the cached binary
**And** `run()` executes `zizmor --format sarif .github/workflows/ci.yml`
**And** `parse()` produces `ReviewFinding[]` with at least one finding where:
  - `severity` is `'critical'` (template-injection rule)
  - `category` is `'security'`
  - `source` is `'zizmor'`
  - `file` is `.github/workflows/ci.yml` (relative, no repo prefix)
  - `line` is a positive integer
  - `message` contains the rule ID and description

### SC-2: No workflow files in diff

**Given** a PR only touches `src/app.ts`, `package.json`, and `README.md`
**When** the tool resolver runs auto-detect
**Then** `detect([...files])` returns `false`
**And** zizmor is NOT included in `ActivatedTool[]`
**And** no zizmor execution occurs
**And** no `'zizmor'` key exists in `StaticAnalysisResult` unless force-enabled

### SC-3: Zizmor disabled via config

**Given** a PR touches `.github/workflows/ci.yml`
**And** `disabledTools` includes `'zizmor'`
**When** the resolver runs
**Then** `detect()` returns `true` but the resolver removes zizmor at step 4 (resolve.ts:70-74)
**And** zizmor does NOT run
**And** all other tools operate normally

### SC-4: Zizmor binary not available

**Given** zizmor is activated
**And** the GitHub Releases download URL is unreachable (network error, 404, etc.)
**And** no cached binary exists
**When** `install(ctx)` is called
**Then** `install()` throws an error
**And** the orchestrator catches it (orchestrator.ts:107-120)
**And** `results['zizmor']` is `{ status: 'error', findings: [], error: '<message>' }`
**And** all other tools continue running

### SC-5: Zizmor produces empty results (clean workflow)

**Given** a PR touches `.github/workflows/ci.yml` which follows all security best practices
**And** zizmor finds no issues
**When** `run()` executes
**Then** zizmor returns exit code 0 and SARIF output with empty `results: []`
**And** `parse()` returns `[]`
**And** `results['zizmor']` is `{ status: 'success', findings: [], executionTimeMs: <n> }`

### SC-6: SARIF parse error

**Given** zizmor runs successfully but produces malformed output (truncated JSON, unexpected format)
**When** `parse()` is called
**Then** the try/catch in `parse()` catches the JSON parse error
**And** returns `[]` (zero findings, not a crash)
**And** the orchestrator records `status: 'success'` with 0 findings (parse failure is silent, same as hadolint pattern)

### SC-7: Zizmor force-enabled without workflow files

**Given** `enabledTools` includes `'zizmor'`
**And** no `.github/workflows/*.yml` files are in the diff
**When** the resolver runs
**Then** zizmor is activated with `reason: 'force-enabled'` (resolve.ts:57-67)
**And** `run()` receives the full file list, filters to workflow files, finds none
**And** `run()` returns the empty stub `{ stdout: '{}', ... }`
**And** `parse()` returns `[]`

### SC-8: Multiple workflow files in diff

**Given** a PR touches `.github/workflows/ci.yml`, `.github/workflows/deploy.yaml`, and `src/app.ts`
**When** zizmor runs
**Then** `run()` passes only the two workflow files to zizmor (not `src/app.ts`)
**And** findings from both files are included in the parsed results
**And** each finding's `file` field correctly identifies which workflow it came from

### SC-9: Timeout during execution

**Given** zizmor is activated
**And** a large number of workflow files causes zizmor to exceed the `TimeBudget` allocation
**When** `run()` exceeds `timeout` ms
**Then** `RawToolOutput.timedOut` is `true`
**And** `parse()` returns `[]`
**And** orchestrator records `status: 'error', error: 'timeout'`

---

## Edge Cases

| Case | Expected Behavior |
|------|-------------------|
| Workflow file with `.yaml` extension (not `.yml`) | `detect()` returns `true`, file is passed to zizmor |
| Workflow file in monorepo subdir (e.g., `apps/web/.github/workflows/ci.yml`) | `detect()` returns `true` (regex matches `/.github/workflows/` anywhere in path) |
| `.github/workflows/` directory but file is not yml/yaml (e.g., `README.md`) | `detect()` returns `false` for that file; if no other workflow files exist, zizmor not activated |
| Workflow filename with spaces or special chars | Passed as-is to zizmor CLI; shell escaping handled by `ctx.exec()` which uses spawn (not shell) |
| SARIF result with no `locations` array | Finding produced with `file: 'unknown'`, `line: undefined` |
| SARIF result with `level` absent | Default to `'low'` severity |
| SARIF `runs` array is empty | Return `[]` findings |
| zizmor returns exit code 2+ | Not in `allowExitCodes`, treated as execution error, orchestrator catches |
| Binary platform mismatch (arm64 host) | `install()` fails, orchestrator isolates, logs error — initial version targets x86_64 Linux only |
| Concurrent reviews both triggering install | `install()` is called per-review; cache layer handles contention at the storage level |

---

## Non-Functional Requirements

### Performance
- **Install time**: ≤5s with cache hit (verify-only), ≤60s on cold download
- **Execution time**: Typical workflow analysis completes in <10s for ≤10 workflow files
- **No impact on other tools**: zizmor's `TimeBudget` allocation is independent; timeout does not steal from other tools' budgets

### Compatibility
- **Existing tools**: All 15 existing tools remain unchanged — only additive changes to `ToolName` union and plugin registry
- **Existing tests**: `registry.test.ts` tool count assertion updated from 15 to 16; all other existing tests unaffected
- **SARIF standard**: Parse only SARIF v2.1.0 fields; forward-compatible with additional fields (ignore unknown)

### Determinism
- **Pinned version**: Binary version pinned to `1.23.1` via `ZIZMOR_VERSION` constant
- **No network during analysis**: zizmor analyzes local files only; network required only during `install()`
- **Reproducible findings**: Same workflow file → same findings (zizmor is deterministic for local analysis)

### Maintainability
- **Pattern conformance**: Plugin follows the exact structure of `hadolintPlugin` (detect + install + run + parse)
- **Exported parse and severity functions**: `parseZizmorOutput()` and `mapZizmorSeverity()` exported for direct unit testing with fixture data
- **SARIF interfaces**: Define typed `SarifResult`, `SarifRun`, `SarifLocation` interfaces in the plugin file for type-safe parsing (not relying on `any`)

### Testability
- **Fixture-driven**: All parse tests use a static SARIF fixture file at `__tests__/fixtures/zizmor-output.json`
- **No binary required for parse tests**: Parse/severity tests run against fixture data, no zizmor binary needed
- **Test coverage**: Metadata, detect (positive + negative), severity mapping (all levels + critical override), parse (happy path, empty, malformed, timeout), edge cases

---

## Files Created/Modified

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/tools/plugins/zizmor.ts` | **Create** | Plugin implementation: `zizmorPlugin` export |
| `packages/core/src/tools/plugins/__tests__/zizmor.test.ts` | **Create** | Unit tests following hadolint test pattern |
| `packages/core/src/tools/plugins/__tests__/fixtures/zizmor-output.json` | **Create** | SARIF fixture with representative findings |
| `packages/core/src/tools/types.ts` | **Modify** | Add `'zizmor'` to `ToolName` union (line ~30) |
| `packages/core/src/tools/plugins/index.ts` | **Modify** | Import, register, and re-export `zizmorPlugin` |

---

## Open Questions

None — all decisions are resolved based on:
1. The approved proposal approach (proposal.md)
2. Existing plugin patterns (hadolint for structure, gitleaks for security category)
3. zizmor's documented SARIF output format
4. The `ToolDefinition` interface contract (types.ts:97-138)
