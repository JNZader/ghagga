# Spec: Dashboard Memory Management — Full-Stack Delete/Clear/Purge

> **Domain**: Memory (Dashboard)  
> **Change**: `dashboard-memory-management`  
> **Type**: DELTA (extends `openspec/specs/memory-storage/spec.md`)  
> **Status**: Draft  
> **Depends on**: `memory-management` (archived 2026-03-06, which added MemoryStorage management methods + CLI commands)  

## Overview

This specification defines the full-stack implementation of memory management for SaaS Dashboard users. It replaces the 5 stub methods in `PostgresMemoryStorage` (which currently throw `Error('Not implemented')`) with real implementations, adds 3 DELETE API endpoints, adds 3 PostgreSQL query functions to `packages/db`, and builds the Dashboard UI with a **3-tier confirmation system** proportional to the blast radius of each destructive action.

The 3-tier confirmation system:
- **Tier 1** (delete 1 observation): Simple modal with "Cancel" / "Delete" buttons
- **Tier 2** (clear 1 repo's memory): Modal + text input requiring the exact repo name to enable confirm
- **Tier 3** (purge ALL memory): Modal + text input requiring "DELETE ALL" + confirm button disabled for 5 seconds with visible countdown

All operations are scoped to the authenticated user's GitHub installation(s) — no cross-tenant access is possible.

---

## Requirements

### R1: Database Query — Delete Single Observation

A function `deleteMemoryObservation(db, installationId, observationId)` MUST be added to `packages/db/src/queries.ts`.

The function MUST:
- Delete the observation with the given `observationId` WHERE the observation's project belongs to a repository with the given `installationId`
- Return `true` if a row was deleted, `false` if the observation was not found or did not belong to the installation
- Use a single SQL statement that joins `memory_observations.project` to `repositories.full_name` and filters by `repositories.installation_id = installationId`

The function MUST NOT delete observations belonging to other installations, even if the `observationId` matches.

#### Scenario: S1 — Delete existing observation owned by user

- GIVEN an observation with id=42 exists for project "acme/widgets"
- AND "acme/widgets" belongs to installation 100
- WHEN `deleteMemoryObservation(db, 100, 42)` is called
- THEN the observation MUST be deleted from the database
- AND the function MUST return `true`

#### Scenario: S2 — Delete observation not found

- GIVEN no observation with id=999 exists
- WHEN `deleteMemoryObservation(db, 100, 999)` is called
- THEN no rows MUST be deleted
- AND the function MUST return `false`

#### Scenario: S3 — IDOR prevention — observation belongs to different installation

- GIVEN an observation with id=42 exists for project "evil/repo"
- AND "evil/repo" belongs to installation 200 (not the caller's)
- WHEN `deleteMemoryObservation(db, 100, 42)` is called
- THEN no rows MUST be deleted
- AND the function MUST return `false`

---

### R2: Database Query — Clear Observations by Project

A function `clearMemoryObservationsByProject(db, installationId, project)` MUST be added to `packages/db/src/queries.ts`.

The function MUST:
- Delete all observations WHERE `project` matches AND the project's repository belongs to the given `installationId`
- Return the count of deleted rows (integer >= 0)

The function MUST NOT delete observations for projects belonging to other installations.

#### Scenario: S4 — Clear all observations for a repo

- GIVEN 15 observations exist for project "acme/widgets"
- AND "acme/widgets" belongs to installation 100
- WHEN `clearMemoryObservationsByProject(db, 100, "acme/widgets")` is called
- THEN all 15 observations MUST be deleted
- AND the function MUST return `15`

#### Scenario: S5 — Clear repo with no observations (no-op)

- GIVEN 0 observations exist for project "acme/empty-repo"
- AND "acme/empty-repo" belongs to installation 100
- WHEN `clearMemoryObservationsByProject(db, 100, "acme/empty-repo")` is called
- THEN no rows MUST be deleted
- AND the function MUST return `0`

#### Scenario: S6 — Clear repo belonging to different installation

- GIVEN observations exist for project "evil/repo" belonging to installation 200
- WHEN `clearMemoryObservationsByProject(db, 100, "evil/repo")` is called
- THEN no rows MUST be deleted
- AND the function MUST return `0`

---

### R3: Database Query — Clear All Observations for Installation

A function `clearAllMemoryObservations(db, installationId)` MUST be added to `packages/db/src/queries.ts`.

The function MUST:
- Delete all observations WHERE the observation's project belongs to a repository with the given `installationId`
- Return the count of deleted rows (integer >= 0)

The function MUST NOT delete observations for projects belonging to other installations.

#### Scenario: S7 — Purge all observations for an installation

- GIVEN 50 observations exist across projects "acme/widgets" (30) and "acme/gadgets" (20)
- AND both projects belong to installation 100
- AND 10 observations exist for "other/repo" belonging to installation 200
- WHEN `clearAllMemoryObservations(db, 100)` is called
- THEN 50 observations MUST be deleted (30 + 20)
- AND the function MUST return `50`
- AND the 10 observations for "other/repo" MUST NOT be deleted

#### Scenario: S8 — Purge when nothing to purge

- GIVEN 0 observations exist for any project belonging to installation 100
- WHEN `clearAllMemoryObservations(db, 100)` is called
- THEN no rows MUST be deleted
- AND the function MUST return `0`

---

### R4: Server API — DELETE /api/memory/observations/:id

A `DELETE /api/memory/observations/:id` route MUST be added to `createApiRouter` in `apps/server/src/routes/api.ts`.

The route MUST:
- Require authentication (existing `authMiddleware`)
- Parse `:id` as an integer; return 400 if not a valid number
- Look up the observation's project, then verify the project's repository belongs to one of `user.installationIds`; return 403 if not authorized
- Call `deleteMemoryObservation(db, installationId, observationId)`
- Return `200 { data: { deleted: true } }` on success
- Return `404 { error: "Observation not found" }` if the observation does not exist or is not accessible

#### Scenario: S9 — Delete observation via API (happy path)

- GIVEN the user is authenticated with installationIds [100]
- AND observation id=42 exists for project "acme/widgets" (installation 100)
- WHEN `DELETE /api/memory/observations/42` is sent
- THEN the response MUST be `200 { data: { deleted: true } }`
- AND the observation MUST be deleted from the database

#### Scenario: S10 — Delete observation — not authenticated

- GIVEN the request has no valid auth token
- WHEN `DELETE /api/memory/observations/42` is sent
- THEN the response MUST be `401`

#### Scenario: S11 — Delete observation — not found

- GIVEN the user is authenticated with installationIds [100]
- AND no observation with id=999 exists (or it belongs to another installation)
- WHEN `DELETE /api/memory/observations/999` is sent
- THEN the response MUST be `404 { error: "Observation not found" }`

#### Scenario: S12 — Delete observation — invalid ID format

- GIVEN the user is authenticated
- WHEN `DELETE /api/memory/observations/abc` is sent
- THEN the response MUST be `400 { error: "Invalid observation ID" }`

---

### R5: Server API — DELETE /api/memory/projects/:project/observations

A `DELETE /api/memory/projects/:project/observations` route MUST be added to `createApiRouter`.

The `:project` parameter MUST be URL-decoded to handle `owner/repo` format (e.g., `acme%2Fwidgets` decodes to `acme/widgets`).

The route MUST:
- Require authentication
- Look up the repository by `project` (decoded); return 404 if not found
- Verify `repo.installationId` is in `user.installationIds`; return 403 if not authorized
- Call `clearMemoryObservationsByProject(db, repo.installationId, project)`
- Return `200 { data: { cleared: N } }` where N is the count of deleted rows

#### Scenario: S13 — Clear repo observations via API (happy path)

- GIVEN the user is authenticated with installationIds [100]
- AND "acme/widgets" has 15 observations and belongs to installation 100
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 15 } }`
- AND all 15 observations MUST be deleted

#### Scenario: S14 — Clear repo — not authenticated

- GIVEN the request has no valid auth token
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `401`

#### Scenario: S15 — Clear repo — repo not found

- GIVEN the user is authenticated
- AND no repository "nonexistent/repo" exists in the database
- WHEN `DELETE /api/memory/projects/nonexistent%2Frepo/observations` is sent
- THEN the response MUST be `404 { error: "Repository not found" }`

#### Scenario: S16 — Clear repo — forbidden (different installation)

- GIVEN the user is authenticated with installationIds [100]
- AND "evil/repo" belongs to installation 200
- WHEN `DELETE /api/memory/projects/evil%2Frepo/observations` is sent
- THEN the response MUST be `403 { error: "Forbidden" }`

#### Scenario: S17 — Clear repo — zero observations (no-op success)

- GIVEN the user is authenticated with installationIds [100]
- AND "acme/widgets" belongs to installation 100 but has 0 observations
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

---

### R6: Server API — DELETE /api/memory/observations

A `DELETE /api/memory/observations` route MUST be added to `createApiRouter`.

The route MUST:
- Require authentication
- Determine the user's primary installation ID from `user.installationIds`
- Call `clearAllMemoryObservations(db, installationId)` for each installation ID, summing the results
- Return `200 { data: { cleared: N } }` where N is the total count of deleted rows

The route MUST NOT conflict with the `DELETE /api/memory/observations/:id` route. The Hono router MUST resolve the parameterized route for numeric paths and the bare route for the no-param case.

#### Scenario: S18 — Purge all observations via API (happy path)

- GIVEN the user is authenticated with installationIds [100]
- AND 50 observations exist across all repos belonging to installation 100
- WHEN `DELETE /api/memory/observations` is sent (no path params)
- THEN the response MUST be `200 { data: { cleared: 50 } }`
- AND all 50 observations MUST be deleted

#### Scenario: S19 — Purge all — not authenticated

- GIVEN the request has no valid auth token
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `401`

#### Scenario: S20 — Purge all — nothing to purge

- GIVEN the user is authenticated with installationIds [100]
- AND 0 observations exist for installation 100
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

#### Scenario: S21 — Purge all — multiple installations

- GIVEN the user is authenticated with installationIds [100, 200]
- AND installation 100 has 30 observations and installation 200 has 20 observations
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 50 } }`
- AND all observations for both installations MUST be deleted

---

### R7: PostgresMemoryStorage — Implement Stub Methods

The 5 stub methods in `apps/server/src/memory/postgres.ts` that currently throw `Error('Not implemented')` MUST be replaced with real implementations.

Each method MUST delegate to the appropriate `ghagga-db` query function:

| Method                        | Delegates To                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `listObservations(options?)`  | New `listMemoryObservations(db, installationId, options)` query                                             |
| `getObservation(id)`          | New `getMemoryObservation(db, installationId, id)` query                                                    |
| `deleteObservation(id)`       | `deleteMemoryObservation(db, installationId, id)` (R1)                                                      |
| `getStats()`                  | New `getMemoryStats(db, installationId)` query                                                              |
| `clearObservations(options?)` | `clearMemoryObservationsByProject` (R2) or `clearAllMemoryObservations` (R3) depending on `options.project` |

The `PostgresMemoryStorage` constructor MUST be extended to accept an `installationId: number` parameter (or the adapter must receive it per-call via the API route context).

Note: The `listMemoryObservations`, `getMemoryObservation`, and `getMemoryStats` query functions are additional read queries needed to support the existing Dashboard memory page. They are additive and MUST be scoped by `installationId`.

#### Scenario: S22 — listObservations returns observations for installation

- GIVEN a `PostgresMemoryStorage` instance for installation 100
- AND observations exist for projects belonging to installation 100
- WHEN `listObservations({ project: "acme/widgets", limit: 10 })` is called
- THEN it MUST return `MemoryObservationDetail[]` filtered by project and installation
- AND no observations from other installations MUST be returned

#### Scenario: S23 — getObservation returns detail or null

- GIVEN a `PostgresMemoryStorage` instance for installation 100
- AND observation id=42 exists for a project belonging to installation 100
- WHEN `getObservation(42)` is called
- THEN it MUST return a `MemoryObservationDetail` object with all fields

#### Scenario: S24 — getObservation returns null for non-existent

- GIVEN no observation with id=999 exists (or it belongs to another installation)
- WHEN `getObservation(999)` is called
- THEN it MUST return `null`

#### Scenario: S25 — deleteObservation delegates to DB query

- GIVEN observation id=42 exists for installation 100
- WHEN `deleteObservation(42)` is called
- THEN `deleteMemoryObservation(db, 100, 42)` MUST be called
- AND the method MUST return `true`

#### Scenario: S26 — getStats returns aggregate data

- GIVEN observations exist for installation 100
- WHEN `getStats()` is called
- THEN it MUST return a `MemoryStats` object with `totalObservations`, `byType`, `byProject`, `oldestObservation`, `newestObservation`
- AND only observations for installation 100 MUST be counted

#### Scenario: S27 — clearObservations with project

- GIVEN observations exist for "acme/widgets" belonging to installation 100
- WHEN `clearObservations({ project: "acme/widgets" })` is called
- THEN `clearMemoryObservationsByProject(db, 100, "acme/widgets")` MUST be called
- AND it MUST return the count of deleted rows

#### Scenario: S28 — clearObservations without project (purge all)

- GIVEN observations exist for installation 100
- WHEN `clearObservations()` is called (no project filter)
- THEN `clearAllMemoryObservations(db, 100)` MUST be called
- AND it MUST return the count of deleted rows

---

### R8: Dashboard UI — Tier 1 Confirmation (Delete Single Observation)

Each `ObservationCard` in `apps/dashboard/src/pages/Memory.tsx` MUST display a delete button (trash icon) in the top-right corner.

When the user clicks the delete button, a simple confirmation modal MUST appear with:
- Title: "Delete observation"
- Body: The observation's title and type
- Two buttons: "Cancel" (secondary) and "Delete" (destructive/red)

Clicking "Cancel" or pressing Escape MUST close the modal without any action.
Clicking "Delete" MUST:
- Call the `useDeleteObservation` mutation
- Show a loading state on the button while the request is in flight
- On success: close the modal, remove the observation from the UI, and show a success toast/notification
- On error: show an error message in the modal without closing it

#### Scenario: S29 — Delete single observation via UI (happy path)

- GIVEN the user is viewing the Memory page with observations loaded
- AND observation "OAuth token refresh patterns" is visible
- WHEN the user clicks the trash icon on that observation
- THEN a confirmation modal MUST appear with the title "Delete observation"
- AND the modal MUST show the observation title
- WHEN the user clicks "Delete"
- THEN the observation MUST be removed from the UI
- AND a success message MUST be shown

#### Scenario: S30 — Cancel single delete

- GIVEN the Tier 1 confirmation modal is open
- WHEN the user clicks "Cancel"
- THEN the modal MUST close
- AND no API request MUST be made
- AND the observation MUST remain visible

#### Scenario: S31 — Dismiss modal with Escape key

- GIVEN the Tier 1 confirmation modal is open
- WHEN the user presses the Escape key
- THEN the modal MUST close
- AND no API request MUST be made

---

### R9: Dashboard UI — Tier 2 Confirmation (Clear Repo Memory)

A "Clear Memory" button MUST be displayed in the session header area when a repository is selected.

When clicked, a confirmation modal MUST appear with:
- Title: "Clear all memory for {repoName}"
- Body: "This will delete all {count} observations for this repository. This action cannot be undone."
- A text input with placeholder: "Type {repoName} to confirm" (where `{repoName}` is e.g., "acme/widgets")
- Two buttons: "Cancel" (secondary) and "Clear Memory" (destructive/red)

The "Clear Memory" button MUST be **disabled** until the text input value matches the exact repo name (case-sensitive).

Clicking "Cancel" or pressing Escape MUST close the modal without any action.
Clicking "Clear Memory" (when enabled) MUST:
- Call the `useClearRepoMemory` mutation
- Show a loading state on the button
- On success: close the modal, update the UI to reflect the cleared state, show success toast
- On error: show error message in the modal

#### Scenario: S32 — Clear repo memory via UI (happy path)

- GIVEN the user is viewing memory for "acme/widgets" which has 15 observations
- WHEN the user clicks "Clear Memory"
- THEN a confirmation modal MUST appear showing "This will delete all 15 observations"
- AND the "Clear Memory" button in the modal MUST be disabled
- WHEN the user types "acme/widgets" in the text input
- THEN the "Clear Memory" button MUST become enabled
- WHEN the user clicks "Clear Memory"
- THEN all observations for "acme/widgets" MUST be deleted
- AND the session list MUST update to reflect the empty state
- AND a success message MUST be shown

#### Scenario: S33 — Confirmation text doesn't match (button stays disabled)

- GIVEN the Tier 2 confirmation modal is open for "acme/widgets"
- WHEN the user types "acme/widget" (missing 's')
- THEN the "Clear Memory" button MUST remain disabled
- WHEN the user types "ACME/WIDGETS" (wrong case)
- THEN the "Clear Memory" button MUST remain disabled
- WHEN the user corrects to "acme/widgets"
- THEN the "Clear Memory" button MUST become enabled

#### Scenario: S34 — Cancel clear repo

- GIVEN the Tier 2 confirmation modal is open
- WHEN the user clicks "Cancel"
- THEN the modal MUST close
- AND no API request MUST be made
- AND no observations MUST be deleted

---

### R10: Dashboard UI — Tier 3 Confirmation (Purge All Memory)

A "Purge All Memory" button MUST be displayed in the page header or a danger zone area of the Memory page.

When clicked, a confirmation modal MUST appear with:
- Title: "Purge all memory"
- Body: "This will permanently delete ALL {totalCount} observations across ALL your repositories. This action cannot be undone."
- A text input with placeholder: 'Type "DELETE ALL" to confirm'
- Two buttons: "Cancel" (secondary) and "Purge All" (destructive/red)

The "Purge All" button MUST be **disabled** until BOTH conditions are met:
1. The text input value is exactly "DELETE ALL" (case-sensitive)
2. A 5-second countdown timer has expired

The countdown timer:
- MUST start when the modal opens
- MUST display the remaining seconds on the button (e.g., "Purge All (5s)", "Purge All (4s)", ..., "Purge All (1s)")
- After the countdown reaches 0, the button text MUST change to "Purge All" (no countdown suffix)
- The button MUST remain disabled if the countdown has expired but the text input doesn't match
- The button MUST remain disabled if the text input matches but the countdown has not expired

Clicking "Cancel" or pressing Escape MUST close the modal and reset the countdown.
If the modal is re-opened, the countdown MUST restart from 5 seconds.

Clicking "Purge All" (when both conditions are met) MUST:
- Call the `usePurgeAllMemory` mutation
- Show a loading state on the button
- On success: close the modal, navigate to/show the empty memory state, show success toast
- On error: show error message in the modal

#### Scenario: S35 — Purge all memory via UI (happy path)

- GIVEN the user has 50 observations across all repos
- WHEN the user clicks "Purge All Memory"
- THEN a confirmation modal MUST appear showing "This will permanently delete ALL 50 observations"
- AND the "Purge All" button MUST show "Purge All (5s)"
- AND the text input MUST be empty
- WHEN 5 seconds elapse
- THEN the button text MUST change to "Purge All" (no countdown)
- AND the button MUST still be disabled (text not entered)
- WHEN the user types "DELETE ALL"
- THEN the "Purge All" button MUST become enabled
- WHEN the user clicks "Purge All"
- THEN all observations MUST be deleted
- AND a success message MUST be shown

#### Scenario: S36 — Countdown timer behavior

- GIVEN the Tier 3 confirmation modal just opened
- THEN the "Purge All" button MUST display "Purge All (5s)"
- AND after 1 second it MUST display "Purge All (4s)"
- AND after 2 seconds it MUST display "Purge All (3s)"
- AND after 3 seconds it MUST display "Purge All (2s)"
- AND after 4 seconds it MUST display "Purge All (1s)"
- AND after 5 seconds it MUST display "Purge All"

#### Scenario: S37 — Text correct but countdown not expired

- GIVEN the Tier 3 modal opened 2 seconds ago (3 seconds remaining)
- AND the user has typed "DELETE ALL"
- THEN the "Purge All" button MUST still be disabled
- AND the button MUST still show the countdown (e.g., "Purge All (3s)")

#### Scenario: S38 — Countdown expired but text doesn't match

- GIVEN the Tier 3 modal opened more than 5 seconds ago
- AND the user has typed "delete all" (wrong case)
- THEN the "Purge All" button MUST remain disabled

#### Scenario: S39 — Cancel purge and re-open resets countdown

- GIVEN the Tier 3 confirmation modal has been open for 4 seconds
- WHEN the user clicks "Cancel"
- THEN the modal MUST close
- WHEN the user clicks "Purge All Memory" again
- THEN a new modal MUST appear with the countdown restarted at 5 seconds

#### Scenario: S40 — Dismiss with Escape resets countdown

- GIVEN the Tier 3 confirmation modal is open
- WHEN the user presses Escape
- THEN the modal MUST close
- AND the countdown MUST reset for next open

---

### R11: Dashboard API Client — Mutation Hooks

Three new mutation hooks MUST be added to `apps/dashboard/src/lib/api.ts`:

#### R11.1: useDeleteObservation

```typescript
export function useDeleteObservation();
```

MUST:
- Send `DELETE /api/memory/observations/:id`
- Accept `{ observationId: number }` as the mutation variable
- On success: invalidate query keys `['memory', 'observations', *]` and `['memory', 'sessions', *]`
- Return the standard `useMutation` result

#### R11.2: useClearRepoMemory

```typescript
export function useClearRepoMemory();
```

MUST:
- Send `DELETE /api/memory/projects/:project/observations` (URL-encode the project)
- Accept `{ project: string }` as the mutation variable
- On success: invalidate query keys `['memory', 'observations', *]` and `['memory', 'sessions', *]`
- Return the standard `useMutation` result

#### R11.3: usePurgeAllMemory

```typescript
export function usePurgeAllMemory();
```

MUST:
- Send `DELETE /api/memory/observations`
- Accept no variables (or empty object)
- On success: invalidate ALL query keys starting with `['memory']`
- Return the standard `useMutation` result

#### Scenario: S41 — Cache invalidation after single delete

- GIVEN the user is viewing observations for session 5
- WHEN `useDeleteObservation` succeeds for observation 42
- THEN the query `['memory', 'observations', 5]` MUST be invalidated
- AND the observation list MUST refetch and no longer include observation 42

#### Scenario: S42 — Cache invalidation after clear repo

- GIVEN the user is viewing sessions for "acme/widgets"
- WHEN `useClearRepoMemory` succeeds for "acme/widgets"
- THEN all `['memory', 'sessions', 'acme/widgets']` queries MUST be invalidated
- AND all `['memory', 'observations', *]` queries MUST be invalidated
- AND the session list MUST refetch and show updated observation counts

#### Scenario: S43 — Cache invalidation after purge all

- GIVEN the user has data loaded for multiple repos
- WHEN `usePurgeAllMemory` succeeds
- THEN ALL `['memory']` queries MUST be invalidated

---

### R12: Dashboard UI — Loading States and Error Handling

All three destructive operations MUST display appropriate loading and error states.

During a mutation request:
- The confirm button MUST show a loading indicator (spinner or "Deleting..." text)
- The confirm button MUST be disabled to prevent double-submission
- The "Cancel" button SHOULD remain clickable (to allow aborting, though the request will still complete server-side)

On error:
- The modal MUST remain open
- An error message MUST be displayed within the modal
- The confirm button MUST return to its normal state (re-enabled)

On network error:
- The error message SHOULD indicate a connectivity issue (e.g., "Network error. Please check your connection and try again.")

#### Scenario: S44 — Loading state during delete

- GIVEN the user clicked "Delete" in the Tier 1 modal
- WHEN the API request is in flight
- THEN the "Delete" button MUST show a loading indicator
- AND the "Delete" button MUST be disabled

#### Scenario: S45 — Network error during delete

- GIVEN the user clicked "Delete" in the Tier 1 modal
- AND the network request fails (timeout, connection refused, etc.)
- THEN the modal MUST remain open
- AND an error message MUST be displayed
- AND the "Delete" button MUST return to its enabled state

#### Scenario: S46 — API error (404) during delete

- GIVEN the user clicked "Delete" for an observation that was already deleted (e.g., in another tab)
- AND the API returns 404
- THEN the modal MUST show an appropriate error message (e.g., "Observation not found — it may have already been deleted")
- AND after dismissing, the observation list SHOULD refetch

---

### R13: Dashboard UI — Responsive Design and Consistency

All new UI elements (delete buttons, modals, confirmation inputs) MUST:
- Be consistent with the existing dashboard design language (colors, typography, spacing, border-radius)
- Use the existing `Card` component pattern for modal containers
- Use the existing `cn()` utility for conditional class composition
- Work responsively on screens from 320px width up to 4K
- Support dark mode (the dashboard is dark-mode only currently)

The confirmation modals MUST:
- Be rendered via a portal or overlay pattern that covers the full viewport
- Have a semi-transparent backdrop
- Be vertically and horizontally centered
- Be closeable by clicking the backdrop (equivalent to "Cancel")

#### Scenario: S47 — Modal renders centered with backdrop

- GIVEN the user clicks any delete/clear/purge button
- WHEN the confirmation modal appears
- THEN it MUST be centered on screen
- AND a semi-transparent backdrop MUST cover the rest of the page
- AND clicking the backdrop MUST close the modal

---

### R14: Dashboard UI — Success Feedback

After a successful destructive operation, the UI MUST provide clear feedback:
- **Single delete**: A brief toast/notification saying "Observation deleted" (auto-dismiss after 3-5 seconds)
- **Clear repo**: A toast saying "Cleared {N} observations from {repoName}" (auto-dismiss after 3-5 seconds)
- **Purge all**: A toast saying "Purged {N} observations from all repositories" (auto-dismiss after 5 seconds)

The toast MUST NOT block interaction with the page.

#### Scenario: S48 — Toast after successful single delete

- GIVEN the user confirmed deletion of an observation
- AND the API returned success
- THEN a toast MUST appear saying "Observation deleted"
- AND the toast MUST auto-dismiss after 3-5 seconds

#### Scenario: S49 — Toast after successful purge all

- GIVEN the user confirmed purging all memory
- AND the API returned `{ cleared: 50 }`
- THEN a toast MUST appear saying "Purged 50 observations from all repositories"

---

### R15: Security — Installation Scoping

ALL delete/clear/purge operations MUST be scoped to the authenticated user's GitHub installation(s) at both the API and database layers.

The API layer MUST:
- Extract `user.installationIds` from the auth middleware context
- For single delete and clear-repo: look up the repository, verify `repo.installationId in user.installationIds`
- For purge-all: pass `user.installationIds` to the DB query

The DB layer MUST:
- Accept `installationId` as a parameter in all delete/clear query functions
- Use SQL JOINs or WHERE clauses to ensure only observations for repos belonging to that installation are affected

No user MUST be able to delete another user's memory, even by guessing observation IDs or project names.

#### Scenario: S50 — Cross-tenant isolation at API layer

- GIVEN user A is authenticated with installationIds [100]
- AND user B has observation id=42 belonging to installation 200
- WHEN user A sends `DELETE /api/memory/observations/42`
- THEN the API MUST return 404 (observation not found for this user)
- AND observation 42 MUST NOT be deleted

#### Scenario: S51 — Cross-tenant isolation at DB layer

- GIVEN `deleteMemoryObservation(db, 100, 42)` is called
- AND observation 42 belongs to installation 200
- THEN the SQL query MUST return 0 affected rows
- AND the function MUST return `false`

---

## Cross-Cutting Concerns

### CC1: URL Encoding for Project Parameter

The `DELETE /api/memory/projects/:project/observations` endpoint uses the project name (e.g., "owner/repo") as a URL path parameter. Since this contains a slash, the client MUST URL-encode it (e.g., `acme%2Fwidgets`). The Hono router MUST decode it back to `acme/widgets`.

Special characters in organization or repository names (e.g., hyphens, dots, underscores) MUST be handled correctly. The only character requiring encoding is the forward slash separating owner and repo.

### CC2: Concurrent Deletion

If the same observation/repo is deleted simultaneously from two browser tabs:
- The first request to arrive MUST succeed
- The second request MUST either succeed as a no-op (return `deleted: true` if idempotent, or `cleared: 0`) or return 404 for single observation deletes
- No server error (500) MUST be thrown

The TanStack Query `refetchOnWindowFocus` behavior SHOULD handle stale data when the user switches back to a tab where a deleted observation is still displayed.

### CC3: Empty States

After clearing all observations for a repo or purging all memory, the UI MUST display an appropriate empty state rather than showing stale data or a blank page.
- After clearing a repo: the session list for that repo SHOULD show an empty message (e.g., "No memory sessions for this repository")
- After purging all: the Memory page SHOULD show a global empty state (e.g., "No memory yet. Memory builds as GHAGGA reviews your pull requests.")

### CC4: PostgreSQL Triggers

Unlike SQLite (which requires explicit FTS5 delete triggers), PostgreSQL's `tsvector` search column is maintained by a database trigger (`tsvector_update_trigger`). Deleting rows from `memory_observations` MUST automatically clean up the search index. No manual FTS cleanup is needed.

### CC5: No New Dependencies

This change MUST NOT add any new npm dependencies to any package. All functionality uses:
- `drizzle-orm` (already in `packages/db`) for PostgreSQL queries
- `hono` (already in `apps/server`) for API routes
- `@tanstack/react-query` (already in `apps/dashboard`) for mutation hooks
- React (already in `apps/dashboard`) for UI components

---

## Edge Cases

### E1: Deleting the last observation in a session

- GIVEN a session has exactly 1 observation
- WHEN that observation is deleted
- THEN the session MUST still exist in the database (sessions are not auto-deleted)
- AND the session MUST show 0 observations in the UI
- AND the session list MUST update the observation count

#### Scenario: S52

- GIVEN session 5 has 1 observation (id=42)
- WHEN the user deletes observation 42
- THEN the session list MUST still show session 5
- AND session 5 MUST display "0 observations"

### E2: Clearing a repo that has no observations

- GIVEN a repository exists but has 0 observations
- WHEN the user clicks "Clear Memory" for that repo
- THEN the Tier 2 modal MAY show "This will delete all 0 observations"
- OR the "Clear Memory" button MAY be hidden/disabled when count is 0
- AND if the API is called, it MUST return `{ cleared: 0 }` without error

#### Scenario: S53

- GIVEN "acme/widgets" has 0 observations
- WHEN `DELETE /api/memory/projects/acme%2Fwidgets/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

### E3: Purging when there's nothing to purge

- GIVEN the user has no observations across any repo
- WHEN the user triggers "Purge All Memory"
- THEN the API MUST return `{ cleared: 0 }` without error
- AND the UI MUST show a toast like "Purged 0 observations from all repositories" or a gentler message

#### Scenario: S54

- GIVEN the user has 0 total observations
- WHEN `DELETE /api/memory/observations` is sent
- THEN the response MUST be `200 { data: { cleared: 0 } }`

### E4: Concurrent deletion (two tabs)

- GIVEN the user has the Memory page open in two tabs
- AND both tabs show observation 42
- WHEN the user deletes observation 42 in Tab 1 (succeeds)
- AND then tries to delete observation 42 in Tab 2
- THEN Tab 2's API request MUST return 404
- AND Tab 2 MUST show an appropriate error message
- AND when Tab 2 refocuses or refetches, observation 42 MUST no longer appear

#### Scenario: S55

- GIVEN observation 42 was deleted in another tab
- WHEN `DELETE /api/memory/observations/42` is sent
- THEN the response MUST be `404 { error: "Observation not found" }`

### E5: Project param with special characters in URL

- GIVEN a project name contains characters that need URL encoding (e.g., "my-org/my.repo-name")
- WHEN the client sends `DELETE /api/memory/projects/my-org%2Fmy.repo-name/observations`
- THEN the server MUST correctly decode the project parameter to "my-org/my.repo-name"
- AND the query MUST match the correct repository

#### Scenario: S56

- GIVEN "my-org/my.repo-name" belongs to the user's installation
- WHEN `DELETE /api/memory/projects/my-org%2Fmy.repo-name/observations` is sent
- THEN the server MUST find the repository "my-org/my.repo-name"
- AND the clear operation MUST succeed

---

## Acceptance Criteria

1. `deleteMemoryObservation(db, installationId, observationId)` in `packages/db/src/queries.ts` deletes a single observation scoped by installation, returns `boolean`
2. `clearMemoryObservationsByProject(db, installationId, project)` in `packages/db/src/queries.ts` clears all observations for a repo scoped by installation, returns count
3. `clearAllMemoryObservations(db, installationId)` in `packages/db/src/queries.ts` clears all observations for an installation, returns count
4. `DELETE /api/memory/observations/:id` returns 200/404/400/401/403 as specified
5. `DELETE /api/memory/projects/:project/observations` returns 200/404/401/403 as specified, handles URL-encoded project names
6. `DELETE /api/memory/observations` returns 200/401 as specified
7. All API endpoints enforce installation-scoped authorization (no IDOR)
8. `PostgresMemoryStorage.deleteObservation()` returns `boolean` (no longer throws)
9. `PostgresMemoryStorage.clearObservations()` returns count (no longer throws)
10. `PostgresMemoryStorage.listObservations()` returns `MemoryObservationDetail[]` (no longer throws)
11. `PostgresMemoryStorage.getObservation()` returns detail or null (no longer throws)
12. `PostgresMemoryStorage.getStats()` returns `MemoryStats` (no longer throws)
13. **Tier 1**: Trash icon on each `ObservationCard`, simple modal with "Cancel"/"Delete"
14. **Tier 2**: "Clear Memory" button, modal with text input matching exact repo name to enable confirm
15. **Tier 3**: "Purge All Memory" button, modal with "DELETE ALL" text input + 5-second countdown timer on confirm button; both conditions required
16. Countdown timer displays remaining seconds on the button, resets on modal close/reopen
17. TanStack Query mutations with proper cache invalidation for all 3 operations
18. Loading states during API requests (disabled buttons, spinners)
19. Error handling in modals (remain open on error, show message)
20. Success toast/notification after each operation
21. Empty state displayed after clearing/purging all observations
22. Responsive design consistent with existing dashboard (dark mode, existing component patterns)
23. No new npm dependencies added
24. All new DB queries, API endpoints, and UI components have tests
25. Existing tests continue passing
