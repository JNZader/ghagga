# Proposal: Memory Detail View — Severity Expansion + Dashboard UI Enhancements

## Intent

The Dashboard Memory page currently displays observations as simple cards with only type, title, content, and file paths. Critical information from the review pipeline — **severity**, PR links, topic keys, revision counts, and timestamps — is either not persisted (severity) or not surfaced in the UI (everything else).

Meanwhile, the `isSignificantFinding()` filter in the memory persistence layer only saves `critical` and `high` severity findings, discarding `medium` severity findings that often contain actionable patterns (performance hints, style improvements, error handling suggestions). Users have no way to see what was captured, filter by severity, or inspect observation details beyond the basic card view.

This change addresses both problems: (1) expand the memory pipeline to capture `medium` severity findings and persist the severity level, and (2) enhance the Dashboard Memory page with severity badges, PR links, a detail modal, stats bar, severity filter, and sort options — giving users full visibility into their project's accumulated knowledge.

## Scope

### In Scope

- **Backend: Expand significance filter** in `packages/core/src/memory/persist.ts` — update `isSignificantFinding()` to include `medium` alongside `critical` and `high`
- **Backend: Add `severity` column** to `memory_observations` in both PostgreSQL (Drizzle schema in `packages/db/src/schema.ts`) and SQLite (`packages/core/src/memory/sqlite.ts`)
- **Database migration** — add `0006_add_severity_column.sql` to `packages/db/drizzle/` for existing PostgreSQL databases; add `ALTER TABLE` migration path for existing SQLite databases
- **Backend: Persist severity** — update `saveObservation()` interface in `packages/core/src/types.ts`, update callers in `persist.ts`, update implementations in `packages/db/src/queries.ts` and `packages/core/src/memory/sqlite.ts`
- **Backend: Update type definitions** — add `severity` to `MemoryObservationRow`, `MemoryObservationDetail`, and Dashboard `Observation` type
- **Backend: Update queries** — update `getObservationsBySession`, `getSessionsByProject` (add severity distribution), `searchObservations`, and `mapToDetail` (SQLite) to include `severity`
- **Dashboard: Observation cards** — add severity badge (reuse existing `SeverityBadge` component), PR link, revision count badge, clickable file path chips, code formatting for content, relative timestamps
- **Dashboard: Session items** — add PR link, severity summary dots/counts, duration display
- **Dashboard: Observation detail modal** — expandable view showing all fields: severity badge, full content with syntax highlighting for code blocks, all file paths, topic key, revision history, timestamps
- **Dashboard: Stats bar** — total observations count, breakdown by severity, breakdown by type
- **Dashboard: Severity filter** — dropdown filter alongside existing type filter in the Memory page
- **Dashboard: Sort options** — sort by date (default), severity, or revision count
- **Dashboard: Types** — extend `Observation` type with `severity`, `topicKey`, `revisionCount`, `updatedAt`; extend `MemorySession` with `startedAt`, `endedAt`
- **Tests** — unit tests for backend changes, component tests for all new UI elements

### Out of Scope

- **Observation editing** — observations are AI-generated; editing is not a planned workflow
- **Severity auto-classification changes** — the severity comes from the AI model's assessment; this change only persists and displays it
- **Memory search improvements** — the existing `searchObservations` FTS remains unchanged; severity is added as a column, not to the search index
- **Export/import of observations** — separate feature
- **Batch operations** (multi-select, bulk actions) — separate feature, partially addressed by the `dashboard-memory-management` change
- **New observation types** — the existing 7 types remain unchanged
- **Backfilling severity for existing observations** — existing observations will have `NULL` severity; the UI handles this gracefully with a fallback display

## Approach

### 1. Expand Significance Filter

Update `isSignificantFinding()` in `packages/core/src/memory/persist.ts`:

```typescript
// Before
function isSignificantFinding(finding: ReviewFinding): boolean {
  return finding.severity === 'critical' || finding.severity === 'high';
}

// After
function isSignificantFinding(finding: ReviewFinding): boolean {
  return (
    finding.severity === 'critical' || finding.severity === 'high' || finding.severity === 'medium'
  );
}
```

This is a one-line change. `low` and `info` findings remain excluded to avoid noise — they typically represent minor style suggestions that don't accumulate useful project knowledge.

### 2. Add `severity` Column to Database

**PostgreSQL (Drizzle schema)**: Add `severity: varchar('severity', { length: 10 })` to the `memoryObservations` table definition in `packages/db/src/schema.ts`. Nullable for backward compatibility with existing observations.

**PostgreSQL migration**: Create `packages/db/drizzle/0006_add_severity_column.sql`:
```sql
ALTER TABLE "memory_observations" ADD COLUMN "severity" varchar(10);
```

**SQLite schema**: Add `severity TEXT` to the CREATE TABLE statement in `packages/core/src/memory/sqlite.ts`. For existing databases, execute `ALTER TABLE memory_observations ADD COLUMN severity TEXT` in the initialization path (SQLite supports adding nullable columns to existing tables).

### 3. Persist Severity Through the Pipeline

Update the `saveObservation` interface in `MemoryStorage` (types.ts) to accept an optional `severity` field:

```typescript
saveObservation(data: {
  sessionId?: number;
  project: string;
  type: string;
  title: string;
  content: string;
  topicKey?: string;
  filePaths?: string[];
  severity?: string;  // NEW
}): Promise<MemoryObservationRow>;
```

Update `persistReviewObservations()` in `persist.ts` to pass `finding.severity` when calling `saveObservation()`.

Update both `saveObservation` implementations (PostgreSQL in `queries.ts`, SQLite in `sqlite.ts`) to persist the severity value.

### 4. Update Type Definitions and Queries

Add `severity: string | null` to:
- `MemoryObservationRow` (types.ts)
- `MemoryObservationDetail` (types.ts)
- `Observation` (dashboard types.ts)

Update queries:
- `getObservationsBySession` — include `severity` in select
- `getSessionsByProject` — add severity distribution subquery (count by severity level)
- `searchObservations` — include `severity` in results
- `mapToDetail` (SQLite) — map `severity` column

### 5. Dashboard UI Enhancements

**ObservationCard improvements**:
- Severity badge in card header (reuse `SeverityBadge` component from `apps/dashboard/src/components/SeverityBadge.tsx`)
- PR link as a clickable badge (e.g., "PR #42" linking to the GitHub PR)
- Revision count badge (e.g., "3 revisions" for observations updated by topic-key upsert)
- File paths as clickable chips (navigable in the detail view)
- Content with `font-mono` for code-like formatting
- Relative timestamps (e.g., "2 hours ago", "3 days ago") using vanilla JS `Intl.RelativeTimeFormat`

**SessionItem improvements**:
- PR link badge
- Severity summary: small colored dots or count chips showing the distribution of severities in that session
- Duration display (from `startedAt` to `endedAt` if available)

**Observation Detail Modal** (new):
- Opens when clicking on an ObservationCard
- Full-width panel/modal with all observation fields
- Syntax highlighting for code blocks in content (CSS-only approach using `font-mono` + Tailwind prose-like styling)
- Complete file path list
- Topic key display (for understanding knowledge evolution)
- Revision count with "updated at" timestamp
- Severity badge (large format)
- Close with Escape key or backdrop click

**Stats Bar** (new):
- Horizontal bar at the top of the observations area
- Shows: total observation count, breakdown by severity (colored count chips), breakdown by type
- Updates dynamically when filters change

**Severity Filter** (new):
- Dropdown filter alongside the existing type filter
- Options: All, Critical, High, Medium (and Low/Info if any exist from future changes)
- Filters the observation list client-side (data is already loaded)

**Sort Options** (new):
- Dropdown or toggle buttons: "Newest first" (default), "Severity", "Most revised"
- Severity sort order: critical > high > medium > low > info > null
- Revision sort: highest revision count first

### 6. No New Dependencies

- Relative time formatting: `Intl.RelativeTimeFormat` (built into modern browsers/Node.js)
- Syntax highlighting: CSS-only with Tailwind's `font-mono`, `whitespace-pre-wrap`, and dark-theme code block styles
- All UI components use existing Tailwind + `cn()` utility
- Severity badge reuses existing `SeverityBadge` component

## Affected Areas

| Area                                                       | Impact   | Description                                                                                                                               |
| ---------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/memory/persist.ts`                      | Modified | Expand `isSignificantFinding()` to include `medium`; pass `severity` to `saveObservation()`                                               |
| `packages/core/src/types.ts`                               | Modified | Add `severity` to `saveObservation` interface, `MemoryObservationRow`, `MemoryObservationDetail`                                          |
| `packages/core/src/memory/sqlite.ts`                       | Modified | Add `severity` column to CREATE TABLE; add ALTER TABLE migration; update `mapToDetail`; update `saveObservation` and `searchObservations` |
| `packages/db/src/schema.ts`                                | Modified | Add `severity` varchar column to `memoryObservations` table                                                                               |
| `packages/db/src/queries.ts`                               | Modified | Update `saveObservation`, `getObservationsBySession`, `searchObservations`; update `getSessionsByProject` for severity distribution       |
| `packages/db/drizzle/0006_add_severity_column.sql`         | New      | PostgreSQL migration to add `severity` column                                                                                             |
| `apps/dashboard/src/lib/types.ts`                          | Modified | Extend `Observation` with `severity`, `topicKey`, `revisionCount`, `updatedAt`; extend `MemorySession`                                    |
| `apps/dashboard/src/lib/api.ts`                            | Modified | Update API response handling if needed for new fields                                                                                     |
| `apps/dashboard/src/pages/Memory.tsx`                      | Modified | Enhanced ObservationCard, SessionItem, new detail modal, stats bar, severity filter, sort options                                         |
| `apps/dashboard/src/components/ObservationDetailModal.tsx` | New      | Full observation detail view modal/panel                                                                                                  |
| `packages/core/src/memory/persist.test.ts`                 | Modified | Update tests for medium severity inclusion and severity persistence                                                                       |
| `packages/db/src/queries.test.ts`                          | Modified | Update tests for severity in saveObservation and queries                                                                                  |

## Risks

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Increased memory storage from medium-severity findings                       | Medium     | Low    | Medium-severity findings are typically 30-50% more per review. Storage impact is minimal — observations are small text records. Monitor via existing `getStats()`.                                                                      |
| Existing observations have NULL severity                                     | Certain    | Low    | All UI components handle `null` severity with a fallback display (no badge shown, sorted last in severity sort). No backfill migration needed.                                                                                          |
| `ALTER TABLE` on existing SQLite databases with many rows                    | Low        | Low    | SQLite ALTER TABLE ADD COLUMN is O(1) — it only modifies the schema, not existing rows. Nullable columns are added instantly regardless of table size.                                                                                  |
| PostgreSQL migration on production databases                                 | Low        | Low    | `ALTER TABLE ADD COLUMN` with no default is O(1) in PostgreSQL (only modifies the catalog, doesn't rewrite the table). Zero downtime.                                                                                                   |
| `SeverityBadge` component type mismatch                                      | Low        | Low    | The existing `SeverityBadge` accepts `Finding['severity']` which is `'critical' \| 'high' \| 'medium' \| 'low' \| 'info'`. Observations will have `string \| null`, so we need a type guard to ensure only valid severities are passed. |
| Breaking `MemoryStorage` interface by adding `severity` to `saveObservation` | Low        | Medium | The `severity` field is optional (`severity?: string`). Existing callers without severity continue to work. Both SQLite and PostgreSQL adapters handle the absence.                                                                     |
| Dashboard Memory page complexity (722 lines, adding more)                    | Medium     | Medium | Extract new functionality into separate components: `ObservationDetailModal`, stats bar, filter/sort controls. Keep Memory.tsx as the orchestrator.                                                                                     |

## Rollback Plan

1. **`isSignificantFinding()` change is trivial to revert**: Remove `|| finding.severity === 'medium'`. Future reviews resume saving only critical/high. Already-saved medium observations remain in the database (harmless).
2. **Database columns are additive**: The `severity` column is nullable and has no NOT NULL constraint. `git revert` removes it from the schema definition, but the column persists in the database until manually dropped. No data corruption — the column is simply ignored by queries that don't select it.
3. **PostgreSQL migration**: `ALTER TABLE DROP COLUMN severity` can be applied manually if full rollback is needed. Not automated because column drops should be intentional.
4. **SQLite migration**: The `ALTER TABLE ADD COLUMN severity` is not reversible in SQLite (no DROP COLUMN before SQLite 3.35.0). However, the column is harmless — it's nullable and ignored by old code. For a full rollback, users would need to recreate the database.
5. **Dashboard UI changes are purely visual**: Reverting `Memory.tsx` and removing new components restores the original view. No data dependency — the UI changes only read existing data.
6. **Type definition changes are backward-compatible**: Adding optional `severity?: string` to interfaces doesn't break existing callers. Reverting removes the field.
7. **Single feature branch**: All changes are in one branch. A single `git revert` of the merge commit restores full previous behavior.

## Dependencies

- **No new npm dependencies** — all functionality uses existing packages:
  - `drizzle-orm` (already in `packages/db`) for PostgreSQL schema and queries
  - `hono` (already in `apps/server`) for API routes (minimal changes)
  - `@tanstack/react-query` (already in `apps/dashboard`) for data fetching
  - React + Tailwind CSS (already in `apps/dashboard`) for UI components
  - `Intl.RelativeTimeFormat` (built-in browser API) for relative timestamps
- **Existing `SeverityBadge` component** at `apps/dashboard/src/components/SeverityBadge.tsx` — reused directly
- **Existing `Card`, `ConfirmDialog`, `Toast` components** — reused for modal and feedback patterns
- **Existing `cn()` utility** — used for conditional class composition

## Distribution Mode Impact

| Mode               | Impact                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SaaS**           | Primary target — dashboard gets enhanced Memory page; PostgreSQL migration adds severity column                                                                    |
| **CLI**            | Benefits from expanded significance filter (medium-severity findings now saved); SQLite schema gets severity column; `ghagga memory list` shows severity in output |
| **GitHub Action**  | Benefits from expanded significance filter; SQLite schema gets severity column; cached memory now includes medium-severity observations                            |
| **1-Click Deploy** | Benefits automatically — uses SaaS server, so dashboard changes and PostgreSQL migration are inherited                                                             |

## Success Criteria

- [ ] `isSignificantFinding()` returns `true` for `medium` severity alongside `critical` and `high`
- [ ] `severity` column exists in PostgreSQL `memory_observations` table (nullable varchar(10))
- [ ] `severity` column exists in SQLite `memory_observations` table (nullable TEXT)
- [ ] `saveObservation()` persists severity value when provided, stores NULL when not
- [ ] `MemoryObservationRow` and `MemoryObservationDetail` include `severity: string | null`
- [ ] `getObservationsBySession` returns observations with severity field
- [ ] `getSessionsByProject` returns severity distribution per session
- [ ] Dashboard `ObservationCard` displays severity badge using existing `SeverityBadge` component
- [ ] Dashboard `ObservationCard` shows PR link, revision count, relative timestamps
- [ ] Dashboard `SessionItem` shows PR link and severity summary
- [ ] Clicking an observation opens a detail modal with all fields
- [ ] Stats bar displays total count, severity breakdown, and type breakdown
- [ ] Severity filter dropdown filters observations by severity level
- [ ] Sort options allow sorting by date, severity, and revision count
- [ ] Existing observations with NULL severity display gracefully (no badge, sorted last)
- [ ] No new npm dependencies added
- [ ] All new code has tests
- [ ] Existing tests continue passing
