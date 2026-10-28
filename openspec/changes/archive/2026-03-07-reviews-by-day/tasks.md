# Tasks: reviews-by-day

**Change**: Implement `reviewsByDay` daily aggregation
**Date**: 2026-03-07

## Phase 1: Core Query

### 1.1 Add `getReviewsByDay` query function

- **File**: `packages/db/src/queries.ts`
- **Action**: Add new exported async function `getReviewsByDay(db, repositoryId)`
- **Details**:
  - Use Drizzle `sql` template for `DATE(created_at)` grouping
  - Filter: `repository_id = ?` AND `created_at >= NOW() - 30 days`
  - Select: date, total count, passed count, failed count
  - Order by date ASC
  - Return type: `{ date: string; total: number; passed: number; failed: number }[]`
- [x] Done

## Phase 2: API Integration

### 2.1 Wire `getReviewsByDay` into `/api/stats` endpoint

- **File**: `apps/server/src/routes/api.ts`
- **Action**:
  - Import `getReviewsByDay` from `ghagga-db`
  - Call it with `(db, repo.id)` inside the stats handler
  - Replace `reviewsByDay: []` with the query result
- [x] Done

## Phase 3: Tests

### 3.1 Add `reviewsByDay` tests to API test suite

- **File**: `apps/server/src/routes/api.test.ts`
- **Action**:
  - Add mock for `getReviewsByDay`
  - Add to `vi.mock('ghagga-db', ...)` block
  - Update existing stats test that asserts `reviewsByDay: []`
  - Add new tests:
    - Returns reviewsByDay data from query
    - Returns empty array when query returns empty
    - Verifies getReviewsByDay is called with correct repo.id
- [x] Done

## Phase 4: Verification

### 4.1 Run typecheck

- **Command**: `pnpm exec turbo typecheck`
- [x] Done

### 4.2 Run tests

- **Command**: `pnpm exec turbo test`
- [x] Done
