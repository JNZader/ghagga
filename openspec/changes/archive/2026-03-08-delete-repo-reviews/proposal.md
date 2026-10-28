# Proposal: Delete Repo Reviews — Clear Review History and Stats per Repository

## Intent

After clearing a repository's memory observations, the dashboard still shows stale review stats and history for that repo. Reviews accumulate forever with no way to delete them. This creates a confusing UX: users expect "clearing a repo" to mean starting completely fresh, but the Dashboard/Stats/Reviews pages still show historical data from the reviews table.

Memory observations can be deleted at every level (single observation, per-repo clear, purge all), but reviews — which are a separate table — have zero delete functionality. This asymmetry means users cannot fully reset a repository's history even when they need to (e.g., after changing review modes, during testing, or after a misconfigured installation generated hundreds of junk reviews).

This change adds the ability to delete all reviews for a specific repository, with an option to also clear related memory observations in a single action.

## Scope

### In Scope

- **DB query function** in `packages/db/src/queries.ts` — add `deleteReviewsByRepoId(db, repositoryId)` that deletes all reviews for a repository and returns the count of deleted rows
- **Server API endpoint** — `DELETE /api/reviews/:repoFullName` that deletes all reviews for a repo, with optional `?includeMemory=true` query param to also clear memory observations in the same request
- **Dashboard Reviews page** (`apps/dashboard/src/pages/Reviews.tsx`) — add a "Delete Reviews" button per repo that uses the existing `ConfirmDialog` component with **Tier 2** confirmation (type repo name to confirm)
- **Dashboard API hook** in `apps/dashboard/src/lib/api.ts` — add `useDeleteRepoReviews` mutation hook with cache invalidation for `['reviews']`, `['stats']`, and optionally `['memory']` query keys
- **Stats auto-update** — after deletion, stats queries are invalidated so the Dashboard page reflects the new state (stats are already computed from the reviews table, so no extra work needed)
- **Unit tests** for the new DB query function and API endpoint
- **Dashboard component tests** for the delete button and confirmation flow

### Out of Scope

- **Delete individual reviews** (single row) — could be useful but is a separate, lower-priority feature
- **Bulk delete across all repos** (purge all reviews) — a Tier 3 action that can be added later if needed
- **Review archiving/export** before deletion — no export feature exists yet; adding it here would bloat scope
- **Automatic cleanup policies** (retention period, max review count) — separate feature
- **CLI review management** — reviews are a SaaS concept (stored in PostgreSQL); CLI and Action don't persist reviews to the server

## Approach

### 1. Database Layer

Add one new function to `packages/db/src/queries.ts`:

```typescript
export async function deleteReviewsByRepoId(db: Database, repositoryId: number): Promise<number>;
```

This uses Drizzle's `.delete(reviews).where(eq(reviews.repositoryId, repositoryId))` and returns the count of deleted rows. The `reviews` table has a `CASCADE` foreign key to `repositories`, but we're deleting by `repositoryId` directly, so no join is needed. The existing `idx_reviews_repository` index makes this efficient.

### 2. Server API Endpoint

Add a DELETE route to the existing `createReviewsRouter` in `apps/server/src/routes/api/reviews.ts`:

```
DELETE /api/reviews/:repoFullName?includeMemory=true
```

Authorization flow (identical to existing review/stats routes):
1. Look up repo by `repoFullName` param → 404 if not found
2. Verify `repo.installationId` is in `user.installationIds` → 403 if not
3. Delete all reviews for `repo.id`
4. If `includeMemory=true`, also call `clearMemoryObservationsByProject(db, repo.installationId, repoFullName)` (reusing the existing function from the memory management change)
5. Return `{ data: { deletedReviews: N, clearedMemory: M | null } }`

The `:repoFullName` param follows the same URL-encoding pattern used by the memory routes (e.g., `acme%2Fwidgets`). Hono's `decodeURIComponent` handles this automatically.

### 3. Dashboard UI

**Reviews page** (`Reviews.tsx`):
- Add a "Delete Reviews" button that appears when a repo is selected in the filter dropdown
- The button uses the existing `ConfirmDialog` component with **Tier 2** confirmation:
  - Title: "Delete all reviews for {repoFullName}?"
  - Description: explains that all review history and stats for this repo will be permanently deleted
  - Includes a checkbox option: "Also clear memory observations for this repository"
  - `confirmText`: the repo full name (user must type it exactly)
  - `confirmLabel`: "Delete Reviews"
  - `confirmVariant`: "danger"
- On confirm, calls `useDeleteRepoReviews` mutation with `{ repoFullName, includeMemory }` params
- On success, invalidates `['reviews']` and `['stats']` query keys (and `['memory']` if `includeMemory` was checked)

**Why Tier 2**: Deleting reviews removes historical data but is scoped to a single repo and the data can be regenerated by re-running reviews on past PRs. This matches the same risk level as "Clear Memory" for a repo (also Tier 2). Tier 1 would be too easy to trigger accidentally; Tier 3 would be overkill since the blast radius is one repo.

### 4. API Client Hook

Add to `apps/dashboard/src/lib/api.ts`:

```typescript
export function useDeleteRepoReviews() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      repoFullName,
      includeMemory,
    }: {
      repoFullName: string;
      includeMemory?: boolean;
    }) =>
      fetchData<{ deletedReviews: number; clearedMemory: number | null }>(
        `/api/reviews/${encodeURIComponent(repoFullName)}${includeMemory ? '?includeMemory=true' : ''}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', variables.repoFullName] });
      if (variables.includeMemory) {
        void queryClient.invalidateQueries({ queryKey: ['memory'] });
      }
    },
  });
}
```

### 5. "Include Memory" Option

When users clear a repo's memory but reviews persist, the dashboard shows stale stats. The reverse is also confusing: deleting reviews but keeping memory means the AI still "remembers" patterns from reviews that no longer exist. Offering a checkbox to clear both in one action avoids this split-brain state.

This is opt-in (default unchecked) because some users may want to keep memory observations while resetting review history (e.g., the learned patterns are still valid even if the old reviews are irrelevant).

## Affected Areas

| Area                                         | Impact   | Description                                                            |
| -------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `packages/db/src/queries.ts`                 | Modified | Add `deleteReviewsByRepoId` function                                   |
| `apps/server/src/routes/api/reviews.ts`      | Modified | Add `DELETE /api/reviews/:repoFullName` route                          |
| `apps/dashboard/src/pages/Reviews.tsx`       | Modified | Add "Delete Reviews" button with Tier 2 confirmation dialog            |
| `apps/dashboard/src/lib/api.ts`              | Modified | Add `useDeleteRepoReviews` mutation hook                               |
| `packages/db/src/queries.test.ts`            | Modified | Add tests for `deleteReviewsByRepoId`                                  |
| `apps/server/src/routes/api/reviews.test.ts` | New      | Tests for the DELETE endpoint (auth, 403, 404, success, includeMemory) |
| `apps/dashboard/src/pages/Reviews.test.tsx`  | Modified | Add tests for delete button, Tier 2 confirmation flow                  |

## Risks

| Risk                                                               | Likelihood | Mitigation                                                                                                                                                                    |
| ------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accidental deletion of review history                              | Medium     | Tier 2 confirmation requires typing the exact repo name. The delete button only appears when a repo is selected (not on the "All repositories" view).                         |
| IDOR — user deletes another user's reviews by guessing repo name   | Low        | Authorization check verifies `repo.installationId in user.installationIds` before deletion, same pattern as all existing routes.                                              |
| `includeMemory` silently fails if memory functions are unavailable | Low        | The `clearMemoryObservationsByProject` function already exists and is battle-tested. Wrap in try/catch and return partial success if memory clear fails.                      |
| Stats page shows cached stale data after deletion                  | Low        | TanStack Query invalidation of `['stats', repoFullName]` forces a refetch. Stats are computed from the reviews table, so they'll be zero after deletion.                      |
| Deleting reviews for a repo with thousands of rows is slow         | Low        | The `idx_reviews_repository` index ensures efficient deletion. PostgreSQL handles bulk deletes well. If needed, batch with `LIMIT` + loop, but unlikely for typical datasets. |

## Rollback Plan

1. **DB function is additive**: `deleteReviewsByRepoId` doesn't modify any existing queries. `git revert` removes it cleanly.
2. **API route is additive**: The DELETE route doesn't affect existing GET routes in the reviews router. Removing it restores the read-only API.
3. **Dashboard changes are purely UI**: Reverting `Reviews.tsx` removes the delete button. No data loss — the button only triggers deletions when explicitly confirmed.
4. **No schema migrations**: This change adds no new tables or columns. All operations use the existing `reviews` table. Rollback requires zero database work.
5. **Single feature branch**: One `git revert` of the merge commit restores full previous behavior.

## Dependencies

- **No new npm dependencies** — uses existing:
  - `drizzle-orm` for the delete query
  - `hono` for the API route
  - `@tanstack/react-query` for the mutation hook
- **Existing `ConfirmDialog` component** — already supports all 3 tiers; Tier 2 is used here
- **Existing `clearMemoryObservationsByProject`** in `packages/db/src/queries.ts` — reused for the `includeMemory` option
- **Existing auth middleware** — reused as-is

## Success Criteria

- [ ] `DELETE /api/reviews/:repoFullName` deletes all reviews for the repo, returns `200 { data: { deletedReviews: N, clearedMemory: null } }`
- [ ] `DELETE /api/reviews/:repoFullName?includeMemory=true` also clears memory, returns `200 { data: { deletedReviews: N, clearedMemory: M } }`
- [ ] Returns 404 when repo is not found
- [ ] Returns 403 when user doesn't have access to the repo's installation
- [ ] Returns 401 without valid auth token
- [ ] Dashboard Reviews page shows "Delete Reviews" button when a repo is selected
- [ ] Button is hidden when "All repositories" is selected (no repo context)
- [ ] Tier 2 confirmation: confirm button disabled until user types exact repo name
- [ ] Checkbox "Also clear memory observations" is present and defaults to unchecked
- [ ] After deletion, review list is empty and stats show zeros for that repo
- [ ] After deletion with `includeMemory`, memory sessions/observations are also cleared
- [ ] All existing tests continue passing
- [ ] New endpoint has test coverage for auth, authorization, not-found, success, and includeMemory scenarios
