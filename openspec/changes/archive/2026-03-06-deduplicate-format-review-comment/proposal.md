# Proposal: Deduplicate formatReviewComment

## Intent

The function `formatReviewComment` and its helper constants (`STATUS_EMOJI`, `SEVERITY_EMOJI`, `SOURCE_LABELS`, `renderOrder`) are duplicated byte-for-byte in two places:
1. `apps/server/src/inngest/review.ts` (lines 33-118) -- used when the SaaS server posts the PR review comment
2. `apps/action/src/index.ts` (lines 202-291) -- used when the GitHub Action posts the PR review comment

The action copy even has a comment: _"Mirrors the server's formatReviewComment for consistency"_, confirming this is intentional duplication that should be a shared module.

Both implementations are pure functions: `(result: ReviewResult) => string`. They take a type already defined in `ghagga-core` and produce a GitHub-flavored Markdown string. The function belongs in `packages/core` alongside the other formatting and utility exports.

The CLI's `formatMarkdownResult` in `apps/cli/src/commands/review.ts` is intentionally different (terminal output, not GitHub PR Markdown) and is explicitly out of scope.

## Scope

### In Scope

- **`packages/core/src/format.ts`** (new): Extract `formatReviewComment`, `STATUS_EMOJI`, `SEVERITY_EMOJI`, `SOURCE_LABELS`, and `renderOrder` into a new module. The function signature remains `(result: ReviewResult) => string`.
- **`packages/core/src/index.ts`**: Add `export { formatReviewComment } from './format.js'` and export the constant maps (`STATUS_EMOJI`, `SEVERITY_EMOJI`) for consumers that may need them independently.
- **`packages/core/src/format.test.ts`** (new): Dedicated unit tests for `formatReviewComment`. These test the function directly (not through an Inngest integration test), covering: findings table with multiple sources, empty findings, pipe/newline escaping in messages, all status variants, static analysis summary section, and the footer.
- **`apps/server/src/inngest/review.ts`**: Remove lines 31-118 (the `STATUS_EMOJI`, `SEVERITY_EMOJI` constants, and `formatReviewComment` function). Import `formatReviewComment` from `ghagga-core`.
- **`apps/action/src/index.ts`**: Remove lines 200-291 (the duplicate constants and function). Import `formatReviewComment` from `ghagga-core`.
- **`apps/server/src/inngest/review.test.ts`**: The existing integration tests (lines 1011-1131) that validate the posted comment content remain as-is -- they indirectly test the formatting through the Inngest function flow. The new unit tests in `packages/core` cover the function directly.

### Out of Scope

- **`apps/cli/src/commands/review.ts`** (`formatMarkdownResult`): Intentionally different output format (terminal, not GitHub PR Markdown). Not a candidate for merging.
- **Behavioral changes**: This is a pure extraction refactor. The Markdown output must be identical before and after.
- **New formatting features**: No changes to the table layout, emoji mapping, footer text, or rendering order.
- **Dashboard**: No formatting logic exists here.

## Approach

### Pure extraction refactor

This is a straightforward "move and re-export" change with zero behavioral modifications:

**1. Create `packages/core/src/format.ts`**

Move the constants and function verbatim from `apps/server/src/inngest/review.ts`:

```typescript
// packages/core/src/format.ts
import type { ReviewResult, ReviewStatus } from './types.js';

export const STATUS_EMOJI: Record<ReviewStatus, string> = {
  /* ... */
};
export const SEVERITY_EMOJI: Record<string, string> = {
  /* ... */
};

export function formatReviewComment(result: ReviewResult): string {
  // Exact same implementation — no changes
}
```

The `SOURCE_LABELS` and `renderOrder` stay as local constants inside the function (they are not used elsewhere).

**2. Export from `packages/core/src/index.ts`**

```typescript
// ─── Formatting ─────────────────────────────────────────────────
export { formatReviewComment, STATUS_EMOJI, SEVERITY_EMOJI } from './format.js';
```

This follows the existing pattern: each module (`pipeline.ts`, `providers/`, `memory/`, `utils/`) gets its own section in the barrel export.

**3. Update consumers**

In both `apps/server/src/inngest/review.ts` and `apps/action/src/index.ts`:

```typescript
import { formatReviewComment } from 'ghagga-core';
```

Remove the local `STATUS_EMOJI`, `SEVERITY_EMOJI`, `SOURCE_LABELS`, `renderOrder`, and `formatReviewComment` definitions.

**4. Add direct unit tests**

The existing tests in `review.test.ts` exercise `formatReviewComment` indirectly through the full Inngest function flow. The new `format.test.ts` tests the function in isolation, which is faster, more focused, and documents the exact output contract.

## Affected Areas

| File                                     | Change                                        | Lines Affected                                 |
| ---------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `packages/core/src/format.ts`            | New file: extracted function + constants      | ~90 lines (new)                                |
| `packages/core/src/format.test.ts`       | New file: direct unit tests                   | ~100 lines (new)                               |
| `packages/core/src/index.ts`             | Add formatting exports                        | +3 lines                                       |
| `apps/server/src/inngest/review.ts`      | Remove local function + constants, add import | Delete lines 31-118 (~88 lines), add 1 import  |
| `apps/action/src/index.ts`               | Remove local function + constants, add import | Delete lines 200-291 (~92 lines), add 1 import |
| `apps/server/src/inngest/review.test.ts` | No changes                                    | Existing integration tests remain valid        |

## Risks

| Risk                                 | Likelihood | Impact | Mitigation                                                                                                                                                           |
| ------------------------------------ | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import resolution failure**        | Low        | Medium | Both `apps/server` and `apps/action` already import from `ghagga-core` (e.g., `reviewPipeline`, `DEFAULT_SETTINGS`). The workspace dependency is already configured. |
| **Subtle difference between copies** | Very Low   | Low    | Verified by reading both implementations -- they are byte-for-byte identical in logic. The only difference is the JSDoc comment on the action copy.                  |
| **Build order in turborepo**         | Very Low   | Low    | `packages/core` is already a dependency of both apps in the turbo pipeline. Adding an export does not change the build graph.                                        |
| **Type import mismatch**             | Very Low   | Low    | `ReviewResult` and `ReviewStatus` are already exported from `ghagga-core` and already imported by the action. The server imports them too (line 27).                 |

## Rollback Plan

Revert the commit. The local copies are restored, and both apps work independently as before. No data changes, no env var changes, no infrastructure changes.

**Rollback time**: < 2 minutes (single revert + build).

## Dependencies

- **No new npm dependencies**: The function uses only string concatenation and `Map` -- no external imports.
- **No infrastructure changes**: No new services, databases, or env vars.
- **Existing workspace dependency**: Both `apps/server` and `apps/action` already depend on `ghagga-core` in their `package.json`.

## Success Criteria

- [ ] `formatReviewComment` exists in `packages/core/src/format.ts` and is exported from `packages/core/src/index.ts`
- [ ] `apps/server/src/inngest/review.ts` imports `formatReviewComment` from `ghagga-core` (no local copy)
- [ ] `apps/action/src/index.ts` imports `formatReviewComment` from `ghagga-core` (no local copy)
- [ ] No duplicate definition of `STATUS_EMOJI`, `SEVERITY_EMOJI`, or `formatReviewComment` exists across the monorepo (excluding CLI's `formatMarkdownResult`)
- [ ] `packages/core/src/format.test.ts` has direct unit tests covering: findings table, empty findings, status variants, pipe/newline escaping, static analysis summary, and footer
- [ ] Existing server integration tests (`review.test.ts` lines 1011-1131) pass without modification
- [ ] `turbo build` and `turbo test` pass across all packages
- [ ] The Markdown output produced by `formatReviewComment` is byte-for-byte identical before and after the change

## Distribution Mode Impact

| Mode                     | Impact               | Notes                                                  |
| ------------------------ | -------------------- | ------------------------------------------------------ |
| **SaaS** (webhook)       | No behavioral change | Imports from `ghagga-core` instead of local definition |
| **Action** (self-hosted) | No behavioral change | Imports from `ghagga-core` instead of local definition |
| **CLI**                  | No change            | Uses its own `formatMarkdownResult` (terminal output)  |
| **Dashboard**            | No change            | No formatting logic                                    |
