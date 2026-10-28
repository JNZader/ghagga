# Proposal: Dashboard Memory Management — Full-Stack Delete/Clear/Purge for SaaS Users

## Intent

The CLI already gives users full control over their local memory: `ghagga memory delete`, `ghagga memory clear`, `ghagga memory stats`. But SaaS Dashboard users — the primary audience — are stuck with a **read-only** Memory page. They can browse sessions and observations but cannot delete a single incorrect observation, clear stale memory for a repo, or purge everything to start fresh.

The `PostgresMemoryStorage` adapter has five method stubs (`listObservations`, `getObservation`, `deleteObservation`, `getStats`, `clearObservations`) that throw `Error('Not implemented')` with comments explicitly saying _"These will be implemented via the Dashboard UI in a future change."_ That future change is now.

This matters because memory directly influences review quality — stale or incorrect observations produce misleading AI reviews. Users need a way to prune bad observations without contacting support or losing everything.

## Scope

### In Scope

- **PostgreSQL query functions** in `packages/db/src/queries.ts` — add `deleteObservation(pool, installationId, observationId)`, `clearObservationsByProject(pool, installationId, project)`, `clearAllObservations(pool, installationId)` with proper authorization scoping (observations belong to repos, repos belong to installations)
- **Server API endpoints** in `apps/server/src/routes/api.ts`:
  - `DELETE /api/memory/observations/:id` — delete a single observation
  - `DELETE /api/memory/projects/:project/observations` — clear all observations for a repo
  - `DELETE /api/memory/observations` — purge all observations for the installation
- **PostgresMemoryStorage implementation** in `apps/server/src/memory/postgres.ts` — replace the 5 stub methods with real implementations delegating to the new DB query functions
- **Dashboard UI** in `apps/dashboard/src/pages/Memory.tsx`:
  - Delete button (trash icon) on each `ObservationCard`
  - "Clear Memory" button in the session header area (clears all observations for the selected repo)
  - "Purge All Memory" button in the page header (clears everything across all repos)
  - **3-tier confirmation system** for destructive actions:
    - **Tier 1** (delete 1 observation): Simple confirmation modal with "Cancel" / "Delete" buttons
    - **Tier 2** (clear 1 repo's memory): 2-step confirmation — modal + text input requiring the exact repo name (e.g., "owner/repo") to enable the confirm button
    - **Tier 3** (purge ALL memory): 3-step confirmation — modal + text input requiring "DELETE ALL" + confirm button disabled for 5 seconds with visible countdown timer before it becomes clickable
- **Dashboard API hooks** in `apps/dashboard/src/lib/api.ts` — add `useDeleteObservation`, `useClearRepoMemory`, `usePurgeAllMemory` mutation hooks with proper cache invalidation
- **Dashboard types** in `apps/dashboard/src/lib/types.ts` — extend if needed for delete response types
- **Unit tests** for all new DB queries, API endpoints, and PostgresMemoryStorage methods
- **Mutation testing** — target >80% mutation score on all new code via Stryker

### Out of Scope

- **CLI memory management** — already fully implemented (`memory-management` change, archived 2026-03-06)
- **GitHub Action memory management** — Actions use cached SQLite, managed via CLI or cache key invalidation
- **Memory export/import** (JSON, CSV) — separate feature
- **Batch selection** (select multiple observations with checkboxes, bulk delete) — future enhancement
- **Observation editing** (modify content, change type) — observations are AI-generated, editing is not a planned workflow
- **Memory compaction / auto-pruning** (TTL, retention policies) — separate change
- **Session deletion** — sessions are lightweight metadata; this change focuses on observation management
- **MemoryStorage interface changes** — the interface already defines all needed methods; this change only implements the PostgreSQL side

## Approach

### 1. Database Layer: PostgreSQL Query Functions

Add three new functions to `packages/db/src/queries.ts`:

```typescript
// Delete a single observation by ID, scoped to installation
export async function deleteMemoryObservation(
  db: Database,
  installationId: number,
  observationId: number,
): Promise<boolean>;

// Clear all observations for a specific project, scoped to installation
export async function clearMemoryObservationsByProject(
  db: Database,
  installationId: number,
  project: string,
): Promise<number>;

// Clear all observations for an installation
export async function clearAllMemoryObservations(
  db: Database,
  installationId: number,
): Promise<number>;
```

All functions accept `installationId` as the authorization scope. `deleteMemoryObservation` joins through `repositories` to verify the observation's project belongs to the given installation — preventing IDOR. `clearAllMemoryObservations` deletes all observations for repos belonging to the given installation.

The PostgreSQL `tsvector` search column is updated by a database trigger (`tsvector_update_trigger`), so deleting rows automatically cleans up the search index — no manual FTS cleanup needed (unlike SQLite where we had to add `obs_fts_delete`).

### 2. Server API: DELETE Endpoints

Add three DELETE routes to the existing `createApiRouter` in `apps/server/src/routes/api.ts`:

| Endpoint                                            | Body/Query | Action                    |
| --------------------------------------------------- | ---------- | ------------------------- |
| `DELETE /api/memory/observations/:id`               | —          | Delete single observation |
| `DELETE /api/memory/projects/:project/observations` | —          | Clear repo memory         |
| `DELETE /api/memory/observations`                   | —          | Purge all user memory     |

The `:project` param uses URL encoding for `owner/repo` (e.g., `/api/memory/projects/acme%2Fwidgets/observations`).

All routes use the existing `authMiddleware` which populates `c.get('user')` with `{ githubUserId, githubLogin, installationIds }`. Authorization flow:
1. **Single delete**: Look up observation → join through `repositories` to get `installationId` → verify it's in `user.installationIds` → delete
2. **Clear repo**: Look up repo by `:project` param → verify `repo.installationId` is in `user.installationIds` → delete all observations for that project
3. **Purge all**: Use `user.installationIds` directly → delete all observations for repos belonging to those installations

Responses follow the existing `{ data: ... }` envelope pattern:
- `200 { data: { deleted: true } }` — single delete
- `200 { data: { cleared: number } }` — clear/purge with count

### 3. PostgresMemoryStorage: Implement Stubs

Replace the 5 `throw new Error('Not implemented')` stubs with real implementations. Each method delegates to the appropriate `ghagga-db` query function:

| Method              | Delegates To                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `listObservations`  | New `listMemoryObservations` query                                    |
| `getObservation`    | New `getMemoryObservation` query                                      |
| `deleteObservation` | New `deleteMemoryObservation` query                                   |
| `getStats`          | New `getMemoryStats` query                                            |
| `clearObservations` | New `clearMemoryObservationsByProject` / `clearAllMemoryObservations` |

Note: `listObservations` and `getStats` need new read queries too — they didn't exist in the DB layer because the CLI used SQLite directly. The PostgresMemoryStorage constructor already has the `db` instance, so the pattern is identical to the existing `searchObservations` → `ghagga-db.searchObservations` delegation.

### 4. Dashboard UI: Delete Buttons + 3-Tier Confirmation System

**ObservationCard changes** (`Memory.tsx`):
- Add a trash icon button (top-right corner of each card)
- On click → open **Tier 1** confirmation modal: _"Delete this observation? This action cannot be undone."_ with "Cancel" and "Delete" buttons
- On confirm → call `useDeleteObservation` mutation → invalidate observation queries

**Repo-level clear** (new button near session list header):
- "Clear Memory" button with a warning color scheme
- **Tier 2** confirmation: modal shows count of observations + text input requiring the user to type the exact repo name (e.g., "acme/widgets") to enable the confirm button
- Confirm button stays disabled until input matches exactly
- On confirm → call `useClearRepoMemory` mutation → invalidate memory queries

**Purge all** (new button in page header, next to repo selector):
- "Purge All Memory" button, destructive style (red outline)
- **Tier 3** confirmation: modal shows total observation count + text input requiring typing "DELETE ALL" + confirm button disabled for 5 seconds with a visible countdown timer (e.g., "Confirm (5s)... (4s)... (3s)...") before it becomes clickable, even after typing the correct text
- Both conditions must be met: correct text AND countdown expired
- On confirm → call `usePurgeAllMemory` mutation → invalidate all memory queries

**3-Tier Confirmation Rationale**:
- Single observation deletion is low-risk and easily recoverable (the next review re-generates observations), so a simple click-to-confirm is sufficient.
- Clearing a repo's memory is moderately destructive (loses all learned patterns for that codebase), so requiring the user to type the repo name prevents accidental clicks.
- Purging ALL memory across ALL repos is catastrophic and irreversible, so the triple protection (modal + typed phrase + time delay) ensures the user has maximum opportunity to reconsider.

**Confirmation Modal component**: Use the project's existing `Card` component + portal pattern, or build a minimal `ConfirmDialog` component. No external modal library — keep consistent with existing shadcn/ui-like patterns in the dashboard.

### 5. API Client Hooks

Add to `apps/dashboard/src/lib/api.ts`:

```typescript
export function useDeleteObservation(); // DELETE /api/memory/observations/:id
export function useClearRepoMemory(); // DELETE /api/memory/projects/:project/observations
export function usePurgeAllMemory(); // DELETE /api/memory/observations
```

Each mutation hook uses `useMutation` from TanStack Query and invalidates the appropriate query keys (`['memory', 'sessions', ...]`, `['memory', 'observations', ...]`) on success.

### 6. Security Model

The existing auth middleware + installation-scoped access model handles authorization:
1. `authMiddleware` verifies the GitHub token and resolves `user.installationIds`
2. API routes look up the repo by `fullName`, check `repo.installationId in user.installationIds`
3. DB queries scope deletions by project/installation — no cross-tenant leakage possible

This is the same pattern used by all existing API routes (reviews, settings, etc.).

## Affected Areas

| Area                                             | Impact       | Description                                                                                                                                                        |
| ------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/src/queries.ts`                     | Modified     | Add 5 new query functions: `deleteMemoryObservation`, `clearMemoryObservationsByProject`, `clearAllMemoryObservations`, `listMemoryObservations`, `getMemoryStats` |
| `apps/server/src/routes/api.ts`                  | Modified     | Add 3 DELETE routes for memory management under existing `createApiRouter`                                                                                         |
| `apps/server/src/memory/postgres.ts`             | Modified     | Replace 5 stub methods with real implementations delegating to new DB queries                                                                                      |
| `apps/dashboard/src/pages/Memory.tsx`            | Modified     | Add delete buttons on observations, clear repo button, purge all button, confirmation modals                                                                       |
| `apps/dashboard/src/lib/api.ts`                  | Modified     | Add 3 mutation hooks: `useDeleteObservation`, `useClearRepoMemory`, `usePurgeAllMemory`                                                                            |
| `apps/dashboard/src/lib/types.ts`                | Modified     | Add response types for delete operations if needed                                                                                                                 |
| `packages/db/src/queries.test.ts` (or new)       | New/Modified | Unit tests for all 5 new query functions                                                                                                                           |
| `apps/server/src/routes/api.test.ts`             | Modified     | Add tests for 3 DELETE routes (auth, 403, 404, success, empty purge)                                                                                               |
| `apps/server/src/memory/postgres.test.ts`        | Modified     | Replace stub-throws tests with real implementation tests                                                                                                           |
| `apps/dashboard/src/pages/Memory.test.tsx` (new) | New          | Component tests for delete buttons, modals, mutation flow                                                                                                          |

## Risks

| Risk                                                                                            | Likelihood | Impact   | Mitigation                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accidental mass deletion (user clicks purge without understanding scope)                        | Medium     | High     | **3-tier confirmation system**: Tier 1 (single delete) = simple modal. Tier 2 (clear repo) = modal + type repo name. Tier 3 (purge all) = modal + type "DELETE ALL" + 5-second countdown timer on the confirm button. Each tier adds protection proportional to the blast radius.                     |
| IDOR — user deletes another user's observation by guessing ID                                   | Low        | Critical | All delete operations verify `repo.installationId in user.installationIds`. DB queries additionally scope by project. Test explicitly with cross-tenant scenarios.                                                                                                                                    |
| Race condition: observation deleted while another tab is viewing it                             | Low        | Low      | TanStack Query will refetch on window focus. Deleted observation returns 404 — handle gracefully in UI (show toast, remove card).                                                                                                                                                                     |
| `clearAllMemoryObservations` is slow for large datasets                                         | Low        | Medium   | The query deletes by `project IN (SELECT full_name FROM repositories WHERE installation_id IN (...))`. PostgreSQL handles this efficiently with the existing `idx_observations_project` index. If performance is an issue, add `LIMIT` + loop, but unlikely for typical datasets (<10K observations). |
| `PostgresMemoryStorage.clearObservations` without project param needs access to installationIds | Medium     | Medium   | The `clearObservations(options?)` interface method only accepts `{ project?: string }`. For purge-all, the API route calls the DB query directly with `user.installationIds`, bypassing the adapter method. Document this design decision.                                                            |
| Project param with slashes in URL path (owner/repo)                                             | Low        | Medium   | Use URL encoding for the `:project` parameter in `DELETE /api/memory/projects/:project/observations` (e.g., `acme%2Fwidgets`). The Hono router handles `decodeURIComponent` automatically.                                                                                                            |
| Adding DELETE routes to existing router file increases its size (~740 lines already)            | Low        | Low      | The routes follow the exact same pattern as existing ones. If the file grows too large, extract to a sub-module in a future refactor.                                                                                                                                                                 |

## Rollback Plan

1. **Database queries are additive**: The new functions in `queries.ts` don't modify existing queries. `git revert` removes them cleanly.
2. **API routes are additive**: The 3 DELETE routes don't affect any existing GET/PUT routes. Removing them restores the read-only API.
3. **PostgresMemoryStorage stubs revert cleanly**: Reverting changes the methods back to `throw new Error('Not implemented')`. No data corruption — the stubs were never called in production.
4. **Dashboard UI is backward-compatible**: Reverting the Memory.tsx changes restores the read-only page. No data loss — the UI changes are purely visual.
5. **No schema migrations**: This change adds no new database tables or columns. All operations use existing schema (`memory_observations`, `memory_sessions`). Rollback requires zero database work.
6. **Single feature branch**: All changes are in one branch. A single `git revert` of the merge commit restores full previous behavior.

## Dependencies

- **No new npm dependencies** — all functionality uses existing packages:
  - `drizzle-orm` (already in `packages/db`) for PostgreSQL queries
  - `hono` (already in `apps/server`) for API routes
  - `@tanstack/react-query` (already in `apps/dashboard`) for mutation hooks
  - React (already in `apps/dashboard`) for UI components
- **Existing auth middleware** in `apps/server/src/middleware/auth.ts` — reused as-is for all new routes
- **Existing `MemoryStorage` interface** in `packages/core/src/types.ts` — already defines all 5 management methods; no interface changes needed
- **Existing DB schema** — `memory_observations` and `memory_sessions` tables with existing indexes

## Distribution Mode Impact

| Mode               | Impact                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **SaaS**           | Primary target — dashboard gets full memory management capabilities                              |
| **CLI**            | No impact — CLI uses `SqliteMemoryStorage` which already implements all management methods       |
| **GitHub Action**  | No impact — Actions don't expose memory management                                               |
| **1-Click Deploy** | Benefits automatically — 1-click deploy uses the SaaS server, so dashboard changes are inherited |

## Success Criteria

- [ ] `DELETE /api/memory/observations/:id` deletes a single observation, returns 200 with `{ data: { deleted: true } }`, returns 404 if not found
- [ ] `DELETE /api/memory/projects/:project/observations` clears all observations for the repo, returns 200 with `{ data: { cleared: N } }`
- [ ] `DELETE /api/memory/observations` purges all user observations across all repos, returns 200 with `{ data: { cleared: N } }`
- [ ] All DELETE endpoints return 403 when user tries to access a repo outside their installations
- [ ] All DELETE endpoints return 401 without valid auth token
- [ ] `PostgresMemoryStorage.deleteObservation()` returns `true` on success, `false` on not found (no longer throws)
- [ ] `PostgresMemoryStorage.clearObservations()` returns count of deleted rows (no longer throws)
- [ ] `PostgresMemoryStorage.listObservations()` returns `MemoryObservationDetail[]` with proper filtering (no longer throws)
- [ ] `PostgresMemoryStorage.getObservation()` returns detail or null (no longer throws)
- [ ] `PostgresMemoryStorage.getStats()` returns `MemoryStats` (no longer throws)
- [ ] Dashboard Memory page shows a trash icon on each `ObservationCard`
- [ ] **Tier 1**: Clicking the trash icon shows a simple confirmation modal; clicking "Delete" removes the observation
- [ ] **Tier 2**: "Clear Memory" button shows a modal with text input; confirm button only enabled when user types the exact repo name
- [ ] **Tier 3**: "Purge All Memory" button shows a modal with text input requiring "DELETE ALL" + confirm button has 5-second countdown before becoming clickable; both conditions must be met
- [ ] After deleting/clearing/purging, the session list and observations update automatically (TanStack Query invalidation)
- [ ] Loading states, error handling, and success feedback (toasts) work correctly for all 3 operations
- [ ] All new code has >80% Stryker mutation score
- [ ] No new npm dependencies added
- [ ] Existing 1,532 tests continue passing
