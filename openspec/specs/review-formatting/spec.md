# Spec: Review Comment Formatting

> **Domain**: review-formatting (new)
> **Change**: deduplicate-format-review-comment
> **Status**: draft

## Overview

`formatReviewComment` is a pure function `(ReviewResult) => string` that renders a GitHub-flavored Markdown comment for PR reviews. It is currently duplicated byte-for-byte in `apps/server/src/inngest/review.ts:48-118` and `apps/action/src/index.ts:221-291`. This spec defines the extraction into `packages/core` as the single source of truth.

## Requirements

### R1: Single Source of Truth

`formatReviewComment` MUST be exported from `packages/core/src/format.ts` and re-exported through `packages/core/src/index.ts`. This SHALL be the sole implementation of the function in the monorepo.

### R2: Behavioral Equivalence

The extracted function MUST produce byte-for-byte identical output to the current implementation in `apps/server/src/inngest/review.ts:48-118` for any valid `ReviewResult` input. No formatting changes, no whitespace changes, no emoji changes.

### R3: Consumer Migration

Both consumers MUST import `formatReviewComment` from `ghagga-core`:
- `apps/server/src/inngest/review.ts` — currently defines locally at line 48
- `apps/action/src/index.ts` — currently defines locally at line 221

### R4: Constants Co-location

The following helper constants MUST be co-located with `formatReviewComment` in `packages/core/src/format.ts`:

| Constant         | Type                           | Scope                         |
| ---------------- | ------------------------------ | ----------------------------- |
| `STATUS_EMOJI`   | `Record<ReviewStatus, string>` | Module-level export           |
| `SEVERITY_EMOJI` | `Record<string, string>`       | Module-level export           |
| `SOURCE_LABELS`  | `Record<string, string>`       | Function-local (not exported) |
| `renderOrder`    | `string[]`                     | Function-local (not exported) |

`STATUS_EMOJI` and `SEVERITY_EMOJI` MUST be exported for consumers that may need them independently. `SOURCE_LABELS` and `renderOrder` MUST remain function-local as they are implementation details.

### R5: No Dead Code

After migration, the duplicate implementations MUST be completely removed:
- `apps/server/src/inngest/review.ts` lines 31-118 (constants + function)
- `apps/action/src/index.ts` lines 200-291 (constants + function + JSDoc comment)

No orphaned imports related to these removed definitions SHALL remain.

### R6: Test Coverage

Direct unit tests for `formatReviewComment` MUST exist in `packages/core/src/format.test.ts`. These tests MUST cover:
- Findings table rendering with grouped sources
- Empty findings (no table rendered)
- All four `ReviewStatus` variants: `PASSED`, `FAILED`, `NEEDS_HUMAN_REVIEW`, `SKIPPED`
- Pipe (`|`) and newline (`\n`) escaping in finding messages
- Static analysis summary section (tools run / tools skipped)
- Footer line

## Cross-cutting Concerns

### CC1: Export Surface

The function MUST be re-exported from `packages/core/src/index.ts` following the existing section pattern:

```typescript
// ─── Formatting ─────────────────────────────────────────────────
export { formatReviewComment, STATUS_EMOJI, SEVERITY_EMOJI } from './format.js';
```

This follows the established convention visible at `packages/core/src/index.ts:8-72`.

### CC2: Type Compatibility

The function MUST use only types already exported from `ghagga-core`. Required types and their locations:

| Type              | Defined at                       |
| ----------------- | -------------------------------- |
| `ReviewResult`    | `packages/core/src/types.ts:141` |
| `ReviewStatus`    | `packages/core/src/types.ts:137` |
| `FindingSeverity` | `packages/core/src/types.ts:138` |
| `FindingSource`   | `packages/core/src/types.ts:139` |

No new type definitions are needed.

## Scenarios

### S1: Happy Path — Findings From All Sources

**Given** a `ReviewResult` with:
- `status: 'FAILED'`
- 4 findings, one from each source (`semgrep`, `trivy`, `cpd`, `ai`)
- `metadata.toolsRun: ['semgrep', 'trivy', 'cpd']`
- `metadata.toolsSkipped: []`
- `metadata.executionTimeMs: 5000`

**When** `formatReviewComment(result)` is called

**Then** the output:
- Starts with `## 🤖 GHAGGA Code Review`
- Contains `**Status:** ❌ FAILED`
- Contains mode, model, and `5.0s` in the metadata line
- Contains `### Findings (4)` header
- Groups findings in order: Semgrep, Trivy, CPD, AI Review
- Each group has a Markdown table with Severity, Category, File, Message columns
- Contains `### Static Analysis` section with `✅ Tools run: semgrep, trivy, cpd`
- Ends with the `---\n*Powered by [GHAGGA]...` footer

### S2: Empty Findings

**Given** a `ReviewResult` with:
- `status: 'PASSED'`
- `findings: []`
- `metadata.toolsRun: []`, `metadata.toolsSkipped: []`

**When** `formatReviewComment(result)` is called

**Then** the output:
- Contains `**Status:** ✅ PASSED`
- Does NOT contain `### Findings` header
- Does NOT contain `| Severity |` table header
- Does NOT contain `### Static Analysis` section
- Contains the footer

### S3: Status Variants

**Given** a `ReviewResult` for each status in `['PASSED', 'FAILED', 'NEEDS_HUMAN_REVIEW', 'SKIPPED']`

**When** `formatReviewComment(result)` is called for each

**Then** the output contains the corresponding emoji+text:
- `PASSED` → `✅ PASSED`
- `FAILED` → `❌ FAILED`
- `NEEDS_HUMAN_REVIEW` → `⚠️ NEEDS_HUMAN_REVIEW`
- `SKIPPED` → `⏭️ SKIPPED`

### S4: Pipe and Newline Escaping

**Given** a finding with `message: "Use | instead\nof & operator"`

**When** `formatReviewComment(result)` is called

**Then** the message cell in the findings table contains `Use \\| instead of & operator` (pipe escaped, newline replaced with space)

### S5: Server Consumer — Same Output

**Given** the server (`apps/server/src/inngest/review.ts`) imports `formatReviewComment` from `ghagga-core`

**When** the Inngest `reviewFunction` calls `formatReviewComment(result)` at the post-comment step

**Then** the output is identical to the pre-extraction behavior. The existing integration tests at `apps/server/src/inngest/review.test.ts:1011-1131` MUST pass without modification.

### S6: Action Consumer — Same Output

**Given** the action (`apps/action/src/index.ts`) imports `formatReviewComment` from `ghagga-core`

**When** the action's `run()` function calls `formatReviewComment(result)` at line 172

**Then** the output is identical to the pre-extraction behavior.

## Invariants

- `formatReviewComment` is a pure function: no side effects, no I/O, deterministic output for a given input.
- Findings are always rendered in the fixed order: semgrep → trivy → cpd → ai. Sources not present in the result are silently skipped.
- The function accepts any valid `ReviewResult` — it MUST NOT throw for empty arrays, zero execution time, or missing optional fields (e.g., `finding.line`).
