# Tasks: deduplicate-format-review-comment

> **Spec**: `specs/review-formatting/spec.md`
> **Status**: done

## Phase 1: Extract to Core

### Task 1.1: Create `packages/core/src/format.ts`

Copy `formatReviewComment` and its constants verbatim from `apps/server/src/inngest/review.ts:31-118` into a new module at `packages/core/src/format.ts`.
- [x] Copy `STATUS_EMOJI` constant (lines 33-38) — export it
- [x] Copy `SEVERITY_EMOJI` constant (lines 40-46) — export it
- [x] Copy `formatReviewComment` function (lines 48-118) — export it
- [x] Add type imports: `import type { ReviewResult, ReviewStatus } from './types.js'`
- [x] Keep `SOURCE_LABELS` and `renderOrder` as function-local constants (no export)
- [x] Verify the file compiles: `npx tsc --noEmit -p packages/core/tsconfig.json`

**Satisfies**: R1, R2, R4, CC2

### Task 1.2: Export from `packages/core/src/index.ts`

Add the formatting exports to the barrel file at `packages/core/src/index.ts`.
- [x] Add section after the Memory block (after line 72):

  ```typescript
  // ─── Formatting ─────────────────────────────────────────────────
  export { formatReviewComment, STATUS_EMOJI, SEVERITY_EMOJI } from './format.js';
  ```
- [x] Verify build: `npx turbo build --filter=ghagga-core`

**Satisfies**: R1, CC1

## Phase 2: Migrate Consumers

### Task 2.1: Update `apps/server/src/inngest/review.ts`

- [x] Add `formatReviewComment` to the existing `ghagga-core` import (around line 27)
- [x] Delete lines 31-118: the `// ─── Comment Formatting` section with `STATUS_EMOJI`, `SEVERITY_EMOJI`, and `formatReviewComment`
- [x] Verify the call site at line ~398 (`const commentBody = formatReviewComment(result)`) still resolves
- [x] Verify build: `npx turbo build --filter=ghagga-server`
- [x] Removed unused type imports (`ReviewResult`, `ReviewStatus`) that were only needed by the local function

**Satisfies**: R3, R5

### Task 2.2: Update `apps/action/src/index.ts`

- [x] Add `formatReviewComment` to the existing `ghagga-core` import
- [x] Delete lines 200-291: the `// ─── Comment Formatting` section with `STATUS_EMOJI`, `SEVERITY_EMOJI`, JSDoc comment, and `formatReviewComment`
- [x] Verify the call site at line 172 (`const comment = formatReviewComment(result)`) still resolves
- [x] Verify build: `npx turbo build --filter=ghagga-action`
- [x] Removed unused type imports (`ReviewResult`, `ReviewStatus`) that were only needed by the local function

**Satisfies**: R3, R5

## Phase 3: Tests

### Task 3.1: Create `packages/core/src/format.test.ts`

Write direct unit tests for `formatReviewComment` covering all spec scenarios.
- [x] **S1**: Happy path — findings from all 4 sources, verify grouping order and table format
- [x] **S2**: Empty findings — no `### Findings` header, no table
- [x] **S3**: All 4 status variants map to correct emoji+text
- [x] **S4**: Pipe and newline escaping in finding messages
- [x] **S5/S6**: Not tested here (covered by integration tests + build verification)
- [x] Additional: finding without `line` renders file path only (no `:line`)
- [x] Additional: static analysis section with both `toolsRun` and `toolsSkipped`
- [x] Additional: footer always present
- [x] Run: `npx vitest run packages/core/src/format.test.ts` — **16 tests passed**

**Satisfies**: R6

### Task 3.2: Verify existing server integration tests pass

- [x] Run: `npx vitest run apps/server/src/inngest/review.test.ts` — **27 tests passed**
- [x] Confirm the `formatReviewComment (via post-comment)` describe block at line 1011 passes (2 tests)
- [x] Test mock updated: `vi.mock('ghagga-core')` now uses `importOriginal` to pass through real `formatReviewComment`

**Satisfies**: R2, S5

## Phase 4: Cleanup & Verification

### Task 4.1: Full build and lint verification

- [x] Core typecheck: `tsc --noEmit` passes
- [x] Server typecheck: `tsc --noEmit` passes
- [x] Action typecheck: `tsc --noEmit` passes
- [x] Core tests: 76 passed (format + pipeline + precomputed; security test has pre-existing unrelated failure)
- [x] Server tests: 27 passed
- [x] Action tests: 24 passed
- [x] Verify no dead code: grep for `STATUS_EMOJI` and `SEVERITY_EMOJI` definitions outside `packages/core` — zero source-code matches (only inline test re-declarations in action tests)
- [x] Verify no stale imports in server and action related to removed definitions
- [x] Verify no local `formatReviewComment` function definitions remain in server or action

**Satisfies**: R5, all cross-cutting concerns

## Summary

| Phase                | Tasks | Estimated effort |
| -------------------- | ----- | ---------------- |
| 1. Extract to core   | 2     | ~10 min          |
| 2. Migrate consumers | 2     | ~10 min          |
| 3. Tests             | 2     | ~15 min          |
| 4. Cleanup           | 1     | ~5 min           |
| **Total**            | **7** | **~40 min**      |
