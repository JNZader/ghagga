# Spec: Memory Detail View — Severity Expansion + Dashboard UI Enhancements

> **Domain**: Memory (Core + Dashboard)  
> **Change**: `memory-detail-view`  
> **Type**: DELTA (extends `openspec/specs/memory-storage/spec.md`)  
> **Status**: Draft  
> **Depends on**: `dashboard-memory-management` (which implemented delete/clear/purge + ConfirmDialog + Toast)  

## Overview

This specification defines two areas of change:
1. **Backend**: Expand the memory significance filter to include `medium` severity findings, add a `severity` column to the observation data model (both PostgreSQL and SQLite), and propagate severity through the persistence and query pipeline.

2. **Dashboard**: Enhance the Memory page with severity badges, PR links, an observation detail modal, stats bar, severity filter, and sort options — transforming the page from a basic observation browser into a comprehensive memory management interface.

All observations with `NULL` severity (pre-existing data) MUST be handled gracefully throughout.

---

## Requirements

### R1: Expand Significance Filter to Include Medium Severity

The `isSignificantFinding()` function in `packages/core/src/memory/persist.ts` MUST be updated to return `true` for `medium` severity findings in addition to `critical` and `high`.

The function MUST continue to return `false` for `low` and `info` severity findings.

#### Scenario: S1 — Medium severity finding is persisted

- GIVEN a review result contains a finding with `severity: 'medium'` and `category: 'performance'`
- WHEN `persistReviewObservations()` is called
- THEN the finding MUST be saved as a memory observation via `saveObservation()`
- AND the observation's content MUST include `[MEDIUM] performance`

#### Scenario: S2 — Low severity finding is still excluded

- GIVEN a review result contains only a finding with `severity: 'low'`
- WHEN `persistReviewObservations()` is called
- THEN no observations MUST be saved (aside from no session being created)
- AND `saveObservation()` MUST NOT be called

#### Scenario: S3 — Mixed severities: all three significant levels captured

- GIVEN a review result contains 3 findings: one `critical`, one `high`, one `medium`
- WHEN `persistReviewObservations()` is called
- THEN 3 finding observations MUST be saved (plus 1 summary observation)
- AND all 3 findings MUST pass the significance filter

---

### R2: Add `severity` Column to PostgreSQL Schema

A `severity` column MUST be added to the `memoryObservations` table in `packages/db/src/schema.ts`.

The column MUST:
- Be of type `varchar('severity', { length: 10 })`
- Be nullable (no `.notNull()`) for backward compatibility with existing observations
- Accept values: `'critical'`, `'high'`, `'medium'`, `'low'`, `'info'`, or `NULL`

A corresponding migration file `packages/db/drizzle/0006_add_severity_column.sql` MUST be created containing:
```sql
ALTER TABLE "memory_observations" ADD COLUMN "severity" varchar(10);
```

#### Scenario: S4 — New observation stored with severity

- GIVEN the `severity` column exists in `memory_observations`
- WHEN a new observation is inserted with `severity: 'medium'`
- THEN the `severity` column MUST contain `'medium'`

#### Scenario: S5 — Existing observations have NULL severity

- GIVEN the migration has been applied to a database with existing observations
- WHEN a SELECT query reads existing observations
- THEN the `severity` column MUST be `NULL` for pre-existing rows
- AND no error MUST occur

---

### R3: Add `severity` Column to SQLite Schema

The SQLite schema in `packages/core/src/memory/sqlite.ts` MUST be updated to include `severity TEXT` in the `CREATE TABLE IF NOT EXISTS memory_observations` statement.

For existing SQLite databases, an `ALTER TABLE memory_observations ADD COLUMN severity TEXT` statement MUST be executed during initialization. The implementation MUST handle the case where the column already exists (e.g., by catching the "duplicate column name" error or checking the schema first).

#### Scenario: S6 — New SQLite database includes severity column

- GIVEN a fresh SQLite database is created
- WHEN the schema initialization runs
- THEN the `memory_observations` table MUST include a `severity` column of type TEXT

#### Scenario: S7 — Existing SQLite database gets severity column via migration

- GIVEN an existing SQLite database WITHOUT a `severity` column
- WHEN the application initializes the database
- THEN an `ALTER TABLE` MUST add the `severity` column
- AND existing observations MUST NOT be modified

#### Scenario: S8 — Migration is idempotent for SQLite

- GIVEN the `severity` column already exists in the SQLite database
- WHEN the application initializes the database
- THEN no error MUST occur
- AND the schema MUST remain unchanged

---

### R4: Update `saveObservation` Interface and Implementations

The `saveObservation` method in the `MemoryStorage` interface (`packages/core/src/types.ts`) MUST accept an optional `severity` field:

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

The PostgreSQL implementation in `packages/db/src/queries.ts` MUST:
- Include `severity` in the INSERT statement when provided
- Preserve existing `severity` value during topic-key upsert (update to new severity if provided)
- Include `severity` in the returned row

The SQLite implementation in `packages/core/src/memory/sqlite.ts` MUST:
- Include `severity` in the INSERT statement when provided
- Store `NULL` when severity is not provided

The `persistReviewObservations()` function in `packages/core/src/memory/persist.ts` MUST pass `finding.severity` to `saveObservation()` for each finding observation. The summary observation (PR review) MAY omit severity or use `null`.

#### Scenario: S9 — Severity persisted through pipeline

- GIVEN a review finding with `severity: 'high'`
- WHEN `persistReviewObservations()` calls `saveObservation()`
- THEN the `data` argument MUST include `severity: 'high'`
- AND the stored observation MUST have `severity: 'high'`

#### Scenario: S10 — Summary observation has no severity

- GIVEN a review with significant findings
- WHEN `persistReviewObservations()` saves the summary observation ("PR #N review: status")
- THEN the `data` argument SHOULD NOT include `severity` or SHOULD include `severity: undefined`
- AND the stored observation MUST have `severity: NULL`

#### Scenario: S11 — Topic-key upsert preserves/updates severity

- GIVEN an existing observation with `topicKey: 'auth-pattern'` and `severity: 'high'`
- WHEN a new observation with `topicKey: 'auth-pattern'` and `severity: 'medium'` is saved
- THEN the existing observation MUST be updated with `severity: 'medium'`

---

### R5: Update Type Definitions

The `MemoryObservationRow` interface in `packages/core/src/types.ts` MUST be extended with:
```typescript
severity: string | null;
```

The `MemoryObservationDetail` interface in `packages/core/src/types.ts` MUST be extended with:
```typescript
severity: string | null;
```

The `Observation` interface in `apps/dashboard/src/lib/types.ts` MUST be extended with:
```typescript
severity: string | null;
topicKey: string | null;
revisionCount: number;
updatedAt: string;
```

The `MemorySession` interface in `apps/dashboard/src/lib/types.ts` SHOULD be extended with:
```typescript
severityCounts?: Record<string, number>;  // e.g., { critical: 2, high: 5, medium: 3 }
```

#### Scenario: S12 — Dashboard receives severity in observation data

- GIVEN the API returns observations with the `severity` field
- WHEN the Dashboard renders observation cards
- THEN each observation object MUST have a `severity` property (string or null)

---

### R6: Update Queries to Include Severity

The `getObservationsBySession` function in `packages/db/src/queries.ts` MUST include the `severity` column in its SELECT results.

The `searchObservations` function in `packages/db/src/queries.ts` MUST include the `severity` column in its returned `MemoryObservationRow[]`.

The `getSessionsByProject` function in `packages/db/src/queries.ts` SHOULD be enhanced to return severity distribution per session. This MAY be implemented as:
- A subquery that counts observations by severity for each session
- A JSON aggregate column: `severityCounts`

The `mapToDetail` function in `packages/core/src/memory/sqlite.ts` MUST map the `severity` column to the `MemoryObservationDetail.severity` field.

#### Scenario: S13 — Observations returned with severity

- GIVEN a session has observations with severities: `critical`, `high`, `medium`, and `NULL`
- WHEN `getObservationsBySession(db, sessionId)` is called
- THEN each returned observation MUST include a `severity` field
- AND observations with severity MUST return the severity string
- AND observations without severity MUST return `null`

#### Scenario: S14 — Session severity distribution

- GIVEN a session has 2 `critical`, 3 `high`, and 1 `medium` observation
- WHEN `getSessionsByProject(db, project)` is called
- THEN the session entry SHOULD include severity counts: `{ critical: 2, high: 3, medium: 1 }`

#### Scenario: S15 — SQLite mapToDetail includes severity

- GIVEN a SQLite observation row with `severity: 'medium'`
- WHEN `mapToDetail()` is called
- THEN the returned `MemoryObservationDetail` MUST have `severity: 'medium'`

#### Scenario: S16 — SQLite mapToDetail handles NULL severity

- GIVEN a SQLite observation row with no `severity` column value (NULL)
- WHEN `mapToDetail()` is called
- THEN the returned `MemoryObservationDetail` MUST have `severity: null`

---

### R7: Dashboard — Severity Badge on ObservationCard

Each `ObservationCard` in `apps/dashboard/src/pages/Memory.tsx` MUST display a severity badge when the observation has a non-null severity.

The badge MUST:
- Use the existing `SeverityBadge` component from `apps/dashboard/src/components/SeverityBadge.tsx`
- Be positioned in the card header area, next to the observation type badge
- NOT be rendered when severity is `null`

#### Scenario: S17 — Severity badge displayed for observation with severity

- GIVEN an observation with `severity: 'high'`
- WHEN the `ObservationCard` renders
- THEN a severity badge with text "High" and orange styling MUST be visible
- AND the badge MUST use the `SeverityBadge` component

#### Scenario: S18 — No severity badge for NULL severity

- GIVEN an observation with `severity: null`
- WHEN the `ObservationCard` renders
- THEN no severity badge MUST be shown
- AND the card MUST still render correctly with the type badge only

---

### R8: Dashboard — PR Link on ObservationCard and SessionItem

Each `ObservationCard` SHOULD display a PR link badge (e.g., "PR #42") when the observation's session has a `prNumber`.

Each `SessionItem` MUST display a PR link (e.g., "PR #42") linking to `https://github.com/{project}/pull/{prNumber}` when `prNumber` is available.

#### Scenario: S19 — PR link displayed on SessionItem

- GIVEN a session with `project: 'acme/widgets'` and `prNumber: 42`
- WHEN the `SessionItem` renders
- THEN a clickable "PR #42" link MUST be visible
- AND clicking it MUST open `https://github.com/acme/widgets/pull/42` in a new tab

#### Scenario: S20 — No PR link when prNumber is absent

- GIVEN a session with `prNumber: null` or `prNumber: 0`
- WHEN the `SessionItem` renders
- THEN no PR link MUST be shown

---

### R9: Dashboard — Enhanced ObservationCard Display

Each `ObservationCard` MUST be enhanced with the following display improvements:
1. **Revision count badge**: When `revisionCount > 1`, display a badge like "3 revisions"
2. **File path chips**: Display file paths as styled chips/tags (not plain text)
3. **Content styling**: Observation content MUST use `font-mono` for code-like formatting with `whitespace-pre-wrap`
4. **Relative timestamps**: Display `createdAt` as relative time (e.g., "2 hours ago", "3 days ago") using `Intl.RelativeTimeFormat`

The card MUST remain clickable to open the observation detail modal (R10).

#### Scenario: S21 — Revision count badge shown for revised observations

- GIVEN an observation with `revisionCount: 5`
- WHEN the `ObservationCard` renders
- THEN a "5 revisions" badge MUST be visible

#### Scenario: S22 — No revision badge for single-revision observations

- GIVEN an observation with `revisionCount: 1`
- WHEN the `ObservationCard` renders
- THEN no revision count badge MUST be shown

#### Scenario: S23 — Relative timestamp display

- GIVEN an observation created 3 hours ago
- WHEN the `ObservationCard` renders
- THEN the timestamp MUST display as "3 hours ago" (or similar relative format)
- AND the full ISO timestamp SHOULD be available as a tooltip (via `title` attribute)

#### Scenario: S24 — File paths displayed as chips

- GIVEN an observation with `filePaths: ['src/auth.ts', 'src/middleware.ts']`
- WHEN the `ObservationCard` renders
- THEN "src/auth.ts" and "src/middleware.ts" MUST be displayed as styled chip elements
- AND the chips MUST use `font-mono` styling

---

### R10: Dashboard — Observation Detail Modal

A new observation detail modal MUST be created at `apps/dashboard/src/components/ObservationDetailModal.tsx`.

The modal MUST open when the user clicks on an `ObservationCard`.

The modal MUST display:
- Observation title (large heading)
- Severity badge (using `SeverityBadge` component, if severity is non-null)
- Type badge
- Full content with code-like formatting (`font-mono`, `whitespace-pre-wrap`)
- All file paths (each as a styled element)
- Topic key (if non-null), displayed with a label: "Topic: {topicKey}"
- Revision count (e.g., "Revision 3 of this topic")
- Created at timestamp (both relative and absolute)
- Updated at timestamp (both relative and absolute, if different from createdAt)

The modal MUST:
- Be rendered via a portal/overlay pattern (consistent with existing `ConfirmDialog`)
- Have a semi-transparent backdrop
- Be closeable by clicking the backdrop, pressing Escape, or clicking an X button
- Be vertically scrollable if content overflows
- Follow the dark theme design of the dashboard

#### Scenario: S25 — Detail modal opens on card click

- GIVEN the user is viewing observations for a session
- WHEN the user clicks on an `ObservationCard`
- THEN a detail modal MUST open with the full observation details
- AND the modal MUST be centered on screen with a backdrop

#### Scenario: S26 — Detail modal displays all fields

- GIVEN an observation with:
  - `severity: 'critical'`
  - `type: 'bugfix'`
  - `title: 'Null pointer in auth middleware'`
  - `content: '[CRITICAL] bug\nFile: src/auth.ts:42\nIssue: Null pointer...'`
  - `filePaths: ['src/auth.ts']`
  - `topicKey: 'auth-null-check'`
  - `revisionCount: 3`
  - `createdAt: '2026-03-01T10:00:00Z'`
  - `updatedAt: '2026-03-05T14:30:00Z'`
- WHEN the detail modal is open for this observation
- THEN all fields MUST be visible with appropriate formatting
- AND the severity badge MUST be red ("Critical")
- AND the topic key MUST be displayed as "Topic: auth-null-check"
- AND the revision count MUST be displayed as "Revision 3 of this topic"

#### Scenario: S27 — Detail modal handles NULL fields gracefully

- GIVEN an observation with `severity: null`, `topicKey: null`, `revisionCount: 1`
- WHEN the detail modal is open for this observation
- THEN no severity badge MUST be shown
- AND no topic key section MUST be shown
- AND no revision information MUST be shown (or it SHOULD show "1 revision")

#### Scenario: S28 — Close detail modal with Escape

- GIVEN the observation detail modal is open
- WHEN the user presses the Escape key
- THEN the modal MUST close
- AND the observations list MUST be visible again

#### Scenario: S29 — Close detail modal with backdrop click

- GIVEN the observation detail modal is open
- WHEN the user clicks on the backdrop (outside the modal content)
- THEN the modal MUST close

---

### R11: Dashboard — Stats Bar

A stats bar MUST be displayed at the top of the observations area in the Memory page.

The stats bar MUST show:
- **Total count**: "N observations" where N is the total count of observations in the current view
- **Severity breakdown**: Color-coded count chips for each severity level present (e.g., red "3 critical", orange "5 high", yellow "2 medium")
- **Type breakdown**: Count chips for each observation type present (e.g., "4 pattern", "2 bugfix", "1 learning")

The stats bar MUST update dynamically when filters (severity filter, type filter) change — it SHOULD reflect the filtered subset, not the total.

#### Scenario: S30 — Stats bar displays counts

- GIVEN the current view has 10 observations: 2 critical, 3 high, 5 medium; 4 pattern, 3 bugfix, 3 learning
- WHEN the stats bar renders
- THEN it MUST display "10 observations"
- AND severity chips: "2 critical" (red), "3 high" (orange), "5 medium" (yellow)
- AND type chips: "4 pattern", "3 bugfix", "3 learning"

#### Scenario: S31 — Stats bar updates with filters

- GIVEN the severity filter is set to "Critical"
- AND 2 of 10 observations are critical
- WHEN the stats bar renders
- THEN it MUST display "2 observations"
- AND only the "2 critical" severity chip MUST be shown

---

### R12: Dashboard — Severity Filter

A severity filter dropdown MUST be added to the Memory page alongside the existing type filter.

The filter MUST:
- Display options: "All severities" (default), "Critical", "High", "Medium", "Low", "Info"
- Filter the observation list client-side
- Persist the selected value while the page is active (reset on navigation away)
- Work independently of and in combination with the existing type filter

#### Scenario: S32 — Filter by single severity

- GIVEN the observations list contains observations with critical, high, and medium severities
- WHEN the user selects "High" from the severity filter
- THEN only observations with `severity: 'high'` MUST be displayed
- AND the stats bar MUST update to reflect the filtered subset

#### Scenario: S33 — Filter shows observations with NULL severity

- GIVEN some observations have `severity: null`
- WHEN the "All severities" filter is selected (default)
- THEN all observations MUST be shown, including those with NULL severity

#### Scenario: S34 — Combined severity + type filter

- GIVEN observations exist with various severities and types
- WHEN the user selects severity "Critical" AND type "bugfix"
- THEN only observations matching BOTH criteria MUST be displayed

---

### R13: Dashboard — Sort Options

Sort options MUST be provided for the observation list in the Memory page.

The available sort options MUST be:
- **Newest first** (default): Sort by `createdAt` descending
- **Oldest first**: Sort by `createdAt` ascending
- **Severity**: Sort by severity level descending (critical > high > medium > low > info > null)
- **Most revised**: Sort by `revisionCount` descending

The sort MUST be applied client-side after filtering.

#### Scenario: S35 — Sort by severity

- GIVEN observations with severities: medium, critical, null, high
- WHEN the user selects "Severity" sort
- THEN the observations MUST be ordered: critical, high, medium, null

#### Scenario: S36 — Sort by most revised

- GIVEN observations with revision counts: 1, 5, 3, 2
- WHEN the user selects "Most revised" sort
- THEN the observations MUST be ordered: 5, 3, 2, 1

#### Scenario: S37 — Default sort is newest first

- GIVEN the user has not changed the sort option
- THEN observations MUST be sorted by `createdAt` descending (newest first)

---

### R14: Dashboard — SessionItem Enhancements

Each `SessionItem` in the Memory page MUST be enhanced with:
1. **PR link**: Clickable link to the GitHub PR (R8)
2. **Severity summary**: Small colored dots or count text showing the distribution of severities in that session (e.g., "2● 3● 1●" with critical=red, high=orange, medium=yellow dots)

#### Scenario: S38 — Session shows severity summary

- GIVEN a session with observations: 1 critical, 2 high, 3 medium
- WHEN the `SessionItem` renders
- THEN severity summary indicators MUST be visible
- AND they MUST use the correct colors (red for critical, orange for high, yellow for medium)

#### Scenario: S39 — Session with no severity data

- GIVEN a session where all observations have `severity: null` (pre-existing data)
- WHEN the `SessionItem` renders
- THEN no severity summary MUST be shown (or a neutral "no severity data" indicator)

---

### R15: Dashboard — Relative Time Formatting

Relative time formatting MUST be implemented using the browser's built-in `Intl.RelativeTimeFormat` API.

A utility function MUST be created (e.g., `formatRelativeTime(date: string): string`) that:
- Accepts an ISO 8601 date string
- Returns a human-readable relative time string (e.g., "2 hours ago", "3 days ago", "just now")
- Handles edge cases: future dates, very old dates (> 1 year)

No external date libraries (moment.js, dayjs, date-fns) MUST be added.

#### Scenario: S40 — Recent timestamp

- GIVEN a timestamp from 45 minutes ago
- WHEN `formatRelativeTime()` is called
- THEN it MUST return "45 minutes ago" (or similar)

#### Scenario: S41 — Old timestamp

- GIVEN a timestamp from 30 days ago
- WHEN `formatRelativeTime()` is called
- THEN it MUST return "30 days ago" or "1 month ago" (either is acceptable)

---

## Cross-Cutting Concerns

### CC1: Backward Compatibility with NULL Severity

All code paths that read observations MUST handle `severity: null` gracefully:
- Dashboard components: conditional rendering (show badge only if severity is non-null)
- Sort by severity: NULL values sort last
- Filter by severity: "All severities" includes NULL severity observations
- Stats bar: observations with NULL severity are counted but not included in severity breakdown chips

### CC2: Severity Type Safety

The `SeverityBadge` component accepts `Finding['severity']` (typed as `'critical' | 'high' | 'medium' | 'low' | 'info'`), but observation severity is `string | null`. A type guard MUST be used before passing severity to `SeverityBadge`:

```typescript
const validSeverities = ['critical', 'high', 'medium', 'low', 'info'] as const;
function isValidSeverity(s: string | null): s is Finding['severity'] {
  return s != null && validSeverities.includes(s as any);
}
```

### CC3: No New Dependencies

This change MUST NOT add any new npm dependencies. All functionality uses existing packages and browser APIs:
- `Intl.RelativeTimeFormat` for relative time formatting
- Existing `SeverityBadge` component for severity display
- Existing Tailwind CSS for all styling
- Existing `cn()` utility for conditional classes

### CC4: Dark Theme Consistency

All new UI elements MUST follow the existing dark theme design:
- Background: `bg-gray-900`, `bg-gray-800` for cards
- Text: `text-gray-100`, `text-gray-400` for secondary
- Borders: `border-gray-700`
- Severity colors from existing `SeverityBadge` (red/orange/yellow/blue/gray with opacity)

### CC5: Modal Pattern Consistency

The observation detail modal MUST follow the same portal/overlay pattern established by the existing `ConfirmDialog` component:
- Portal rendering to `document.body`
- Backdrop with `bg-black/50` (or similar)
- Centered with `flex items-center justify-center`
- Escape key and backdrop click to close
- Scroll handling for long content

---

## Edge Cases

### E1: Observation with very long content

- GIVEN an observation with content exceeding 5000 characters
- WHEN the detail modal is open
- THEN the modal MUST be scrollable
- AND the content MUST NOT overflow the viewport

#### Scenario: S42

- GIVEN an observation with 10,000 character content
- WHEN the detail modal is rendered
- THEN vertical scrolling MUST be available within the modal

### E2: Observation with many file paths

- GIVEN an observation with 20+ file paths
- WHEN the ObservationCard renders
- THEN file paths SHOULD be truncated (e.g., show first 3 + "and 17 more")
- AND the detail modal MUST show all file paths

#### Scenario: S43

- GIVEN an observation with 25 file paths
- WHEN the ObservationCard renders
- THEN it SHOULD display at most 5 file paths with a "+20 more" indicator

### E3: Session with 0 observations (after deletion)

- GIVEN a session where all observations have been deleted
- WHEN the SessionItem renders
- THEN it MUST show "0 observations" and no severity summary

#### Scenario: S44

- GIVEN a session with 0 observations
- WHEN the stats bar renders for that session's view
- THEN it MUST show "0 observations" with no severity or type chips

### E4: All observations have NULL severity

- GIVEN a project where all observations pre-date the severity feature
- WHEN the Memory page renders
- THEN no severity badges MUST be shown on any cards
- AND the severity filter SHOULD still be available but filtering to any specific severity yields empty results
- AND the stats bar MUST NOT show any severity chips

#### Scenario: S45

- GIVEN 10 observations all with `severity: null`
- WHEN the severity filter is set to "Critical"
- THEN 0 observations MUST be displayed
- AND the stats bar MUST show "0 observations"

---

## Acceptance Criteria

1. `isSignificantFinding()` returns `true` for `'medium'` severity
2. `severity` varchar(10) nullable column exists in PostgreSQL `memory_observations` table
3. `severity` TEXT nullable column exists in SQLite `memory_observations` table
4. Migration `0006_add_severity_column.sql` applies cleanly and is idempotent
5. SQLite migration adds `severity` column to existing databases without error
6. `saveObservation()` accepts and persists optional `severity` field
7. `persistReviewObservations()` passes `finding.severity` to `saveObservation()` for each finding
8. `MemoryObservationRow` and `MemoryObservationDetail` include `severity: string | null`
9. Dashboard `Observation` type includes `severity`, `topicKey`, `revisionCount`, `updatedAt`
10. `getObservationsBySession` returns observations with `severity` field
11. `getSessionsByProject` returns severity distribution per session
12. `SeverityBadge` displayed on `ObservationCard` when severity is non-null
13. No severity badge shown when severity is `null`
14. PR link displayed on `SessionItem` when `prNumber` is available
15. Revision count badge shown when `revisionCount > 1`
16. File paths displayed as styled chips on `ObservationCard`
17. Content uses `font-mono` formatting
18. Relative timestamps using `Intl.RelativeTimeFormat` (no external date library)
19. Observation detail modal opens on card click with all fields
20. Detail modal closes with Escape, backdrop click, or X button
21. Stats bar displays total count, severity breakdown, and type breakdown
22. Severity filter dropdown works independently and with type filter
23. Sort options: newest first, oldest first, severity, most revised
24. NULL severity handled gracefully throughout (no badge, sorts last, "All" filter includes it)
25. Dark theme consistency maintained
26. No new npm dependencies
27. All new code has tests
28. Existing tests continue passing
