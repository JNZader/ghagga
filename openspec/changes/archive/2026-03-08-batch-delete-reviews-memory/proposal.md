# Proposal: Granular & Batch Delete for Reviews and Memory

## Intent

Dashboard users currently have coarse-grained delete controls: Reviews supports only "delete ALL reviews for a repo" (bulk wipe), and Memory supports only deleting one observation at a time. There is no way to select specific reviews for deletion, and no way to multi-select memory observations for batch deletion.

This forces users into an all-or-nothing workflow for reviews (lose everything or keep everything) and a tedious one-by-one workflow for memory observations. Both pages need granular selection with batch delete to give users efficient, precise control over their data.

## Scope

### In Scope

- **Server: Single review delete endpoint** (`DELETE /api/reviews/:reviewId`) -- delete one review by its numeric ID, with installation-scoped authorization
- **Server: Batch review delete endpoint** (`DELETE /api/reviews/batch`) -- delete multiple reviews by IDs sent in request body `{ ids: [1, 2, 3] }`, with installation-scoped authorization
- **Server: Batch memory observation delete endpoint** (`DELETE /api/memory/observations/batch`) -- delete multiple observations by IDs sent in request body `{ ids: [1, 2, 3] }`, with installation-scoped authorization
- **DB queries** in `packages/db/src/queries.ts` -- add `deleteReviewById`, `deleteReviewsByIds`, `deleteMemoryObservationsByIds` functions with proper authorization scoping through the `repositories` table
- **Dashboard: Reviews page selection UI** -- add checkboxes to review table rows, select-all checkbox in the header, "Delete Selected" button (visible only when items are selected, showing count), Tier 1 confirmation dialog
- **Dashboard: Memory page selection UI** -- add checkboxes to observation cards, select-all checkbox in the observations header area, "Delete Selected" button (visible only when items are selected, showing count), Tier 1 confirmation dialog
- **Dashboard: API hooks** in `apps/dashboard/src/lib/api.ts` -- add `useDeleteReview`, `useBatchDeleteReviews`, `useBatchDeleteObservations` mutation hooks with proper cache invalidation
- **Tests** for all new DB queries, API endpoints, and dashboard selection/delete behavior

### Out of Scope

- **Bulk repo delete** -- already exists (`DELETE /api/reviews/:repoFullName`), unchanged
- **Individual observation delete** -- already exists (`DELETE /api/memory/observations/:id`), unchanged
- **Session-level batch delete** -- selecting and deleting multiple sessions at once; out of scope for now
- **Undo/soft delete** -- reviews and observations are hard-deleted; no recycle bin
- **Export before delete** -- export functionality is a separate feature
- **Selection persistence across pages** -- selection state resets on page navigation and after successful delete

## Approach

### 1. Database Layer

Add three new query functions to `packages/db/src/queries.ts`:

```typescript
// Delete a single review by ID, scoped to installation via repository ownership
export async function deleteReviewById(
  db: Database,
  installationId: number,
  reviewId: number,
): Promise<boolean>;

// Delete multiple reviews by IDs, scoped to installation
export async function deleteReviewsByIds(
  db: Database,
  installationId: number,
  reviewIds: number[],
): Promise<number>;

// Delete multiple memory observations by IDs, scoped to installation
export async function deleteMemoryObservationsByIds(
  db: Database,
  installationId: number,
  observationIds: number[],
): Promise<number>;
```

Authorization scoping follows the existing pattern: join through `repositories` to verify the review's/observation's project belongs to the user's installation. This is identical to how `deleteMemoryObservation` already works in `queries.ts:570-592`.

For batch operations, use Drizzle's `inArray` with the provided IDs AND the installation scope subquery. PostgreSQL handles `WHERE id IN (...)` efficiently with the existing indexes on `reviews.id` and `memory_observations.id` (both are primary keys).

### 2. Server API Endpoints

Add three routes to `apps/server/src/routes/api/reviews.ts` and `apps/server/src/routes/api/memory.ts`:

| Endpoint                         | Method | Body                | Response                             | File         |
| -------------------------------- | ------ | ------------------- | ------------------------------------ | ------------ |
| `/api/reviews/:reviewId`         | DELETE | --                  | `{ data: { deleted: true } }` or 404 | `reviews.ts` |
| `/api/reviews/batch`             | DELETE | `{ ids: number[] }` | `{ data: { deletedCount: number } }` | `reviews.ts` |
| `/api/memory/observations/batch` | DELETE | `{ ids: number[] }` | `{ data: { deletedCount: number } }` | `memory.ts`  |

**Route ordering consideration**: The batch route `DELETE /api/reviews/batch` must be registered BEFORE the parameterized route `DELETE /api/reviews/:reviewId` (or use `DELETE /api/reviews/:repoFullName` disambiguation). Currently, `DELETE /api/reviews/:repoFullName` exists. Since `repoFullName` is a string like `owner/repo` and `reviewId` is a numeric ID, Hono can disambiguate:
- Register `DELETE /api/reviews/batch` first (literal match wins over param)
- Add `DELETE /api/reviews/:reviewId` with numeric validation (reject non-numeric params early)

Alternatively, the batch endpoint could be `POST /api/reviews/batch-delete` to avoid any routing ambiguity with the existing `:repoFullName` param route. Given that `:repoFullName` contains a `/` character and `reviewId` is numeric, the routes are effectively unambiguous, but using a `batch` path segment registered first is the cleanest approach.

**Validation**:
- `ids` array must be non-empty, max 100 items
- Each ID must be a positive integer
- Return 400 `VALIDATION_ERROR` for invalid input

**Authorization flow** (same as existing routes):
1. Auth middleware populates `user.installationIds`
2. DB queries scope deletes to repos owned by those installations
3. IDs that don't belong to the user's installations are silently skipped (no 403 per-item)
4. Response returns the count of actually deleted items

**Error responses** follow the existing `{ error: 'CODE', message, errorId }` envelope for 500s.

### 3. Dashboard: Selection State Management

Both Reviews and Memory pages need identical selection behavior. Implement this as local `useState` in each page component (no need for global state):

```typescript
const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
```

**Selection behavior**:
- Checkbox on each row/card toggles that item's ID in the set
- "Select all" checkbox in the header toggles ALL currently visible (filtered) items
- "Select all" is indeterminate when some (but not all) items are selected
- `selectedIds` is cleared after successful batch delete
- `selectedIds` is cleared when filters/pagination change (to avoid stale selections)
- "Delete Selected" button appears only when `selectedIds.size > 0`
- Button shows count: "Delete Selected (3)"

**Confirmation**: Both use Tier 1 (simple `ConfirmDialog`):
- Title: "Delete N reviews?" or "Delete N observations?"
- Description: "This will permanently delete the selected items. This action cannot be undone."
- No text input required (Tier 1)
- Confirm button label: "Delete"

The existing `ConfirmDialog` component supports this exact pattern -- it already handles simple confirm (no `confirmText` prop = Tier 1).

### 4. Dashboard: Reviews Page Changes

In `apps/dashboard/src/pages/Reviews.tsx`:
- Add a checkbox column as the first column in the table
- Header row: select-all checkbox (checks/unchecks all filtered reviews on current page)
- Each review row: checkbox with the review's ID
- When items are selected, show "Delete Selected (N)" button in the filter bar area
- Wire to `useBatchDeleteReviews` mutation
- On success: clear selection, show toast, invalidate queries

### 5. Dashboard: Memory Page Changes

In `apps/dashboard/src/pages/Memory.tsx`:
- Add checkboxes to `ObservationCard` components (left side, before the type badge)
- Above the observation list (in the `StatsBar` area or a new bar): select-all checkbox + "Delete Selected (N)" button when items are selected
- Wire to `useBatchDeleteObservations` mutation
- On success: clear selection, show toast, invalidate queries
- Works with both the regular list and the `VirtualizedObservationList`

### 6. Dashboard: API Hooks

Add to `apps/dashboard/src/lib/api.ts`:

```typescript
export function useDeleteReview(); // DELETE /api/reviews/:reviewId
export function useBatchDeleteReviews(); // DELETE /api/reviews/batch
export function useBatchDeleteObservations(); // DELETE /api/memory/observations/batch
```

Each mutation hook:
- Uses `useMutation` from TanStack Query
- Invalidates appropriate query keys on success (`['reviews']`, `['stats']`, `['memory', 'observations']`, `['memory', 'sessions']`)
- Passes the IDs array in the request body for batch endpoints

## Affected Areas

| Area                                    | Impact   | Description                                                                                    |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `packages/db/src/queries.ts`            | Modified | Add `deleteReviewById`, `deleteReviewsByIds`, `deleteMemoryObservationsByIds`                  |
| `apps/server/src/routes/api/reviews.ts` | Modified | Add `DELETE /api/reviews/batch` and `DELETE /api/reviews/:reviewId` routes                     |
| `apps/server/src/routes/api/memory.ts`  | Modified | Add `DELETE /api/memory/observations/batch` route                                              |
| `apps/dashboard/src/pages/Reviews.tsx`  | Modified | Add checkbox column, select-all, "Delete Selected" button, confirmation dialog                 |
| `apps/dashboard/src/pages/Memory.tsx`   | Modified | Add checkboxes to observation cards, select-all, "Delete Selected" button, confirmation dialog |
| `apps/dashboard/src/lib/api.ts`         | Modified | Add `useDeleteReview`, `useBatchDeleteReviews`, `useBatchDeleteObservations` hooks             |

## Risks

| Risk                                                                                           | Likelihood | Mitigation                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route conflict between `DELETE /api/reviews/:repoFullName` and `DELETE /api/reviews/:reviewId` | Medium     | Register `/api/reviews/batch` before the param route. For single delete, validate `:reviewId` is numeric and return 400 if not, falling through to `:repoFullName` behavior. Alternatively, use path `/api/reviews/by-id/:reviewId` to avoid ambiguity entirely. |
| User accidentally batch-deletes items they want to keep                                        | Low        | Tier 1 confirmation dialog showing exact count ("Delete 15 reviews?"). Selection requires explicit checkbox interaction -- no drag-select or keyboard shortcuts that could cause accidental selection.                                                           |
| Batch delete of large ID arrays causes slow query                                              | Low        | Cap `ids` array at 100 items. PostgreSQL handles `WHERE id IN (...)` efficiently against primary key indexes. Dashboard pagination already limits visible items to 50 reviews per page.                                                                          |
| `VirtualizedObservationList` checkbox state out of sync with virtualized rows                  | Medium     | Store selection state in a `Set<number>` in the parent component, not in the virtualized row. Each row reads from the set on render. The virtualizer only controls DOM recycling, not state.                                                                     |
| Stats become stale after deleting reviews                                                      | Low        | Invalidate `['stats']` query key on successful review delete. TanStack Query handles automatic refetch.                                                                                                                                                          |

## Rollback Plan

1. **Database queries are additive**: The 3 new functions in `queries.ts` don't modify existing queries. `git revert` removes them cleanly.
2. **API routes are additive**: The 3 new routes don't affect existing `DELETE /api/reviews/:repoFullName` or `DELETE /api/memory/observations/:id`. Removing them restores previous behavior.
3. **Dashboard UI is backward-compatible**: Reverting Reviews.tsx and Memory.tsx changes removes checkboxes and batch delete buttons. The existing bulk-repo-delete and single-observation-delete continue working unchanged.
4. **No schema migrations**: All operations use existing tables and columns (`reviews.id`, `memory_observations.id`). Zero database work required for rollback.
5. **No new dependencies**: All functionality uses existing packages (Drizzle, Hono, TanStack Query, React).

## Dependencies

- Existing `ConfirmDialog` component -- reused as-is for Tier 1 confirmation
- Existing auth middleware -- reused as-is for all new routes
- Existing `fetchApi` / `fetchData` utilities in dashboard `api.ts`
- Existing DB indexes on `reviews.id` (PK) and `memory_observations.id` (PK) -- no new indexes needed

## Success Criteria

- [ ] `DELETE /api/reviews/:reviewId` deletes a single review, returns `{ data: { deleted: true } }`, returns 404 if not found or not authorized
- [ ] `DELETE /api/reviews/batch` with `{ ids: [1,2,3] }` deletes matching reviews, returns `{ data: { deletedCount: N } }`
- [ ] `DELETE /api/memory/observations/batch` with `{ ids: [1,2,3] }` deletes matching observations, returns `{ data: { deletedCount: N } }`
- [ ] All new endpoints return 400 for invalid input (empty ids, non-numeric, >100 items)
- [ ] All new endpoints return 401 without valid auth token
- [ ] IDs belonging to other installations are silently skipped (no cross-tenant deletion)
- [ ] Reviews page shows checkboxes on each row with a select-all checkbox in the header
- [ ] Memory page shows checkboxes on each observation card with a select-all control
- [ ] "Delete Selected" button appears only when items are selected, showing count
- [ ] Tier 1 confirmation dialog shown before batch delete ("Delete N items?")
- [ ] Selection state clears after successful delete
- [ ] Selection state clears when filters or pagination change
- [ ] After deletion, review list, stats, and memory queries are automatically refreshed
- [ ] Existing bulk-repo-delete and single-observation-delete continue working unchanged
