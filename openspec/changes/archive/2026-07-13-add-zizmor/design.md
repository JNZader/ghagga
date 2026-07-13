# Design: Add zizmor — GitHub Actions Security Analysis

## Status
Draft

## Proposal
[proposal.md](./proposal.md)

## Spec
[spec.md](./spec.md)

## Date
2026-03-16

---

## Architecture Decisions

### AD-1: Plugin Pattern — hadolint as Template

**Decision**: Use `hadolintPlugin` (`packages/core/src/tools/plugins/hadolint.ts`) as the primary structural template.

**Why hadolint, not gitleaks or others**:

| Aspect | hadolint | gitleaks | zizmor (target) |
|--------|----------|----------|-----------------|
| Tier | `auto-detect` ✅ | `always-on` ✗ | `auto-detect` |
| Detection | File-pattern based ✅ | None (always runs) | File-pattern based |
| Install | Binary download + cache ✅ | Binary download + cache ✅ | Binary download + cache |
| Run | Passes individual files ✅ | Scans whole repo ✗ | Passes individual files |
| Parse | Exported function ✅ | Exported function ✅ | Exported function |
| Category | `quality` ✗ | `secrets` ✗ | `security` |

Hadolint matches on 4 of 5 structural aspects. The only difference is `category` (hadolint is `quality`, zizmor is `security`) and output format (hadolint is JSON, zizmor is SARIF).

**What's identical to hadolint**:
- `ToolDefinition` shape: all 12 properties populated the same way
- `detect()`: regex-based file path matching, returns `boolean`
- `install()`: cache-first → download binary → verify → cache-save, exact same flow
- `run()`: filter files → early-return on empty → exec with `allowExitCodes: [1]`
- `parse`: exported function, try/catch returning `[]` on any failure

**What differs from hadolint**:
- Output format is SARIF (`'sarif'`) not JSON (`'json'`), requiring SARIF-specific parsing
- Category is `'security'` not `'quality'`
- Severity mapping has a critical-elevation mechanism for specific rule IDs
- Detect regex targets `.github/workflows/*.{yml,yaml}` instead of `Dockerfile*`
- Binary download URL pattern (Rust binary naming convention vs Haskell)

### AD-2: SARIF Parsing Strategy

**Decision**: Parse SARIF v2.1.0 inline within the plugin file, using typed interfaces — no external SARIF library.

**Why no external library**: This is the first SARIF-format plugin in GHAGGA (all existing 15 plugins use `'json'`, `'xml'`, or `'text'` as `outputFormat`). The subset of SARIF we need is small (3 nested levels). Adding a `@microsoft/sarif-sdk` or similar dependency for 15 lines of traversal code would be over-engineering. If a second SARIF plugin is added later, we can extract a shared `parseSarif()` utility into `packages/core/src/tools/sarif.ts`.

**SARIF traversal path**:
```
root → runs[0] → results[] → each result → { ruleId, level, message.text, locations[0] }
```

**Typed interfaces** (defined in `zizmor.ts`, not exported — internal to the parser):

```typescript
/** SARIF v2.1.0 subset used by zizmor output parsing */
interface SarifLog {
  runs?: SarifRun[];
}

interface SarifRun {
  results?: SarifResult[];
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number };
  };
}
```

**Design choice**: All fields are optional (`?`) to handle malformed or partial SARIF gracefully — the parser never throws on missing fields, it uses defaults (`'unknown'`, `undefined`, `'low'`). This matches the spec edge cases (spec.md:154 — "Result missing `locations`": produce finding with `line: undefined`, `file: 'unknown'`).

**Why `runs[0]` only**: SARIF spec allows multiple runs (one per tool invocation). Since we invoke zizmor once, there is always exactly one run. Multiple-run handling is unnecessary complexity for zero benefit.

### AD-3: Severity Mapping & Critical Elevation

**Decision**: Two-tier mapping — base SARIF level mapping + rule-specific critical elevation.

**Base mapping** (pure function, no side effects):

```typescript
const SARIF_SEVERITY_MAP: Record<string, FindingSeverity> = {
  error: 'high',
  warning: 'medium',
  note: 'info',
  none: 'low',
};
```

**Critical elevation set** — rules where any severity gets overridden to `'critical'`:

```typescript
const CRITICAL_RULES: ReadonlySet<string> = new Set([
  'template-injection',  // Direct code execution via ${{ }} in run: blocks
]);
```

**Why a Set, not a Map**: We only need membership testing (`has()`), not value lookup. A `Set` communicates the intent cleanly. It's also trivially extensible — future rules like `excessive-permissions` or `artipacked` can be added with one line.

**Combined function**:

```typescript
export function mapZizmorSeverity(level: string, ruleId?: string): FindingSeverity {
  if (ruleId && CRITICAL_RULES.has(ruleId)) {
    return 'critical';
  }
  return SARIF_SEVERITY_MAP[level.toLowerCase()] ?? 'low';
}
```

**Rationale for `template-injection` as critical**: This is the most dangerous GitHub Actions vulnerability — it allows arbitrary code execution by injecting untrusted input (e.g., issue title) into a `run:` block via `${{ }}` expressions. Trail of Bits (zizmor's backing org) classifies this as the #1 priority issue. Other rules (`unpinned-uses`, `artipacked`) are serious but don't enable direct code execution.

**Comparison with existing plugins**: This two-tier pattern is unique to zizmor. Hadolint uses a simple switch (`mapHadolintSeverity` at hadolint.ts:20-33), gitleaks hardcodes all findings as `'critical'` (gitleaks.ts:36). The zizmor approach is more nuanced because workflow security issues span a wider severity range.

### AD-4: Binary Distribution

**Decision**: Download the pre-built Rust binary from GitHub Releases, x86_64 Linux only for initial release.

**Platform matrix**:

| Platform | Architecture | Asset Name | Status |
|----------|-------------|------------|--------|
| Linux | x86_64 | `zizmor-x86_64-unknown-linux-gnu` | ✅ Supported |
| Linux | aarch64 | `zizmor-aarch64-unknown-linux-gnu` | ❌ Future |
| macOS | x86_64 | `zizmor-x86_64-apple-darwin` | ❌ Future |
| macOS | aarch64 | `zizmor-aarch64-apple-darwin` | ❌ Future |

**Download URL template**:
```
https://github.com/woodruffw/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu
```

**Why direct binary (not tarball)**: Unlike gitleaks (which ships `.tar.gz` — see gitleaks.ts:73 `| tar xz`), zizmor publishes bare binaries per platform. This simplifies install — `curl -sL <url> -o <path> && chmod +x` — same one-liner pattern as hadolint (hadolint.ts:95-101).

**Cache strategy**: Identical to hadolint (hadolint.ts:84-105):
1. `ctx.cacheRestore('zizmor', ['/usr/local/bin/zizmor'])` — check cache
2. On hit: verify with `zizmor --version` (10s timeout)
3. On miss or verify failure: download, `chmod +x`, verify, `ctx.cacheSave()`

**Version pinning**: `ZIZMOR_VERSION = '1.23.1'` as a module-level constant. Version bumps are a one-line change (same pattern as `HADOLINT_VERSION = '2.12.0'` at hadolint.ts:13).

---

## Implementation Details

### File: `packages/core/src/tools/plugins/zizmor.ts`

Full plugin implementation following the hadolint pattern:

```typescript
/**
 * Zizmor plugin — GitHub Actions security analysis (auto-detect).
 *
 * Scans .github/workflows/*.{yml,yaml} files for security vulnerabilities
 * including template injection, unpinned actions, and excessive permissions.
 *
 * Uses ExecutionContext for DI instead of direct child_process.
 */

import type { FindingSeverity, ReviewFinding } from '../../types.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────

const ZIZMOR_VERSION = '1.23.1';
const ZIZMOR_BIN = '/usr/local/bin/zizmor';

/** Regex for GitHub Actions workflow files */
const WORKFLOW_PATTERN = /(^|\/)\.github\/workflows\/[^/]+\.(yml|yaml)$/;

// ─── SARIF Types (v2.1.0 subset) ───────────────────────────────

interface SarifLog {
  runs?: SarifRun[];
}

interface SarifRun {
  results?: SarifResult[];
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number };
  };
}

// ─── Severity Mapping ───────────────────────────────────────────

const SARIF_SEVERITY_MAP: Record<string, FindingSeverity> = {
  error: 'high',
  warning: 'medium',
  note: 'info',
  none: 'low',
};

/**
 * Rules that indicate direct code execution risk.
 * Findings from these rules are elevated to 'critical' regardless of SARIF level.
 */
const CRITICAL_RULES: ReadonlySet<string> = new Set([
  'template-injection',
]);

/**
 * Map zizmor SARIF severity level to GHAGGA FindingSeverity.
 * Exported for direct unit testing.
 */
export function mapZizmorSeverity(level: string, ruleId?: string): FindingSeverity {
  if (ruleId && CRITICAL_RULES.has(ruleId)) {
    return 'critical';
  }
  return SARIF_SEVERITY_MAP[level.toLowerCase()] ?? 'low';
}

// ─── Parse Function ─────────────────────────────────────────────

/**
 * Parse zizmor SARIF v2.1.0 output into ReviewFinding[].
 * Exported for direct testing with fixture data.
 */
export function parseZizmorOutput(raw: RawToolOutput, repoDir: string): ReviewFinding[] {
  if (raw.timedOut) return [];

  try {
    const sarif: SarifLog = JSON.parse(raw.stdout);
    const results = sarif.runs?.[0]?.results;
    if (!results || results.length === 0) return [];

    return results.map((result) => {
      const location = result.locations?.[0]?.physicalLocation;
      const uri = location?.artifactLocation?.uri ?? 'unknown';
      const line = location?.region?.startLine;
      const ruleId = result.ruleId ?? 'unknown';
      const messageText = result.message?.text ?? 'Security issue detected';
      const level = result.level ?? 'none';

      return {
        severity: mapZizmorSeverity(level, ruleId),
        category: 'security',
        file: uri.replace(`${repoDir}/`, ''),
        line,
        message: `${ruleId}: ${messageText}`,
        source: 'zizmor' as const,
      };
    });
  } catch {
    return [];
  }
}

// ─── Plugin Definition ──────────────────────────────────────────

export const zizmorPlugin: ToolDefinition = {
  name: 'zizmor',
  displayName: 'Zizmor',
  category: 'security',
  tier: 'auto-detect',
  version: ZIZMOR_VERSION,
  outputFormat: 'sarif',
  cachePaths: [ZIZMOR_BIN],

  detect(files: string[]): boolean {
    return files.some((f) => WORKFLOW_PATTERN.test(f));
  },

  async install(ctx: ExecutionContext): Promise<void> {
    const cached = await ctx.cacheRestore('zizmor', [ZIZMOR_BIN]);
    if (cached) {
      try {
        await ctx.exec('zizmor', ['--version'], { timeoutMs: 10_000 });
        return;
      } catch {
        ctx.log('warn', 'Zizmor cache restored but binary not functional, reinstalling');
      }
    }

    await ctx.exec(
      'bash',
      [
        '-c',
        `curl -sL "https://github.com/woodruffw/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu" -o ${ZIZMOR_BIN} && chmod +x ${ZIZMOR_BIN}`,
      ],
      { timeoutMs: 120_000 },
    );
    await ctx.exec('zizmor', ['--version'], { timeoutMs: 10_000 });
    await ctx.cacheSave('zizmor', [ZIZMOR_BIN]);
  },

  async run(
    ctx: ExecutionContext,
    _repoDir: string,
    files: string[],
    timeout: number,
  ): Promise<RawToolOutput> {
    const workflowFiles = files.filter((f) => WORKFLOW_PATTERN.test(f));

    if (workflowFiles.length === 0) {
      return { stdout: '{}', stderr: '', exitCode: 0, timedOut: false };
    }

    return ctx.exec('zizmor', ['--format', 'sarif', ...workflowFiles], {
      timeoutMs: timeout,
      allowExitCodes: [1],
    });
  },

  parse: parseZizmorOutput,
};
```

**Key implementation notes**:
- The `WORKFLOW_PATTERN` regex is extracted as a module-level constant and reused by both `detect()` and `run()` (file filtering). This avoids regex duplication — hadolint duplicates its `/Dockerfile/` pattern inline in both methods (hadolint.ts:79 and hadolint.ts:116), which is a minor code smell we improve on.
- `_repoDir` is unused in `run()` (prefixed with `_`) because workflow files are passed as received from the orchestrator (already absolute paths). Same convention as hadolint (hadolint.ts:109).
- Empty-result stub returns `'{}'` not `'[]'` since the output format is SARIF (an object), not JSON array. Compare with hadolint which returns `'[]'` (hadolint.ts:120).

### File: `packages/core/src/tools/types.ts`

**Exact change** — add `'zizmor'` to the `ToolName` union (line 30):

```typescript
// Before (types.ts:15-30):
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

// After:
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
  | 'hadolint'
  | 'zizmor';
```

This is a **type-only change** — no runtime behavior change. The TypeScript compiler will now accept `'zizmor'` anywhere a `ToolName` is expected (plugin definition `name` field, registry `getByName()` lookups, etc.).

### File: `packages/core/src/tools/plugins/index.ts`

Three changes:

**1. Import** (after line 24, the hadolint import):
```typescript
import { zizmorPlugin } from './zizmor.js';
```

**2. Registration** — add to `DEFAULT_PLUGINS` array as Phase 6 (new phase, after Phase 5):
```typescript
const DEFAULT_PLUGINS = [
  // Phase 2: always-on (adapted)
  semgrepPlugin,
  trivyPlugin,
  cpdPlugin,
  // Phase 3: always-on (new)
  gitleaksPlugin,
  shellcheckPlugin,
  markdownlintPlugin,
  lizardPlugin,
  // Phase 4: auto-detect (Python + Go)
  ruffPlugin,
  banditPlugin,
  golangciLintPlugin,
  // Phase 5: auto-detect (remaining)
  biomePlugin,
  pmdPlugin,
  psalmPlugin,
  clippyPlugin,
  hadolintPlugin,
  // Phase 6: auto-detect (CI/CD security)
  zizmorPlugin,
];
```

**Why a new Phase 6 instead of appending to Phase 5**: Phase 5 is "remaining auto-detect" tools from the original batch (biome, pmd, psalm, clippy, hadolint) that were implemented together. Zizmor is a distinct later addition. Using Phase 6 makes the header comment self-documenting — future tools can be added to Phase 6 or Phase 7.

**3. Re-export** (after the trivy export at line 99):
```typescript
export { zizmorPlugin } from './zizmor.js';
```

**4. Update the header comment** (lines 7-10):
```typescript
/**
 * Phase 2: semgrep, trivy, cpd (always-on)
 * Phase 3: gitleaks, shellcheck, markdownlint, lizard (always-on)
 * Phase 4: ruff, bandit, golangci-lint (auto-detect)
 * Phase 5: biome, pmd, psalm, clippy, hadolint (auto-detect)
 * Phase 6: zizmor (auto-detect)
 */
```

### File: `packages/core/src/tools/plugins/__tests__/zizmor.test.ts`

Test structure follows the exact pattern of `hadolint.test.ts` with additions for SARIF-specific parsing and critical elevation:

```typescript
/**
 * Tests for Zizmor plugin — parse function with fixture data.
 *
 * Validates GitHub Actions security analysis, SARIF parsing,
 * severity mapping with critical elevation, detect function, and edge cases.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawToolOutput } from '../../types.js';
import { mapZizmorSeverity, parseZizmorOutput, zizmorPlugin } from '../zizmor.js';

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'zizmor-output.json');
const FIXTURE_JSON = readFileSync(FIXTURE_PATH, 'utf8');

function makeRaw(stdout: string, exitCode = 0, timedOut = false): RawToolOutput {
  return { stdout, stderr: '', exitCode, timedOut };
}
```

**Test groups**:

| Group | Tests | What It Validates |
|-------|-------|-------------------|
| `zizmorPlugin metadata` | 6 tests | `name: 'zizmor'`, `displayName: 'Zizmor'`, `category: 'security'`, `tier: 'auto-detect'`, `version: '1.23.1'`, `outputFormat: 'sarif'` |
| `zizmorPlugin detect` | 7 tests | ✅ `.github/workflows/ci.yml`, ✅ `.github/workflows/deploy.yaml`, ✅ `apps/web/.github/workflows/test.yml` (monorepo), ✗ `.github/dependabot.yml`, ✗ `.github/actions/my-action/action.yml`, ✗ `docker-compose.yml`, ✗ `[]` |
| `mapZizmorSeverity` | 7 tests | `error→high`, `warning→medium`, `note→info`, `none→low`, `unknown→low`, `template-injection + error → critical`, `unpinned-uses + warning → medium` (non-critical stays at base) |
| `parseZizmorOutput` (happy path) | 8 tests | Finding count (4 from fixture), critical severity for template-injection, medium for unpinned-uses, `category: 'security'` for all, `source: 'zizmor'` for all, file path stripping (`/workspace/` removed), line numbers present, message format `ruleId: text` |
| `parseZizmorOutput` (edge cases) | 6 tests | Empty SARIF `'{}'`, empty `results: []`, missing `locations`, malformed JSON, timeout (`timedOut: true`), empty stdout `''` |

**Total: ~34 tests** (vs hadolint's 23 and gitleaks's 16 — more tests due to SARIF complexity and critical elevation).

### File: `packages/core/src/tools/plugins/__tests__/fixtures/zizmor-output.json`

A representative SARIF v2.1.0 fixture covering the key rule types:

```json
{
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "zizmor",
          "version": "1.23.1"
        }
      },
      "results": [
        {
          "ruleId": "template-injection",
          "level": "error",
          "message": {
            "text": "code injection via template expansion of `github.event.issue.body` in `run:` block"
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "/workspace/.github/workflows/ci.yml" },
                "region": { "startLine": 25 }
              }
            }
          ]
        },
        {
          "ruleId": "unpinned-uses",
          "level": "warning",
          "message": {
            "text": "action `actions/checkout` used with unpinned ref `v4`"
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "/workspace/.github/workflows/ci.yml" },
                "region": { "startLine": 12 }
              }
            }
          ]
        },
        {
          "ruleId": "excessive-permissions",
          "level": "warning",
          "message": {
            "text": "workflow has overly broad `write-all` permissions"
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "/workspace/.github/workflows/deploy.yaml" },
                "region": { "startLine": 3 }
              }
            }
          ]
        },
        {
          "ruleId": "artipacked",
          "level": "note",
          "message": {
            "text": "artifact upload may expose sensitive credentials from checkout"
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "/workspace/.github/workflows/deploy.yaml" },
                "region": { "startLine": 45 }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

**Fixture design rationale**:
- 4 findings covering 4 different rules with 3 different SARIF levels (`error`, `warning`, `note`)
- 2 different workflow files (`ci.yml` and `deploy.yaml`) to test multi-file path extraction
- `template-injection` rule present to validate critical elevation
- File paths include `/workspace/` prefix to validate `repoDir` stripping
- Realistic `message.text` values matching actual zizmor output format

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ PR Diff: files = ['.github/workflows/ci.yml', 'src/app.ts', ...]  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ resolve.ts:50-55 — auto-detect loop                              │
│   zizmorPlugin.detect(files)                                     │
│   → WORKFLOW_PATTERN.test('.github/workflows/ci.yml') → true     │
│   → ActivatedTool { definition: zizmorPlugin,                    │
│                      reason: 'auto-detect' }                     │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ orchestrator.ts:69-120 — per-tool install → run → parse          │
│                                                                   │
│ 1. install(ctx)                                                   │
│    ├─ cacheRestore('zizmor', ['/usr/local/bin/zizmor'])           │
│    ├─ if miss: curl → chmod +x → verify → cacheSave              │
│    └─ if hit:  verify → return (or re-download on failure)       │
│                                                                   │
│ 2. run(ctx, repoDir, files, timeout)                             │
│    ├─ filter files → workflowFiles = ['.github/workflows/ci.yml']│
│    └─ ctx.exec('zizmor', ['--format', 'sarif', ...workflowFiles])│
│        → exit code 0 (clean) or 1 (findings present)            │
│        → RawToolOutput { stdout: '<SARIF JSON>', ... }           │
│                                                                   │
│ 3. parse(raw, repoDir) = parseZizmorOutput(raw, repoDir)        │
│    ├─ JSON.parse(raw.stdout) → SarifLog                          │
│    ├─ sarif.runs[0].results[] → iterate                          │
│    └─ per result:                                                │
│        ├─ extract: ruleId, level, message.text, uri, startLine   │
│        ├─ mapZizmorSeverity(level, ruleId)                       │
│        │   └─ CRITICAL_RULES.has('template-injection') → 'critical'│
│        └─ → ReviewFinding { severity, category, file, line, ... }│
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ ReviewFinding[]                                                   │
│ [                                                                 │
│   { severity: 'critical', category: 'security',                  │
│     source: 'zizmor',                                            │
│     file: '.github/workflows/ci.yml', line: 25,                  │
│     message: 'template-injection: code injection via ...' },     │
│   { severity: 'medium', category: 'security',                   │
│     source: 'zizmor',                                            │
│     file: '.github/workflows/ci.yml', line: 12,                  │
│     message: 'unpinned-uses: action used with unpinned ref ...' }│
│ ]                                                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Integration Points

### Code Touched

| File | Change Type | Lines Changed | Risk |
|------|------------|---------------|------|
| `packages/core/src/tools/types.ts` | Add union member | +1 line (`\| 'zizmor'` at line 30) | None — additive type change |
| `packages/core/src/tools/plugins/index.ts` | Import + register + export + comment | +4 lines code, +1 comment line | None — additive array entry |

### New Files Created

| File | Description | Size Estimate |
|------|-------------|---------------|
| `packages/core/src/tools/plugins/zizmor.ts` | Plugin implementation | ~140 lines |
| `packages/core/src/tools/plugins/__tests__/zizmor.test.ts` | Unit tests | ~200 lines |
| `packages/core/src/tools/plugins/__tests__/fixtures/zizmor-output.json` | SARIF fixture | ~55 lines |

### Code NOT Touched

These files require **zero modifications** — the plugin integrates via existing extension points:

| File | Why No Change |
|------|---------------|
| `packages/core/src/tools/resolve.ts` | Auto-detect loop at line 50-55 automatically discovers registered plugins with `detect()` — no plugin-specific code |
| `packages/core/src/tools/orchestrator.ts` | Per-tool `install → run → parse` loop at line 69-120 handles any `ToolDefinition` generically |
| `packages/core/src/tools/registry.ts` | `register()` accepts any `ToolDefinition` — no plugin-specific code |
| `packages/core/src/tools/budget.ts` | `TimeBudget` allocates per-tool budgets dynamically based on activated tool count |
| `packages/core/src/types.ts` | `FindingSeverity`, `ReviewFinding`, `StaticAnalysisResult` — all already generic enough |
| `packages/core/src/tools/plugins/__tests__/registry.test.ts` | Tests only register 3 Phase-2 plugins explicitly (semgrep, trivy, cpd) in a fresh `ToolRegistry` instance (registry.test.ts:41-46). The assertions (`registry.size === 3`) are about those specific plugins, not the global count. No update needed. |

**This confirms the plugin architecture's extensibility**: adding a new tool is entirely additive — 1 new plugin file + 2 small modifications to existing files.

---

## Alternatives Considered

### A1: Use actionlint Instead of zizmor

**Rejected**. [actionlint](https://github.com/rhysd/actionlint) is a GitHub Actions **linter** focused on syntax validation and type checking (e.g., invalid `on:` triggers, undefined outputs). zizmor is a **security analyzer** focused on vulnerabilities (template injection, unpinned actions, excessive permissions). They are complementary, not competing. GHAGGA's gap is security analysis of workflows, not linting.

actionlint could be a future Phase 7 addition under category `'quality'`.

### A2: Custom YAML Analysis (No External Tool)

**Rejected**. Building regex-based or AST-based detection for template injection, unpinned actions, etc. would be:
- **Fragile**: GitHub Actions syntax has many edge cases (matrix expressions, reusable workflows, composite actions)
- **Incomplete**: zizmor covers 15+ rules with ongoing maintenance by Trail of Bits
- **Maintenance burden**: GHAGGA would own the detection logic instead of delegating to a specialized tool

The plugin architecture exists precisely to integrate purpose-built tools.

### A3: Use a SARIF Parsing Library

**Rejected for now**. `@microsoft/sarif-node` or similar libraries add dependency weight for a parsing task that requires ~15 lines of traversal code. The SARIF subset we access (4 interfaces, 6 fields) doesn't justify an external dependency. If a second SARIF plugin is added (e.g., CodeQL, Trivy SARIF mode), we should extract `parseSarifResults()` as a shared utility in `packages/core/src/tools/sarif.ts`.

### A4: Parse zizmor's JSON Output Instead of SARIF

**Rejected**. zizmor supports `--format json` but its JSON format is less standardized than SARIF. SARIF is an OASIS standard (v2.1.0) with stable field names, making our parser more resilient to zizmor version changes. SARIF also positions GHAGGA to accept SARIF input from other tools in the future.

### A5: Place zizmor in Phase 5 Instead of Phase 6

**Rejected**. Phase 5 is documented as "remaining auto-detect" tools from the original batch (biome, pmd, psalm, clippy, hadolint — see index.ts:10). These were implemented together as a cohesive group. Zizmor is a distinct later addition. Phase 6 preserves the historical grouping and makes the `index.ts` header comments self-documenting for future contributors.
