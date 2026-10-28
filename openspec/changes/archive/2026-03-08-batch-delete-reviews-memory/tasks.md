# Tasks: Granular & Batch Delete for Reviews and Memory

## Phase 1: Database Layer

- [ ] 1.1 Add `deleteReviewById(db, installationId, reviewId)` to `packages/db/src/queries.ts`
  - Follow the `deleteMemoryObservation` pattern (line 570-592): DELETE with `eq(reviews.id, reviewId)` AND `inArray(reviews.repositoryId, subquery on repositories where installationId matches)`
  - Return `true` if a row was deleted, `false` otherwise
  - Add corresponding test in `packages/db/src/__tests__/queries.test.ts` covering: owned review deleted, unowned review returns false, non-existent ID returns false

- [ ] 1.2 Add `deleteReviewsByIds(db, installationId, reviewIds)` to `packages/db/src/queries.ts`
  - Early return 0 for empty array (same pattern as `deleteStaleUserMappings` line 884-888)
  - DELETE with `inArray(reviews.id, reviewIds)` AND installation scope subquery
  - Return `result.length` (count of deleted rows)
  - Add test covering: deletes only owned reviews, returns correct count, empty array returns 0

- [ ] 1.3 Add `deleteMemoryObservationsByIds(db, installationId, observationIds)` to `packages/db/src/queries.ts`
  - Early return 0 for empty array
  - DELETE with `inArray(memoryObservations.id, observationIds)` AND `inArray(memoryObservations.project, subquery on repositories.fullName)` — same scoping as `deleteMemoryObservation` (line 578-588)
  - Return `result.length`
  - Add test covering: deletes only owned observations, returns correct count, empty array returns 0

## Phase 2: Server API Endpoints

- [ ] 2.1 Add `DELETE /api/reviews/batch` route to `apps/server/src/routes/api/reviews.ts`
  - Register BEFORE the existing `DELETE /api/reviews/:repoFullName` route (line 120)
  - Zod validation: `{ ids: z.array(z.number().int().positive()).min(1).max(100) }`
  - Return 400 `VALIDATION_ERROR` on invalid input
  - Loop over `user.installationIds`, call `deleteReviewsByIds`, sum counts
  - Return `{ data: { deletedCount } }`
  - Import `deleteReviewsByIds` from `ghagga-db`
  - Add test: valid batch, partial ownership, empty ids (400), >100 ids (400), non-integer ids (400), unauthenticated (401), server error (500)

- [ ] 2.2 Add `DELETE /api/reviews/:reviewId` route to `apps/server/src/routes/api/reviews.ts`
  - Register AFTER the batch route but BEFORE `DELETE /api/reviews/:repoFullName`
  - Validate `:reviewId` is numeric (`/^\d+$/`); return 400 `VALIDATION_ERROR` if not (disambiguates from `:repoFullName` which contains `/`)
  - Loop over `user.installationIds`, call `deleteReviewById`; if any returns true, respond `{ data: { deleted: true } }`
  - If none deleted, return 404 `NOT_FOUND`
  - Import `deleteReviewById` from `ghagga-db`
  - Add test: delete owned review, not-found (404), unowned (404), non-numeric param (400), unauthenticated (401)

- [ ] 2.3 Add `DELETE /api/memory/observations/batch` route to `apps/server/src/routes/api/memory.ts`
  - Register AFTER `DELETE /api/memory/observations` (purge-all, line 88) and BEFORE `DELETE /api/memory/observations/:id` (line 111)
  - Same Zod schema as 2.1: `{ ids: z.array(z.number().int().positive()).min(1).max(100) }`
  - Loop over `user.installationIds`, call `deleteMemoryObservationsByIds`, sum counts
  - Return `{ data: { deletedCount } }`
  - Import `deleteMemoryObservationsByIds` from `ghagga-db`
  - Add test: valid batch, partial ownership, empty ids (400), >100 ids (400), unauthenticated (401), server error (500)

## Phase 3: Dashboard API Hooks

- [ ] 3.1 Add `useDeleteReview`, `useBatchDeleteReviews`, and `useBatchDeleteObservations` hooks to `apps/dashboard/src/lib/api.ts`
  - `useDeleteReview()`: calls `fetchData<{ deleted: boolean }>(\`/api/reviews/${reviewId}\`, { method: 'DELETE' })`, invalidates `['reviews']`and`['stats']`
  - `useBatchDeleteReviews()`: calls `fetchData<{ deletedCount: number }>('/api/reviews/batch', { method: 'DELETE', body: JSON.stringify({ ids }) })`, invalidates `['reviews']` and `['stats']`
  - `useBatchDeleteObservations()`: calls `fetchData<{ deletedCount: number }>('/api/memory/observations/batch', { method: 'DELETE', body: JSON.stringify({ ids }) })`, invalidates `['memory', 'observations']` and `['memory', 'sessions']`
  - Follow existing mutation patterns (e.g., `useDeleteObservation` at line 243-255)

## Phase 4: Dashboard UI — Reviews Page

- [ ] 4.1 Add checkbox selection and "Delete Selected" to `apps/dashboard/src/pages/Reviews.tsx`
  - Add `const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())` state
  - Add checkbox column as first column in the table header with select-all (indeterminate when partial)
  - Add checkbox to each review row (toggle ID in set); checkbox click must `e.stopPropagation()` to not trigger row click (detail modal)
  - Update `colSpan` from 5 to 6 on loading/empty `<td>` elements (lines 198, 204)
  - Add "Delete Selected (N)" button in the filter bar (visible only when `selectedIds.size > 0`), styled like the existing "Delete Reviews" button
  - Wire button to `ConfirmDialog` (Tier 1, no `confirmText`): title "Delete N review(s)?", description about permanent deletion
  - On confirm: call `useBatchDeleteReviews` with `Array.from(selectedIds)`; on success clear selection, show toast with actual `deletedCount`, invalidate queries
  - On error: display error in dialog, preserve selection
  - Clear `selectedIds` when `selectedRepo`, `statusFilter`, `search`, or `page` change (useEffect or inline in onChange handlers)

## Phase 5: Dashboard UI — Memory Page

- [ ] 5.1 Add checkbox selection and "Delete Selected" to `apps/dashboard/src/pages/Memory.tsx`
  - Add `const [selectedObsIds, setSelectedObsIds] = useState<Set<number>>(new Set())` state in the `Memory` component
  - Add checkbox to `ObservationCard` component: positioned left side before the type badge, `e.stopPropagation()` on click to not trigger card click. Pass `isSelected` and `onToggleSelect` as new props
  - Add select-all checkbox + "Delete Selected (N)" button above the observation list (near `StatsBar`). Select-all toggles all `filteredObservations` IDs. Show indeterminate state when partial
  - Pass `selectedIds` set and toggle callback to `VirtualizedObservationList` as props; wire to each `ObservationCard`
  - Wire "Delete Selected" button to `ConfirmDialog` (Tier 1): title "Delete N observation(s)?", description about permanent deletion
  - On confirm: call `useBatchDeleteObservations` with `Array.from(selectedObsIds)`; on success clear selection, show toast with `deletedCount`
  - On error: display error in dialog, preserve selection
  - Clear `selectedObsIds` when `selectedSessionId`, `severityFilter`, `sortOption`, or `search` change

## Verification

- [ ] 6.1 Manual smoke test
  - Build (`pnpm build`) — verify no type errors
  - Run existing tests (`pnpm test`) — verify nothing regressed
  - Verify route ordering: `batch` literal matches before `:reviewId` param, and `:reviewId` numeric validation prevents conflict with `:repoFullName`
