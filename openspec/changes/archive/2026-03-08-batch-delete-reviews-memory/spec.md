# Specs Summary: batch-delete-reviews-memory

> **Change**: Granular & Batch Delete for Reviews and Memory
> **Proposal**: `openspec/changes/batch-delete-reviews-memory/proposal.md`

## Delta Specs Written

| Domain       | File                         | Type  | Requirements                   | Scenarios |
| ------------ | ---------------------------- | ----- | ------------------------------ | --------- |
| Server       | `specs/server/spec.md`       | Delta | 4 added, 0 modified, 0 removed | 28        |
| Dashboard UI | `specs/dashboard-ui/spec.md` | Delta | 6 added, 2 modified, 0 removed | 28        |

**Totals**: 10 added requirements, 2 modified requirements, 0 removed — **56 scenarios**

## Server Requirements

1. **Single Review Delete Endpoint** — `DELETE /api/reviews/:reviewId` with installation-scoped auth, 404 for not-found/unauthorized (6 scenarios)
2. **Batch Review Delete Endpoint** — `DELETE /api/reviews/batch` with Zod validation, max 100 IDs, installation-scoped silent skip (10 scenarios)
3. **Batch Memory Observation Delete Endpoint** — `DELETE /api/memory/observations/batch` with same pattern (9 scenarios)
4. **Database Query Functions** — `deleteReviewById`, `deleteReviewsByIds`, `deleteMemoryObservationsByIds` in queries.ts (6 scenarios, but tested through endpoint scenarios too)

Note: Route registration order is specified (literal before parameterized) to avoid conflicts with existing `:repoFullName` and `:id` routes.

## Dashboard UI Requirements

1. **Reviews Page Row Selection** — Checkbox column, select-all with indeterminate state (5 scenarios)
2. **Reviews Page Batch Delete Action** — "Delete Selected (N)" button, Tier 1 confirm dialog (4 scenarios)
3. **Memory Page Observation Selection** — Checkboxes on cards, works with virtualization (5 scenarios)
4. **Memory Page Batch Delete Action** — Same pattern as Reviews (3 scenarios)
5. **Selection State Reset Behavior** — Clears on filter/pagination/session change and successful delete (9 scenarios)
6. **Dashboard API Hooks** — `useDeleteReview`, `useBatchDeleteReviews`, `useBatchDeleteObservations` (4 scenarios)

Modified: Review History table gains checkbox column (colSpan 5 -> 6), Memory Browser gains observation checkboxes.

## Coverage

- **Happy paths**: Covered (single delete, batch delete, select all, deselect all)
- **Edge cases**: Covered (empty IDs, max 100 limit, partial ownership, non-existent IDs, indeterminate checkbox, virtualized selection)
- **Error states**: Covered (validation errors, auth errors, server errors, error display in dialogs, selection preserved on failure)
- **Authorization**: Covered (installation scoping, silent skip for unowned IDs, 404 instead of 403 for single delete)

## Next Step

Ready for design (`sdd-design`). If design already exists, ready for tasks (`sdd-tasks`).
