# Design: Dashboard Memory Management — Full-Stack Delete/Clear/Purge

## Technical Approach

This change implements a vertical slice through all layers of the GHAGGA monorepo to add memory management capabilities to the SaaS Dashboard. The strategy is bottom-up: database queries first, then API endpoints, then adapter implementation, then frontend hooks and UI.

All destructive operations are scoped to the authenticated user's GitHub installation(s) at every layer — the DB queries accept `installationId` as a mandatory parameter, the API routes verify installation ownership before calling queries, and the frontend uses the existing auth token flow.

The approach maps directly to the proposal's 6-section plan and implements all 15 requirements (R1–R15) and 56 scenarios (S1–S56) from the spec.

---

## Architecture Decisions

### Decision 1: PostgresMemoryStorage Constructor Receives installationId

**Choice**: Extend the `PostgresMemoryStorage` constructor to accept `installationId: number` as a second parameter. The adapter stores it as a private field and passes it to all DB queries internally.

```typescript
// Before
constructor(private db: Database) {}

// After
constructor(private db: Database, private installationId: number) {}
```

**Alternatives considered**:
1. _Pass installationId per-method call_: Would break the `MemoryStorage` interface, which is shared between `SqliteMemoryStorage` (CLI/Action) and `PostgresMemoryStorage` (SaaS). The interface defines `deleteObservation(id: number): Promise<boolean>` — there's no room for an extra parameter without a breaking change.

2. _Use request-scoped middleware/context_: Would add unnecessary indirection. The adapter is already created per-request context in the API routes, so passing the value at construction time is the simplest approach.

**Rationale**: The `MemoryStorage` interface is a contract shared across distribution modes. Extending the constructor keeps the interface stable while providing the PostgreSQL adapter with the authorization scope it needs. The SQLite adapter doesn't need `installationId` because it operates on a user-local database file.

---

### Decision 2: Purge-All API Route Bypasses the Adapter

**Choice**: The `DELETE /api/memory/observations` (purge-all) route iterates over `user.installationIds` and calls `clearAllMemoryObservations(db, installationId)` directly for each, summing the results. It does NOT use `PostgresMemoryStorage.clearObservations()`.

**Alternatives considered**:
1. _Create multiple adapter instances (one per installationId)_: Overly complex for a single API call. Would require creating N adapters and calling `clearObservations()` on each.

2. _Extend the adapter to accept an array of installationIds_: The `MemoryStorage` interface only has `clearObservations(options?: { project?: string })` — no room for `installationIds[]` without breaking the interface.

**Rationale**: A user can belong to multiple GitHub installations (personal + organizations). The adapter's single `installationId` covers one installation. The purge-all route needs to clear all of them. Calling the DB query directly is the simplest correct solution and keeps the adapter focused on single-installation operations.

---

### Decision 3: Hono Route Registration Order

**Choice**: Register `DELETE /api/memory/observations` (purge-all, no params) BEFORE `DELETE /api/memory/observations/:id` (single delete) in the router.

**Alternatives considered**:
1. _Rely on Hono's automatic path matching_: Hono treats `/api/memory/observations` and `/api/memory/observations/:id` as distinct paths because one has an additional segment. They would not conflict regardless of order. However, registering the exact-match route first makes the intent explicit and avoids any ambiguity in code review.

**Rationale**: Defensive clarity. While Hono's tree-based router handles this correctly either way, the explicit ordering documents the developer's intent and prevents future confusion when someone reads the route file.

---

### Decision 4: Single ConfirmDialog Component for All 3 Tiers

**Choice**: Create one `ConfirmDialog` component in `apps/dashboard/src/components/ConfirmDialog.tsx` that handles all three confirmation tiers via props. The component renders different UI based on the presence of optional props (`confirmText`, `countdownSeconds`).

**Alternatives considered**:
1. _Three separate modal components (DeleteModal, ClearModal, PurgeModal)_: 80% of the logic is shared (portal rendering, backdrop, centering, escape handling, loading states, cancel behavior). Three components would mean significant duplication.

2. _A base modal + tier-specific wrappers_: Adds unnecessary indirection. The prop-based approach is simpler and equally readable.

**Rationale**: A single component with optional props is the most maintainable approach. The rendering logic branches naturally: no `confirmText` → Tier 1, `confirmText` set → Tier 2, `confirmText` + `countdownSeconds` → Tier 3. This also makes it easy to reuse in future features that need destructive confirmations.

---

### Decision 5: Minimal Toast System (No New Dependencies)

**Choice**: Build a lightweight toast notification system using React Context + Portal. Create `ToastProvider` (context), `useToast()` hook, and `ToastContainer` (portal renderer) in `apps/dashboard/src/components/Toast.tsx`.

**Alternatives considered**:
1. _react-hot-toast or sonner_: Both are excellent libraries, but the spec explicitly requires "No new npm dependencies" (CC5). Adding either would violate this constraint.

2. _Browser `alert()` or `console.log`_: Not a real alternative — poor UX for a production dashboard.

3. _Inline success messages within the modals_: The modals close on success (spec requirement), so there's no visible surface for an inline message. Toasts solve this by persisting outside the modal lifecycle.

**Rationale**: The toast system needs to be minimal (render text, auto-dismiss, stack) because it only serves 3 use cases. A full-featured library would be overkill even if dependencies were allowed. The implementation is ~80 lines of code.

---

### Decision 6: Drizzle Subquery Pattern for Installation Scoping

**Choice**: Use Drizzle ORM's `inArray()` with a subquery to verify installation ownership in a single SQL statement:

```typescript
db.delete(memoryObservations).where(
  and(
    eq(memoryObservations.id, observationId),
    inArray(
      memoryObservations.project,
      db
        .select({ fullName: repositories.fullName })
        .from(repositories)
        .where(eq(repositories.installationId, installationId)),
    ),
  ),
);
```

**Alternatives considered**:
1. _Two queries (SELECT to verify, then DELETE)_: Introduces a TOCTOU (time-of-check-to-time-of-use) race condition. Between the SELECT and DELETE, the observation could be deleted by another request.

2. _SQL JOIN in DELETE_: Drizzle ORM doesn't support `DELETE ... USING` syntax cleanly. The subquery approach uses standard Drizzle API.

3. _Raw SQL_: The codebase uses Drizzle consistently (see `queries.ts` with 24 exported functions, all using Drizzle). Breaking this pattern would be inconsistent.

**Rationale**: The subquery pattern produces a single atomic SQL statement, is consistent with the existing Drizzle-based query patterns in the codebase, and correctly prevents IDOR by verifying installation ownership at the database level.

---

### Decision 7: PostgresMemoryStorage Created Per-Request for Management Routes

**Choice**: The 3 new DELETE API routes in `api.ts` do NOT use `PostgresMemoryStorage` at all — they call the DB query functions from `ghagga-db` directly. This is consistent with how ALL existing API routes work (e.g., `getSessionsByProject(db, project)`, `getRepoByFullName(db, fullName)`).

The `PostgresMemoryStorage` adapter exists for the webhook/review pipeline (which receives a `MemoryStorage` instance via dependency injection). The Dashboard API routes are a separate code path that talks to the DB directly.

**Alternatives considered**:
1. _Create a PostgresMemoryStorage instance in each route handler_: Would add an unnecessary abstraction layer. The existing pattern in `api.ts` is to call `ghagga-db` functions directly — all 20+ existing routes do this.

**Rationale**: Following the existing pattern is the correct choice. The adapter is updated to be functional (no more stubs), but the API routes use the same direct-query pattern as every other route in the file.

---

## Data Flow

### Single Observation Delete (Tier 1)

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────────┐
│  Dashboard   │     │  Hono API    │     │  ghagga-db   │     │ PostgreSQL │
│  (React)     │     │  (Server)    │     │  (queries)   │     │            │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └─────┬──────┘
       │                     │                     │                   │
       │ User clicks trash   │                     │                   │
       │ icon on observation  │                     │                   │
       │                     │                     │                   │
       ├─ ConfirmDialog      │                     │                   │
       │  (Tier 1: simple)   │                     │                   │
       │                     │                     │                   │
       │ User clicks "Delete"│                     │                   │
       │                     │                     │                   │
       ├─ mutate({ id: 42 }) │                     │                   │
       │                     │                     │                   │
       ├─ DELETE /api/memory/observations/42 ─────►│                   │
       │  Authorization: Bearer <token>            │                   │
       │                     │                     │                   │
       │                     ├─ parse :id = 42     │                   │
       │                     ├─ get user from ctx  │                   │
       │                     │                     │                   │
       │                     ├─ deleteMemoryObservation(db, 100, 42)──►│
       │                     │                     │                   │
       │                     │                     ├─ DELETE FROM      │
       │                     │                     │  memory_obs       │
       │                     │                     │  WHERE id=42      │
       │                     │                     │  AND project IN   │
       │                     │                     │  (SELECT full_name│
       │                     │                     │   FROM repos      │
       │                     │                     │   WHERE inst=100) │
       │                     │                     │                   │
       │                     │                     │◄─ rowCount: 1 ────┤
       │                     │                     │                   │
       │                     │◄─ return true ──────┤                   │
       │                     │                     │                   │
       │◄─ 200 { data: { deleted: true } } ───────┤                   │
       │                     │                     │                   │
       ├─ invalidateQueries  │                     │                   │
       │  ['memory', ...]    │                     │                   │
       │                     │                     │                   │
       ├─ show Toast:        │                     │                   │
       │  "Observation        │                     │                   │
       │   deleted"          │                     │                   │
       │                     │                     │                   │
```

### Clear Repo Memory (Tier 2)

```
User clicks "Clear Memory" → ConfirmDialog (Tier 2: type repo name)
  → User types "acme/widgets" → confirm enabled
  → useClearRepoMemory.mutate({ project: "acme/widgets" })
    → DELETE /api/memory/projects/acme%2Fwidgets/observations
      → decodeURIComponent("acme%2Fwidgets") → "acme/widgets"
      → getRepoByFullName(db, "acme/widgets") → repo
      → verify repo.installationId in user.installationIds
      → clearMemoryObservationsByProject(db, 100, "acme/widgets")
        → SQL: DELETE FROM memory_observations
               WHERE project = 'acme/widgets'
               AND project IN (SELECT full_name FROM repositories
                               WHERE installation_id = 100)
        → returns count of deleted rows
      → 200 { data: { cleared: 15 } }
    → invalidateQueries(['memory', ...])
    → Toast: "Cleared 15 observations from acme/widgets"
```

### Purge All Memory (Tier 3)

```
User clicks "Purge All Memory" → ConfirmDialog (Tier 3: type "DELETE ALL" + 5s countdown)
  → Countdown: "Purge All (5s)" → (4s) → (3s) → (2s) → (1s) → "Purge All"
  → User types "DELETE ALL" AND countdown expired → confirm enabled
  → usePurgeAllMemory.mutate()
    → DELETE /api/memory/observations
      → user.installationIds = [100, 200]
      → for each installationId:
          clearAllMemoryObservations(db, installationId)
      → sum counts: 30 + 20 = 50
      → 200 { data: { cleared: 50 } }
    → invalidateQueries({ queryKey: ['memory'] })
    → Toast: "Purged 50 observations from all repositories"
```

---

## File Changes

| File                                                   | Action | Description                                                                                                                                                           |
| ------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/queries.ts`                           | Modify | Add 5 new exported functions: `deleteMemoryObservation`, `clearMemoryObservationsByProject`, `clearAllMemoryObservations`, `listMemoryObservations`, `getMemoryStats` |
| `apps/server/src/routes/api.ts`                        | Modify | Add 3 DELETE routes under the existing `createApiRouter` function; add new imports from `ghagga-db`                                                                   |
| `apps/server/src/memory/postgres.ts`                   | Modify | Replace 5 stub methods with real implementations; extend constructor to accept `installationId`; add new imports from `ghagga-db`                                     |
| `apps/dashboard/src/lib/api.ts`                        | Modify | Add 3 mutation hooks: `useDeleteObservation`, `useClearRepoMemory`, `usePurgeAllMemory`                                                                               |
| `apps/dashboard/src/pages/Memory.tsx`                  | Modify | Add trash icon on `ObservationCard`, "Clear Memory" button, "Purge All Memory" button; integrate `ConfirmDialog` and `useToast`; add empty states after deletion      |
| `apps/dashboard/src/components/ConfirmDialog.tsx`      | Create | Reusable confirmation dialog with 3-tier support (simple, text-match, text-match + countdown)                                                                         |
| `apps/dashboard/src/components/Toast.tsx`              | Create | Toast notification system: `ToastProvider`, `useToast()` hook, `ToastContainer` portal                                                                                |
| `packages/db/src/queries.test.ts`                      | Modify | Add test suites for all 5 new query functions                                                                                                                         |
| `apps/server/src/routes/api.test.ts`                   | Modify | Add test suites for 3 DELETE routes (auth, 400/403/404, success, edge cases)                                                                                          |
| `apps/server/src/memory/postgres.test.ts`              | Modify | Replace 7 stub-throws tests with delegation tests for real implementations                                                                                            |
| `apps/dashboard/src/lib/api.test.ts`                   | Modify | Add tests for 3 mutation hooks                                                                                                                                        |
| `apps/dashboard/src/pages/Memory.test.tsx`             | Modify | Add tests for delete buttons, modal triggers, confirmation flows                                                                                                      |
| `apps/dashboard/src/components/ConfirmDialog.test.tsx` | Create | Tests for all 3 tiers, text matching, countdown timer, escape, backdrop click                                                                                         |
| `apps/dashboard/src/components/Toast.test.tsx`         | Create | Tests for toast rendering, auto-dismiss, stacking                                                                                                                     |

---

## Interfaces / Contracts

### New DB Query Functions (`packages/db/src/queries.ts`)

```typescript
/**
 * Delete a single observation by ID, scoped to installation.
 * Uses subquery to verify observation belongs to the given installation.
 * Returns true if deleted, false if not found or unauthorized.
 */
export async function deleteMemoryObservation(
  db: Database,
  installationId: number,
  observationId: number,
): Promise<boolean>;

/**
 * Clear all observations for a specific project, scoped to installation.
 * Returns the count of deleted rows.
 */
export async function clearMemoryObservationsByProject(
  db: Database,
  installationId: number,
  project: string,
): Promise<number>;

/**
 * Clear all observations for all repos belonging to an installation.
 * Returns the count of deleted rows.
 */
export async function clearAllMemoryObservations(
  db: Database,
  installationId: number,
): Promise<number>;

/**
 * List observations with optional filtering, scoped to installation.
 * Supports filtering by project, type, and pagination (limit/offset).
 */
export async function listMemoryObservations(
  db: Database,
  installationId: number,
  options?: ListObservationsOptions,
): Promise<MemoryObservationDetail[]>;

/**
 * Get aggregate memory statistics for an installation.
 * Returns total count, breakdown by type and project, oldest/newest dates.
 */
export async function getMemoryStats(db: Database, installationId: number): Promise<MemoryStats>;
```

### Updated PostgresMemoryStorage (`apps/server/src/memory/postgres.ts`)

```typescript
export class PostgresMemoryStorage implements MemoryStorage {
  constructor(
    private db: Database,
    private installationId: number,
  ) {}

  // Existing methods unchanged (searchObservations, saveObservation, etc.)
  // ...

  // Management methods — now delegating to ghagga-db queries:

  async listObservations(options?: ListObservationsOptions): Promise<MemoryObservationDetail[]> {
    return listMemoryObservations(this.db, this.installationId, options);
  }

  async getObservation(id: number): Promise<MemoryObservationDetail | null> {
    return getMemoryObservation(this.db, this.installationId, id);
  }

  async deleteObservation(id: number): Promise<boolean> {
    return deleteMemoryObservation(this.db, this.installationId, id);
  }

  async getStats(): Promise<MemoryStats> {
    return getMemoryStats(this.db, this.installationId);
  }

  async clearObservations(options?: { project?: string }): Promise<number> {
    if (options?.project) {
      return clearMemoryObservationsByProject(this.db, this.installationId, options.project);
    }
    return clearAllMemoryObservations(this.db, this.installationId);
  }
}
```

Note: `getMemoryObservation` is an additional read query (returns a single observation detail by ID, scoped by installation). It's needed by `getObservation()` in the adapter but not explicitly called by the API routes (the delete route uses `deleteMemoryObservation` which handles the lookup internally).

### New API Routes (`apps/server/src/routes/api.ts`)

```typescript
// ── DELETE /api/memory/observations ──────────────────────────
// Purge ALL observations (registered before :id route)
router.delete('/api/memory/observations', async (c) => {
  const user = c.get('user') as AuthUser;
  let totalCleared = 0;
  for (const installationId of user.installationIds) {
    totalCleared += await clearAllMemoryObservations(db, installationId);
  }
  return c.json({ data: { cleared: totalCleared } });
});

// ── DELETE /api/memory/observations/:id ──────────────────────
router.delete('/api/memory/observations/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Invalid observation ID' }, 400);
  }
  // Try delete scoped to each installation
  for (const installationId of user.installationIds) {
    const deleted = await deleteMemoryObservation(db, installationId, id);
    if (deleted) {
      return c.json({ data: { deleted: true } });
    }
  }
  return c.json({ error: 'Observation not found' }, 404);
});

// ── DELETE /api/memory/projects/:project/observations ────────
router.delete('/api/memory/projects/:project/observations', async (c) => {
  const user = c.get('user') as AuthUser;
  const project = decodeURIComponent(c.req.param('project'));
  const repo = await getRepoByFullName(db, project);
  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404);
  }
  if (!user.installationIds.includes(repo.installationId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const cleared = await clearMemoryObservationsByProject(db, repo.installationId, project);
  return c.json({ data: { cleared } });
});
```

### New Mutation Hooks (`apps/dashboard/src/lib/api.ts`)

```typescript
export function useDeleteObservation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ observationId }: { observationId: number }) =>
      fetchData<{ deleted: boolean }>(`/api/memory/observations/${observationId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory', 'observations'] });
      void queryClient.invalidateQueries({ queryKey: ['memory', 'sessions'] });
    },
  });
}

export function useClearRepoMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ project }: { project: string }) =>
      fetchData<{ cleared: number }>(
        `/api/memory/projects/${encodeURIComponent(project)}/observations`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory', 'observations'] });
      void queryClient.invalidateQueries({ queryKey: ['memory', 'sessions'] });
    },
  });
}

export function usePurgeAllMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchData<{ cleared: number }>('/api/memory/observations', {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
    },
  });
}
```

### ConfirmDialog Component (`apps/dashboard/src/components/ConfirmDialog.tsx`)

```typescript
interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description: string;
  confirmLabel: string; // "Delete", "Clear Memory", "Purge All"
  confirmVariant?: 'danger'; // Destructive styling (red)
  isLoading?: boolean; // Shows spinner, disables button

  // Tier 2+: Text confirmation
  confirmText?: string; // If set, user must type this to enable confirm
  confirmPlaceholder?: string; // e.g., 'Type "acme/widgets" to confirm'

  // Tier 3: Countdown timer
  countdownSeconds?: number; // If set, button disabled for N seconds after open
}
```

Rendering logic:
- **Tier 1** (`confirmText` absent, `countdownSeconds` absent): Title + description + Cancel + Confirm buttons
- **Tier 2** (`confirmText` set): Title + description + text input + Cancel + Confirm (disabled until input matches `confirmText`)
- **Tier 3** (`confirmText` + `countdownSeconds`): Title + description + text input + Cancel + Confirm (disabled until input matches AND countdown expired; button shows countdown: "Purge All (5s)")

State management:
- `inputValue: string` — controlled text input (Tier 2/3)
- `secondsRemaining: number` — countdown state (Tier 3), decremented via `setInterval`
- Both reset when `open` transitions from `false` to `true`

### Toast System (`apps/dashboard/src/components/Toast.tsx`)

```typescript
interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  duration?: number; // ms, default 4000
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, 'id'>) => void;
}

// Usage:
const { addToast } = useToast();
addToast({ message: 'Observation deleted', type: 'success' });
```

The `ToastProvider` wraps the app (placed in the root layout). `ToastContainer` renders via `createPortal` to `document.body`, positioned fixed bottom-right. Toasts auto-dismiss via `setTimeout` and stack vertically with CSS transitions.

---

## Testing Strategy

| Layer      | What to Test                                                                                    | Approach                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| DB Queries | `deleteMemoryObservation`: success (S1), not found (S2), IDOR (S3)                              | Vitest with mocked Drizzle `db` object; verify correct SQL builder calls                      |
| DB Queries | `clearMemoryObservationsByProject`: success (S4), empty (S5), IDOR (S6)                         | Same mock approach                                                                            |
| DB Queries | `clearAllMemoryObservations`: multi-repo (S7), empty (S8)                                       | Same mock approach                                                                            |
| DB Queries | `listMemoryObservations`, `getMemoryStats`: correct filtering, aggregation                      | Same mock approach                                                                            |
| API Routes | `DELETE /api/memory/observations/:id`: 200, 400, 404, 401 (S9-S12)                              | Hono `app.request()` with mock user context (existing pattern in api.test.ts)                 |
| API Routes | `DELETE /api/memory/projects/:project/observations`: 200, 401, 403, 404 (S13-S17)               | Same Hono test pattern; verify URL decoding of `%2F`                                          |
| API Routes | `DELETE /api/memory/observations`: 200, 401, multi-install (S18-S21)                            | Same Hono test pattern                                                                        |
| Adapter    | `PostgresMemoryStorage` methods: delegation, return values (S22-S28)                            | Vitest mocking `ghagga-db` (existing pattern in postgres.test.ts)                             |
| Hooks      | `useDeleteObservation`, `useClearRepoMemory`, `usePurgeAllMemory`                               | Vitest mocking `fetchApi`/`fetchData`; verify correct paths, methods, cache invalidation keys |
| Component  | `ConfirmDialog` Tier 1: open/close, confirm, cancel, escape, backdrop (S29-S31)                 | @testing-library/react; `fireEvent.click`, `fireEvent.keyDown`                                |
| Component  | `ConfirmDialog` Tier 2: text matching, case sensitivity, enable/disable (S32-S34)               | @testing-library/react; `fireEvent.change` on input                                           |
| Component  | `ConfirmDialog` Tier 3: countdown timer, dual conditions, reset on close (S35-S40)              | @testing-library/react with `vi.useFakeTimers()` for countdown                                |
| Component  | `Memory.tsx` integration: delete button visibility, modal trigger, success flow (S29, S32, S35) | @testing-library/react with mocked hooks                                                      |
| Component  | `Toast`: rendering, auto-dismiss, type variants                                                 | @testing-library/react with `vi.useFakeTimers()`                                              |

---

## Migration / Rollout

No migration required.

This change adds no new database tables, columns, or indexes. All operations use the existing `memory_observations`, `memory_sessions`, and `repositories` tables with their existing schema and indexes (`idx_observations_project`, `idx_repositories_installation`, `idx_repositories_full_name`).

The rollback plan (from the proposal) remains valid:
1. All changes are additive — `git revert` restores the read-only state
2. No schema migrations to undo
3. The stubs revert to `throw new Error('Not implemented')` — no data corruption
4. Dashboard UI reverts to read-only — no data loss
5. Single feature branch for clean revert

---

## Open Questions

- [x] ~~How does Hono handle route conflicts between `DELETE /api/memory/observations` and `DELETE /api/memory/observations/:id`?~~ **Resolved**: They are distinct paths (different segment counts). Hono handles them correctly regardless of registration order. We register the bare route first for clarity.

- [x] ~~Should the `PostgresMemoryStorage` adapter be used by the API routes?~~ **Resolved**: No. The API routes call `ghagga-db` query functions directly, following the existing pattern used by all 20+ routes in `api.ts`. The adapter is for the webhook/review pipeline.

- [x] ~~Does the dashboard have an existing toast/notification system?~~ **Resolved**: No. We build a minimal one (~80 lines) to satisfy the "no new dependencies" constraint.

- [ ] Should the `ToastProvider` be added to `apps/dashboard/src/App.tsx` or `apps/dashboard/src/main.tsx`? — **Non-blocking**: Will determine during implementation by reading the app's root component. Either location works.

- [ ] The `PostgresMemoryStorage` constructor change from `(db: Database)` to `(db: Database, installationId: number)` will break any existing callers. — **Non-blocking**: Need to verify all instantiation sites. Currently `PostgresMemoryStorage` is only created in the server's webhook/review pipeline where `installationId` is available from the event context.
