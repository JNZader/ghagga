# Delta for Dashboard UI

> **Change**: `batch-delete-reviews-memory`
> **Base spec**: `openspec/specs/dashboard-ui/spec.md`

## ADDED Requirements

### Requirement: Reviews Page Row Selection

The Reviews page MUST support selecting individual reviews via checkboxes for batch operations.

A checkbox column MUST be added as the first column in the review table. Each review row MUST have a checkbox that toggles that review's ID in the selection set. The checkbox MUST NOT interfere with the existing row click behavior (opening the review detail modal).

A select-all checkbox MUST appear in the table header row. It MUST toggle selection of all currently visible (filtered) reviews on the current page. When all visible reviews are selected, the select-all checkbox MUST be checked. When some (but not all) visible reviews are selected, the select-all checkbox MUST be in an indeterminate state. When no visible reviews are selected, the select-all checkbox MUST be unchecked.

Selection state MUST be managed as local component state using `useState<Set<number>>`.

#### Scenario: Select a single review

- GIVEN the Reviews page is showing 10 reviews
- AND no reviews are selected
- WHEN the user clicks the checkbox on the 3rd review row
- THEN the 3rd review's ID MUST be added to the selection set
- AND the select-all checkbox MUST show an indeterminate state
- AND clicking the review row itself (not the checkbox) MUST still open the detail modal

#### Scenario: Deselect a selected review

- GIVEN review 42 is currently selected
- WHEN the user clicks the checkbox on review 42's row
- THEN review 42 MUST be removed from the selection set

#### Scenario: Select all visible reviews

- GIVEN 10 reviews are visible after filtering
- AND 2 of them are already selected
- WHEN the user clicks the select-all checkbox
- THEN all 10 visible review IDs MUST be in the selection set

#### Scenario: Deselect all via select-all checkbox

- GIVEN all 10 visible reviews are selected
- WHEN the user clicks the select-all checkbox
- THEN the selection set MUST be empty

#### Scenario: Indeterminate state of select-all

- GIVEN 10 reviews are visible
- AND 3 of them are selected
- THEN the select-all checkbox MUST render in the indeterminate state (neither fully checked nor unchecked)

### Requirement: Reviews Page Batch Delete Action

A "Delete Selected" button MUST appear in the filter bar area ONLY when at least one review is selected (`selectedIds.size > 0`). The button MUST display the count of selected items: "Delete Selected (N)".

Clicking the button MUST open a Tier 1 `ConfirmDialog` (no text input required):
- Title: "Delete N review(s)?"
- Description: "This will permanently delete the selected reviews. This action cannot be undone."
- Confirm label: "Delete"
- Confirm variant: `danger`

On confirm, the system MUST call the `useBatchDeleteReviews` mutation with the array of selected IDs. On success, the system MUST:
- Clear the selection set
- Show a success toast with the count of deleted reviews
- Invalidate the `['reviews']` and `['stats']` TanStack Query keys

On error, the `ConfirmDialog` MUST display the error message.

#### Scenario: Delete Selected button visibility

- GIVEN no reviews are selected
- THEN the "Delete Selected" button MUST NOT be visible
- WHEN the user selects 3 reviews
- THEN the button MUST appear with text "Delete Selected (3)"

#### Scenario: Successful batch delete from Reviews page

- GIVEN the user has selected 5 reviews
- WHEN the user clicks "Delete Selected (5)"
- AND confirms in the Tier 1 dialog
- THEN the batch delete mutation MUST be called with the 5 IDs
- AND on success, the selection set MUST be cleared
- AND a success toast MUST show "Deleted 5 reviews"
- AND the review list MUST refresh

#### Scenario: Batch delete with server returning partial count

- GIVEN the user has selected 5 reviews
- AND the server responds with `{ data: { deletedCount: 3 } }` (2 were already deleted or unauthorized)
- WHEN the batch delete completes
- THEN the success toast MUST show "Deleted 3 reviews"
- AND the selection set MUST be cleared

#### Scenario: Batch delete error

- GIVEN the user confirms the batch delete dialog
- AND the server returns an error
- THEN the error message MUST be displayed in the ConfirmDialog
- AND the selection MUST NOT be cleared
- AND the dialog MUST remain open

### Requirement: Memory Page Observation Selection

The Memory page MUST support selecting individual observations via checkboxes for batch operations.

A checkbox MUST be added to each `ObservationCard` component, positioned on the left side before the type badge. The checkbox MUST NOT interfere with the existing card click behavior (opening the observation detail modal) or the existing per-observation delete button.

A select-all checkbox MUST appear in the area above the observation list (near the `StatsBar`). It MUST toggle selection of all currently visible (filtered and sorted) observations. The same indeterminate logic as the Reviews page MUST apply.

Selection state MUST be managed as local component state using `useState<Set<number>>` in the `Memory` component. The `VirtualizedObservationList` MUST receive the selection set and a toggle callback as props; the selection state MUST NOT be stored inside virtualized row components.

#### Scenario: Select a single observation

- GIVEN the Memory page shows 15 observations for a selected session
- AND no observations are selected
- WHEN the user clicks the checkbox on observation card 7
- THEN observation 7's ID MUST be added to the selection set
- AND clicking the card body MUST still open the observation detail modal

#### Scenario: Select all observations

- GIVEN 15 observations are visible
- WHEN the user clicks the select-all checkbox
- THEN all 15 observation IDs MUST be in the selection set

#### Scenario: Deselect all observations

- GIVEN all observations are selected
- WHEN the user clicks the select-all checkbox
- THEN the selection set MUST be empty

#### Scenario: Selection works with virtualized list

- GIVEN more than 20 observations are displayed (triggering virtualization)
- WHEN the user scrolls and selects an observation that was previously off-screen
- THEN the observation MUST be added to the selection set
- AND scrolling back to previously selected items MUST still show their checkboxes as checked

#### Scenario: Indeterminate select-all with filter active

- GIVEN 15 observations are visible with severity filter set to "critical" showing 4 results
- AND 2 of the 4 are selected
- THEN the select-all checkbox MUST show indeterminate state
- AND clicking select-all MUST select all 4 filtered observations (not all 15)

### Requirement: Memory Page Batch Delete Action

A "Delete Selected" button MUST appear above the observation list ONLY when at least one observation is selected. The button MUST display the count: "Delete Selected (N)".

Clicking the button MUST open a Tier 1 `ConfirmDialog`:
- Title: "Delete N observation(s)?"
- Description: "This will permanently delete the selected observations. This action cannot be undone."
- Confirm label: "Delete"
- Confirm variant: `danger`

On confirm, the system MUST call the `useBatchDeleteObservations` mutation with the array of selected IDs. On success, the system MUST:
- Clear the selection set
- Show a success toast with the count of deleted observations
- Invalidate the `['memory', 'observations']` and `['memory', 'sessions']` TanStack Query keys

#### Scenario: Delete Selected button visibility

- GIVEN no observations are selected
- THEN the "Delete Selected" button MUST NOT be visible
- WHEN the user selects 3 observations
- THEN the button MUST appear with text "Delete Selected (3)"

#### Scenario: Successful batch delete from Memory page

- GIVEN the user has selected 5 observations
- WHEN the user clicks "Delete Selected (5)"
- AND confirms in the Tier 1 dialog
- THEN the batch delete mutation MUST be called with the 5 IDs
- AND on success, the selection set MUST be cleared
- AND a success toast MUST show "Deleted 5 observations"
- AND the observation list and session sidebar MUST refresh

#### Scenario: Batch delete error on Memory page

- GIVEN the user confirms the batch delete dialog
- AND the server returns an error
- THEN the error message MUST be displayed in the ConfirmDialog
- AND the selection MUST NOT be cleared

### Requirement: Selection State Reset Behavior

Selection state on both the Reviews and Memory pages MUST be cleared automatically in the following situations to prevent stale selections:
1. **After successful batch delete**: The selection set MUST be cleared when the batch delete mutation succeeds.
2. **On filter change**: The selection set MUST be cleared when any filter control changes (repository select, status filter, search text, severity filter, sort option).
3. **On pagination change**: The selection set MUST be cleared when the user navigates to a different page (Reviews page only, since Memory observations are not paginated).
4. **On session change**: The selection set MUST be cleared when the user selects a different memory session (Memory page only).

Selection state MUST NOT persist across page navigation (it is local `useState`, not global store).

#### Scenario: Selection clears on repo filter change (Reviews)

- GIVEN 3 reviews are selected on the Reviews page
- WHEN the user changes the repository dropdown
- THEN the selection set MUST be empty

#### Scenario: Selection clears on status filter change (Reviews)

- GIVEN 3 reviews are selected
- WHEN the user changes the status filter dropdown
- THEN the selection set MUST be empty

#### Scenario: Selection clears on search text change (Reviews)

- GIVEN 3 reviews are selected
- WHEN the user types in the search input
- THEN the selection set MUST be empty

#### Scenario: Selection clears on page change (Reviews)

- GIVEN 3 reviews are selected on page 1
- WHEN the user clicks "Next" to go to page 2
- THEN the selection set MUST be empty

#### Scenario: Selection clears on session change (Memory)

- GIVEN 3 observations are selected for session A
- WHEN the user clicks on session B in the sidebar
- THEN the selection set MUST be empty

#### Scenario: Selection clears on severity filter change (Memory)

- GIVEN 3 observations are selected
- WHEN the user changes the severity filter dropdown
- THEN the selection set MUST be empty

#### Scenario: Selection clears on sort change (Memory)

- GIVEN 3 observations are selected
- WHEN the user changes the sort dropdown
- THEN the selection set MUST be empty

#### Scenario: Selection clears after successful delete

- GIVEN 5 reviews are selected
- AND the batch delete succeeds
- THEN the selection set MUST be empty

#### Scenario: Selection preserved on failed delete

- GIVEN 5 reviews are selected
- AND the batch delete fails
- THEN the selection set MUST still contain all 5 review IDs

### Requirement: Dashboard API Hooks for Granular and Batch Deletes

The `apps/dashboard/src/lib/api.ts` module MUST export three new mutation hooks:
1. **`useDeleteReview()`** — Calls `DELETE /api/reviews/:reviewId`. On success, MUST invalidate `['reviews']` and `['stats']` query keys.

2. **`useBatchDeleteReviews()`** — Calls `DELETE /api/reviews/batch` with body `{ ids: number[] }`. On success, MUST invalidate `['reviews']` and `['stats']` query keys.

3. **`useBatchDeleteObservations()`** — Calls `DELETE /api/memory/observations/batch` with body `{ ids: number[] }`. On success, MUST invalidate `['memory', 'observations']` and `['memory', 'sessions']` query keys.

All hooks MUST follow the existing pattern: use `useMutation` from TanStack Query, call `fetchData` with the appropriate method and body, and invalidate via `useQueryClient`.

#### Scenario: useDeleteReview invalidates correct queries

- GIVEN the user deletes review 42 via `useDeleteReview`
- WHEN the mutation succeeds
- THEN the `['reviews']` query key MUST be invalidated
- AND the `['stats']` query key MUST be invalidated

#### Scenario: useBatchDeleteReviews sends correct request

- GIVEN the user calls `useBatchDeleteReviews` with IDs [10, 20, 30]
- WHEN the mutation fires
- THEN the request MUST be `DELETE /api/reviews/batch` with JSON body `{ "ids": [10, 20, 30] }`

#### Scenario: useBatchDeleteObservations sends correct request

- GIVEN the user calls `useBatchDeleteObservations` with IDs [5, 10, 15]
- WHEN the mutation fires
- THEN the request MUST be `DELETE /api/memory/observations/batch` with JSON body `{ "ids": [5, 10, 15] }`

#### Scenario: useBatchDeleteObservations invalidates correct queries

- GIVEN the batch observation delete succeeds
- THEN the `['memory', 'observations']` query key MUST be invalidated
- AND the `['memory', 'sessions']` query key MUST be invalidated

## MODIFIED Requirements

### Requirement: Review History (Modified)

The review table MUST now include a checkbox column as its first column.

(Previously: The table had columns: status, repository, PR number, date, mode. No checkbox column existed.)

The `colSpan` on empty/loading state `<td>` elements MUST be updated from 5 to 6 to account for the new checkbox column.

#### Scenario: View review list with checkboxes

- GIVEN a logged-in user with reviews
- WHEN the user navigates to the Reviews page
- THEN the table MUST display columns: checkbox, status, repository, PR number, mode, date
- AND each row MUST have a functional checkbox
- AND the header MUST have a select-all checkbox

### Requirement: Memory Browser (Modified)

The observation cards MUST now include a checkbox for selection.

(Previously: Observation cards had a type badge, severity badge, title, content preview, file paths, and a delete button. No checkbox existed.)

#### Scenario: Browse observations with checkboxes

- GIVEN a user viewing observations for a selected session
- WHEN the observations load
- THEN each observation card MUST display a checkbox on the left side
- AND a select-all checkbox MUST appear above the observation list
- AND a "Delete Selected" button MUST appear when items are selected

## REMOVED Requirements

_(No existing dashboard requirements are removed by this change.)_
