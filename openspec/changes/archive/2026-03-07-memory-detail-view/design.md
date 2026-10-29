# Design: Memory Detail View — Severity Expansion + Dashboard UI Enhancements

## Technical Approach

This change cuts across two layers: (1) the backend memory persistence pipeline (core + db packages), and (2) the Dashboard frontend (React UI). The strategy is **backend-first**: add the severity column, update the persistence pipeline, update queries — then build the frontend enhancements on top of the complete data.

The backend changes are small and surgical: one function tweak (`isSignificantFinding`), one new column with migration, and propagation of the severity value through existing save/query paths. The frontend changes are more substantial but follow established patterns (reuse `SeverityBadge`, follow `ConfirmDialog`'s portal pattern for the detail modal, use `cn()` for conditional styling).

---

## Architecture Decisions

### Decision 1: Severity as Nullable VARCHAR, Not ENUM

**Choice**: Store severity as `varchar(10)` (PostgreSQL) / `TEXT` (SQLite), nullable, rather than a PostgreSQL ENUM type.

**Alternatives considered**:
1. _PostgreSQL ENUM type (`CREATE TYPE severity_level AS ENUM (...)`)_ : Would provide stronger type safety at the database level. However, adding values to ENUMs requires a migration, and SQLite has no ENUM type — the two adapters would diverge. The existing codebase uses varchar for similar categorical columns (e.g., `type varchar(30)` for observation type).

2. _NOT NULL with default_: Would require backfilling all existing observations. The migration would need to update potentially thousands of rows, adding deployment risk. Nullable with graceful NULL handling is safer.

**Rationale**: Consistency with existing schema patterns (varchar for categorical fields), compatibility across both PostgreSQL and SQLite, and zero-risk migration (nullable column with no default = instant O(1) ALTER TABLE in both databases).

---

### Decision 2: Severity on Observations, Not Sessions

**Choice**: Store `severity` on individual `memory_observations` rows, not on `memory_sessions`. Derive session-level severity distribution via query aggregation.

**Alternatives considered**:
1. _Store severity distribution on sessions (e.g., `severity_counts JSONB`)_ : Would denormalize the data, requiring updates whenever an observation is added or deleted. The delete/clear operations from `dashboard-memory-management` would need to recalculate session severity counts — adding complexity and race conditions.

2. _Store both (on observation + cached on session)_ : Over-engineering for the current scale. The observation count per session is typically < 20.

**Rationale**: Single source of truth. The severity lives on the observation (where it originates from the review finding). Session-level severity distribution is computed by the `getSessionsByProject` query using a GROUP BY + conditional count. This is efficient for typical dataset sizes and avoids cache invalidation complexity.

---

### Decision 3: Client-Side Filtering and Sorting

**Choice**: Implement severity filtering and sort options as client-side operations on already-loaded observation data, rather than adding new API query parameters.

**Alternatives considered**:
1. _Server-side filtering via query params (e.g., `GET /api/memory/sessions/:id/observations?severity=high&sort=severity`)_ : Would require changes to the API route and the `getObservationsBySession` query. More correct for large datasets, but observations per session are typically < 20. The extra API complexity is not justified.

2. _Hybrid (server-side pagination + client-side filter)_ : The current API already returns all observations for a session without pagination. Adding pagination now would be a larger scope change.

**Rationale**: The current data loading pattern fetches all observations for a session at once (typically 5-15 observations). Client-side filtering and sorting on this small dataset is instantaneous and avoids API changes. If session observation counts grow significantly in the future, server-side filtering can be added as a separate change.

---

### Decision 4: Vanilla JS Relative Time via Intl.RelativeTimeFormat

**Choice**: Implement relative time formatting using the browser's built-in `Intl.RelativeTimeFormat` API, wrapped in a small utility function.

**Alternatives considered**:
1. _date-fns `formatDistanceToNow()`_ : Excellent API, but adds a new dependency. The spec requires no new dependencies (CC3).

2. _dayjs with relativeTime plugin_ : Same dependency issue.

3. _Custom implementation without Intl_ : Would require manually defining time thresholds and format strings for each unit. Error-prone and locale-unfriendly.

**Rationale**: `Intl.RelativeTimeFormat` is supported in all modern browsers (Chrome 71+, Firefox 65+, Safari 14+) and Node.js 12+. The GHAGGA dashboard already targets modern browsers (no IE11 support). A ~20-line utility function wrapping the API handles all time unit selection logic.

Implementation:
```typescript
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const absDiffMs = Math.abs(diffMs);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60_000],
    ['minute', 3_600_000],
    ['hour', 86_400_000],
    ['day', 2_592_000_000],
    ['month', 31_536_000_000],
    ['year', Infinity],
  ];

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  for (let i = 0; i < units.length; i++) {
    const [unit, threshold] = units[i];
    if (absDiffMs < threshold || i === units.length - 1) {
      const divisor = i === 0 ? 1000 : units[i - 1][1] / (i <= 1 ? 1000 : 1);
      // Compute proper divisor for each unit
      const divisors: Record<string, number> = {
        second: 1000,
        minute: 60_000,
        hour: 3_600_000,
        day: 86_400_000,
        month: 2_592_000_000,
        year: 31_536_000_000,
      };
      const value = Math.round(diffMs / divisors[unit]);
      return rtf.format(value, unit);
    }
  }
  return rtf.format(0, 'second');
}
```

---

### Decision 5: ObservationDetailModal as Separate Component

**Choice**: Create a new `ObservationDetailModal` component at `apps/dashboard/src/components/ObservationDetailModal.tsx` rather than embedding the detail view inline in `Memory.tsx`.

**Alternatives considered**:
1. _Inline expansion within ObservationCard (accordion pattern)_ : Would add significant complexity to the card component and make the already-large Memory.tsx even larger (722 lines). Expandable cards also don't work well for displaying large amounts of content.

2. _Slide-in panel (drawer)_ : A valid UX pattern, but the existing modal pattern (from `ConfirmDialog`) is already established. Using a different pattern would be inconsistent.

3. _Navigate to a separate route (`/memory/observations/:id`)_ : Breaks the single-page flow of the Memory page. Users expect to quickly peek at details and return to the list.

**Rationale**: A modal component is consistent with the existing `ConfirmDialog` pattern, keeps the Memory page focused on list/session management, and allows the detail view to grow in complexity (syntax highlighting, revision history) without polluting the parent component.

---

### Decision 6: Severity Distribution via SQL Aggregation in getSessionsByProject

**Choice**: Enhance the existing `getSessionsByProject` query to include severity distribution using a conditional count aggregation:

```typescript
const rows = await db
  .select({
    id: memorySessions.id,
    project: memorySessions.project,
    prNumber: memorySessions.prNumber,
    summary: memorySessions.summary,
    createdAt: memorySessions.startedAt,
    observationCount: sql<number>`cast(count(${memoryObservations.id}) as int)`,
    severityCounts: sql<string>`json_object_agg(
      coalesce(${memoryObservations.severity}, 'none'),
      1
    )`,
  })
  ...
```

Actually, the simpler approach is to use individual conditional counts:

```typescript
criticalCount: sql<number>`cast(count(case when ${memoryObservations.severity} = 'critical' then 1 end) as int)`,
highCount: sql<number>`cast(count(case when ${memoryObservations.severity} = 'high' then 1 end) as int)`,
mediumCount: sql<number>`cast(count(case when ${memoryObservations.severity} = 'medium' then 1 end) as int)`,
```

**Alternatives considered**:
1. _Separate query for severity distribution per session_ : Would require N+1 queries (one per session). The current query already does a LEFT JOIN + GROUP BY, so adding conditional counts is free.

2. _Compute in the frontend from observation data_ : Would require loading all observations for all sessions upfront. Currently, observations are loaded lazily when a session is expanded.

**Rationale**: Adding conditional count columns to the existing GROUP BY query is the most efficient approach — zero additional queries, and the data is available immediately when rendering session items.

---

### Decision 7: SQLite ALTER TABLE Migration Strategy

**Choice**: Execute `ALTER TABLE memory_observations ADD COLUMN severity TEXT` during database initialization, wrapped in a try/catch that silently ignores the "duplicate column" error.

```typescript
try {
  this.db.exec(`ALTER TABLE memory_observations ADD COLUMN severity TEXT`);
} catch (error) {
  // Column already exists — ignore
  if (!String(error).includes('duplicate column name')) {
    throw error;
  }
}
```

**Alternatives considered**:
1. _Check schema with `PRAGMA table_info(memory_observations)` first_ : More explicit, but adds a query on every initialization. The try/catch approach is simpler and equally correct.

2. _Version tracking table_ : Over-engineering for SQLite, which is used in CLI/Action mode where the database is effectively single-user and often ephemeral (recreated per cache cycle in Actions).

3. _Drop and recreate the table_ : Would lose all existing data. Unacceptable.

**Rationale**: The try/catch approach is the standard SQLite migration pattern for simple column additions. It's idempotent, zero-cost when the column already exists (the error is caught before any work is done), and doesn't require tracking migration state.

---

## Data Flow

### Severity Persistence Pipeline

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Review Pipeline  │     │  persist.ts       │     │  MemoryStorage   │
│  (AI model output)│     │  (significance    │     │  (SQLite/PG)     │
└────────┬─────────┘     │   filter)         │     └────────┬─────────┘
         │                └────────┬─────────┘              │
         │                         │                         │
         ├─ ReviewFinding          │                         │
         │  severity: 'medium'     │                         │
         │  category: 'performance'│                         │
         │                         │                         │
         │─────────────────────────►                         │
         │                         │                         │
         │                  isSignificantFinding()           │
         │                  'critical' ✓                     │
         │                  'high'     ✓                     │
         │                  'medium'   ✓ (NEW)               │
         │                  'low'      ✗                     │
         │                  'info'     ✗                     │
         │                         │                         │
         │                  saveObservation({                │
         │                    severity: 'medium',  ← NEW     │
         │                    type: 'pattern',               │
         │                    title: '...',                  │
         │                    content: '...',                │
         │                  })─────────────────────────────►│
         │                         │                         │
         │                         │              INSERT INTO│
         │                         │              memory_obs │
         │                         │              (...,      │
         │                         │               severity) │
         │                         │              VALUES     │
         │                         │              (...,      │
         │                         │               'medium') │
```

### Dashboard Data Flow (Observation Detail)

```
User clicks ObservationCard
        │
        ▼
Memory.tsx: setSelectedObservation(obs)
        │
        ▼
<ObservationDetailModal
  observation={selectedObservation}
  onClose={() => setSelectedObservation(null)}
/>
        │
        ▼
Modal renders via portal:
  ┌─────────────────────────────────┐
  │ ╔═══════════════════════════╗   │
  │ ║  Null pointer in auth     ║   │
  │ ║                           ║   │
  │ ║  [Critical] [bugfix]      ║   │
  │ ║                           ║   │
  │ ║  [CRITICAL] bug           ║   │
  │ ║  File: src/auth.ts:42     ║   │
  │ ║  Issue: Null pointer...   ║   │
  │ ║                           ║   │
  │ ║  📁 src/auth.ts           ║   │
  │ ║                           ║   │
  │ ║  Topic: auth-null-check   ║   │
  │ ║  Revision 3 · 2 days ago  ║   │
  │ ╚═══════════════════════════╝   │
  └─────────────────────────────────┘
```

### Stats Bar + Filters Data Flow

```
observations[] (from TanStack Query)
        │
        ├─ Filter: severityFilter (state)
        │   └─ observations.filter(o => !severityFilter || o.severity === severityFilter)
        │
        ├─ Filter: typeFilter (existing state)
        │   └─ filtered.filter(o => !typeFilter || o.type === typeFilter)
        │
        ├─ Sort: sortOption (state)
        │   └─ filtered.sort(compareFn)
        │
        ▼
filteredObservations[]
        │
        ├─► StatsBar: compute counts from filteredObservations
        │     total: filteredObservations.length
        │     bySeverity: countBy(o => o.severity)
        │     byType: countBy(o => o.type)
        │
        └─► ObservationCard[] (rendered list)
```

---

## File Changes

| File                                                            | Action        | Description                                                                                                                                             |
| --------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/memory/persist.ts`                           | Modify        | Add `'medium'` to `isSignificantFinding()`; pass `severity: finding.severity` to `saveObservation()`                                                    |
| `packages/core/src/types.ts`                                    | Modify        | Add `severity?: string` to `saveObservation` data param; add `severity: string \| null` to `MemoryObservationRow` and `MemoryObservationDetail`         |
| `packages/core/src/memory/sqlite.ts`                            | Modify        | Add `severity TEXT` to CREATE TABLE; add ALTER TABLE migration; update `saveObservation`, `searchObservations`, `mapToDetail`                           |
| `packages/db/src/schema.ts`                                     | Modify        | Add `severity: varchar('severity', { length: 10 })` to `memoryObservations` table                                                                       |
| `packages/db/drizzle/0006_add_severity_column.sql`              | Create        | `ALTER TABLE "memory_observations" ADD COLUMN "severity" varchar(10);`                                                                                  |
| `packages/db/src/queries.ts`                                    | Modify        | Update `saveObservation` to include severity; update `getObservationsBySession` to select severity; enhance `getSessionsByProject` with severity counts |
| `apps/dashboard/src/lib/types.ts`                               | Modify        | Extend `Observation` with `severity`, `topicKey`, `revisionCount`, `updatedAt`; extend `MemorySession` with `severityCounts`                            |
| `apps/dashboard/src/pages/Memory.tsx`                           | Modify        | Enhanced ObservationCard/SessionItem, severity filter state, sort state, stats bar, modal trigger                                                       |
| `apps/dashboard/src/components/ObservationDetailModal.tsx`      | Create        | Full observation detail view modal                                                                                                                      |
| `apps/dashboard/src/lib/utils.ts` (or inline)                   | Create/Modify | `formatRelativeTime()` utility function                                                                                                                 |
| `packages/core/src/memory/persist.test.ts`                      | Modify        | Add tests for medium severity and severity persistence                                                                                                  |
| `packages/db/src/queries.test.ts`                               | Modify        | Update tests for severity in saveObservation and query results                                                                                          |
| `apps/dashboard/src/pages/Memory.test.tsx`                      | Modify        | Tests for severity badge, filter, sort, stats bar, detail modal                                                                                         |
| `apps/dashboard/src/components/ObservationDetailModal.test.tsx` | Create        | Tests for modal rendering, all fields, close behavior                                                                                                   |

---

## Interfaces / Contracts

### Updated MemoryStorage.saveObservation (`packages/core/src/types.ts`)

```typescript
saveObservation(data: {
  sessionId?: number;
  project: string;
  type: string;
  title: string;
  content: string;
  topicKey?: string;
  filePaths?: string[];
  severity?: string;  // NEW — optional, stored as-is or NULL
}): Promise<MemoryObservationRow>;
```

### Updated MemoryObservationRow (`packages/core/src/types.ts`)

```typescript
export interface MemoryObservationRow {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
  severity: string | null; // NEW
}
```

### Updated MemoryObservationDetail (`packages/core/src/types.ts`)

```typescript
export interface MemoryObservationDetail {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
  project: string;
  topicKey: string | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
  severity: string | null; // NEW
}
```

### Updated Dashboard Observation (`apps/dashboard/src/lib/types.ts`)

```typescript
export interface Observation {
  id: number;
  sessionId: number;
  type: 'decision' | 'pattern' | 'bugfix' | 'learning' | 'architecture' | 'config' | 'discovery';
  title: string;
  content: string;
  filePaths: string[];
  createdAt: string;
  severity: string | null; // NEW
  topicKey: string | null; // NEW
  revisionCount: number; // NEW
  updatedAt: string; // NEW
}
```

### Updated Dashboard MemorySession (`apps/dashboard/src/lib/types.ts`)

```typescript
export interface MemorySession {
  id: number;
  project: string;
  prNumber: number;
  summary: string;
  createdAt: string;
  observationCount: number;
  criticalCount: number; // NEW
  highCount: number; // NEW
  mediumCount: number; // NEW
}
```

### ObservationDetailModal Props (`apps/dashboard/src/components/ObservationDetailModal.tsx`)

```typescript
interface ObservationDetailModalProps {
  observation: Observation | null; // null = closed
  project: string; // for PR link construction
  prNumber?: number; // for PR link
  onClose: () => void;
}
```

### formatRelativeTime Utility

```typescript
/**
 * Format an ISO 8601 date string as a relative time string.
 * Uses Intl.RelativeTimeFormat (no external dependencies).
 *
 * @example formatRelativeTime('2026-03-07T10:00:00Z') → "2 hours ago"
 */
export function formatRelativeTime(dateStr: string): string;
```

---

## Testing Strategy

| Layer       | What to Test                                             | Approach                                                                                                                               |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Core        | `isSignificantFinding()` returns true for medium (S1-S3) | Vitest unit test; import and test the function directly (it's not exported, so test via `persistReviewObservations` with mock storage) |
| Core        | Severity passed to `saveObservation()` (S9-S10)          | Vitest; verify mock storage's `saveObservation` receives `severity` field                                                              |
| Core/SQLite | SQLite schema migration (S6-S8)                          | Vitest; create temp SQLite db, run init twice, verify idempotent                                                                       |
| Core/SQLite | `mapToDetail` includes severity (S15-S16)                | Vitest; insert row with/without severity, verify mapped output                                                                         |
| DB          | `saveObservation` persists severity (S4, S9, S11)        | Vitest with mocked Drizzle; verify INSERT includes severity column                                                                     |
| DB          | `getObservationsBySession` returns severity (S13)        | Vitest with mocked Drizzle; verify SELECT includes severity                                                                            |
| DB          | `getSessionsByProject` returns severity counts (S14)     | Vitest with mocked Drizzle; verify conditional count columns                                                                           |
| DB          | Migration file content                                   | Vitest; read file and assert SQL content                                                                                               |
| Dashboard   | `SeverityBadge` rendered on ObservationCard (S17-S18)    | @testing-library/react; verify badge present/absent based on severity                                                                  |
| Dashboard   | PR link on SessionItem (S19-S20)                         | @testing-library/react; verify link href and presence                                                                                  |
| Dashboard   | Revision count badge (S21-S22)                           | @testing-library/react; verify badge text and conditional rendering                                                                    |
| Dashboard   | Relative timestamps (S23)                                | Vitest unit test for `formatRelativeTime`                                                                                              |
| Dashboard   | Detail modal open/close (S25, S28-S29)                   | @testing-library/react; click card, verify modal, press Escape                                                                         |
| Dashboard   | Detail modal all fields (S26-S27)                        | @testing-library/react; verify all fields rendered with test data                                                                      |
| Dashboard   | Stats bar (S30-S31)                                      | @testing-library/react; verify counts update with filters                                                                              |
| Dashboard   | Severity filter (S32-S34)                                | @testing-library/react; select filter, verify observation list                                                                         |
| Dashboard   | Sort options (S35-S37)                                   | @testing-library/react; select sort, verify observation order                                                                          |
| Dashboard   | Session severity summary (S38-S39)                       | @testing-library/react; verify severity indicators on SessionItem                                                                      |
| Dashboard   | Edge cases (S42-S45)                                     | @testing-library/react; long content scroll, many files truncation, empty state, all-null severity                                     |

---

## Migration / Rollout

### PostgreSQL Migration

**File**: `packages/db/drizzle/0006_add_severity_column.sql`

```sql
ALTER TABLE "memory_observations" ADD COLUMN "severity" varchar(10);
```

- **Performance**: O(1) — PostgreSQL adds nullable columns without a default by only modifying the system catalog. No table rewrite. Zero downtime.
- **Rollback**: `ALTER TABLE "memory_observations" DROP COLUMN "severity";` (manual, not automated)
- **Existing data**: All existing rows get `NULL` for the severity column. No backfill needed.

### SQLite Migration

Executed in `SqliteMemoryStorage` initialization:

```typescript
try {
  this.db.exec(`ALTER TABLE memory_observations ADD COLUMN severity TEXT`);
} catch (error) {
  if (!String(error).includes('duplicate column name')) throw error;
}
```

- **Performance**: O(1) — SQLite adds nullable columns by updating the schema without modifying existing rows.
- **Idempotent**: The try/catch handles the case where the column already exists.
- **Existing data**: All existing rows get `NULL`. No backfill.

### Drizzle Schema Update

The `packages/db/drizzle/meta/_journal.json` MUST be updated to include the new migration entry (Drizzle does this automatically when running `drizzle-kit generate`).

---

## Open Questions

- [x] ~~Should the `SeverityBadge` component be modified to accept `string | null` instead of `Finding['severity']`?~~ **Resolved**: No. Use a type guard at the call site to ensure only valid severity values are passed. The `SeverityBadge` component remains type-safe with its existing interface.

- [x] ~~Should severity filter state be stored in URL search params for shareability?~~ **Resolved**: No. Filter state is ephemeral (resets on navigation). URL params would add complexity without significant benefit for the current use case.

- [ ] The `getSessionsByProject` query enhancement (conditional counts) adds 3 new columns. If more severity levels are added in the future, this pattern doesn't scale. — **Non-blocking**: Only 3 levels are captured (critical/high/medium). The existing `FindingSeverity` type has 5 values but only 3 are persisted. Future changes could switch to a JSON aggregate if needed.

- [ ] The `formatRelativeTime` utility could be placed in a shared utils file or kept in the dashboard. — **Non-blocking**: Will determine during implementation. If other packages need it, extract to `packages/core/src/utils/`. Otherwise, keep in `apps/dashboard/src/lib/utils.ts`.
