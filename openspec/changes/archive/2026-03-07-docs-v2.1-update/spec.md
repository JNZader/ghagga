# Delta for Documentation — docs-v2.1-update

This delta spec addresses 52 documentation issues (28 HIGH, 16 MEDIUM, 8 LOW) discovered after 15 major changes to GHAGGA. All requirements are documentation-only — no application code, database, or API changes.

Changes are grouped by topic (not by file) to ensure cross-file consistency.

---

## MODIFIED Requirements

### Requirement: Memory Availability Statements (HIGH — 8 files)

All documentation files that describe memory system availability MUST correctly state that review memory is available in **all three** distribution modes:
- **Server (SaaS)**: PostgreSQL with tsvector full-text search
- **CLI**: SQLite via `sql.js` (WASM), stored at `~/.config/ghagga/memory.db`, uses FTS5
- **Action**: SQLite via `sql.js` (WASM), persisted via `@actions/cache`

(Previously: Multiple files incorrectly stated that memory was unavailable or "coming soon" for CLI and/or Action modes.)

Files that MUST be updated:
1. `README.md`
2. `docs/cli.md`
3. `docs/github-action.md`
4. `docs/architecture.md`
5. `docs/memory-system.md`
6. `docs/review-pipeline.md`
7. `docs/README.md`
8. `apps/cli/README.md`

Each file MUST use consistent language describing the storage backend per mode. No file MAY state that memory is "not available", "coming soon", or "server-only" for CLI or Action.

#### Scenario: User reads memory availability in README

- GIVEN a user reading the root `README.md`
- WHEN the user looks for memory system information
- THEN the documentation states memory is available in all three modes (Server, CLI, Action)
- AND it identifies the storage backend for each (PostgreSQL, SQLite, SQLite+cache)

#### Scenario: User reads memory availability in CLI docs

- GIVEN a user reading `docs/cli.md`
- WHEN the user looks for memory system information
- THEN the documentation states CLI uses SQLite via `sql.js` at `~/.config/ghagga/memory.db`
- AND no text states memory is unavailable or server-only

#### Scenario: User reads memory availability in Action docs

- GIVEN a user reading `docs/github-action.md`
- WHEN the user looks for memory system information
- THEN the documentation states the Action uses SQLite via `sql.js` persisted with `@actions/cache`
- AND no text states memory is unavailable or server-only

#### Scenario: User reads memory-system.md for architecture details

- GIVEN a user reading `docs/memory-system.md`
- WHEN the user reviews storage backend descriptions
- THEN the document lists all three backends (PostgreSQL, SQLite CLI, SQLite Action)
- AND describes FTS5 for SQLite and tsvector for PostgreSQL

#### Scenario: Cross-file consistency of memory statements

- GIVEN all 8 files listed above
- WHEN comparing memory availability descriptions across all files
- THEN no file contradicts another regarding which modes support memory
- AND all files agree on the storage backend per mode

---

### Requirement: CLI Memory Subcommands Documentation (HIGH — 4 files)

All files that document CLI commands MUST include the `memory` command with its 6 subcommands:
- `ghagga memory list` — List stored observations
- `ghagga memory search <query>` — Search observations by text
- `ghagga memory show <id>` — Show a specific observation
- `ghagga memory delete <id>` — Delete a specific observation
- `ghagga memory stats` — Show memory statistics
- `ghagga memory clear` — Clear all stored observations

(Previously: The `memory` command and its subcommands were not documented in CLI reference files.)

Files that MUST be updated:
1. `README.md`
2. `docs/cli.md`
3. `docs/quick-start.md`
4. `apps/cli/README.md`

The CLI MUST be documented as having 5 top-level commands: `login`, `logout`, `status`, `review [path]`, `memory`.

#### Scenario: User finds memory subcommands in CLI docs

- GIVEN a user reading `docs/cli.md`
- WHEN the user looks at the commands reference
- THEN `memory` is listed as a top-level command
- AND all 6 subcommands are documented with their syntax and description

#### Scenario: User finds memory subcommands in CLI README

- GIVEN a user reading `apps/cli/README.md`
- WHEN the user looks at the commands section
- THEN `memory` is listed alongside `login`, `logout`, `status`, and `review`
- AND the subcommands are listed with usage syntax

#### Scenario: User finds memory commands in project README

- GIVEN a user reading the root `README.md`
- WHEN the user looks at CLI feature descriptions
- THEN the memory subcommands are mentioned or summarized

#### Scenario: User searches for how to manage CLI memory

- GIVEN a user wanting to inspect or clear local review memory
- WHEN the user reads the CLI memory documentation
- THEN the user finds `ghagga memory list`, `ghagga memory search <query>`, `ghagga memory show <id>`, `ghagga memory delete <id>`, `ghagga memory stats`, and `ghagga memory clear`
- AND the documentation explains that memory is stored at `~/.config/ghagga/memory.db`

---

### Requirement: `--plain` Flag Documentation (HIGH — 4 files)

All files that document CLI global options MUST include the `--plain` flag:

```
--plain    Disable styled TUI output (auto-detected in CI/non-TTY)
```

(Previously: The `--plain` flag was not documented.)

Files that MUST be updated:
1. `README.md`
2. `docs/cli.md`
3. `docs/tech-stack.md`
4. `apps/cli/README.md`

The global options MUST list: `--version` / `-V`, `--plain`, `--help` / `-h`.

#### Scenario: User finds --plain in CLI docs

- GIVEN a user reading `docs/cli.md`
- WHEN the user looks at global options
- THEN `--plain` is listed with its description
- AND the docs note it is auto-detected in CI/non-TTY environments

#### Scenario: CI user discovers plain mode

- GIVEN a user running the CLI in a CI pipeline
- WHEN the user reads about `--plain`
- THEN the documentation explains that `--plain` is auto-enabled when no TTY is detected
- AND the user can also pass `--plain` explicitly to force plain output

---

### Requirement: Review Command Options Documentation (HIGH)

The `docs/cli.md` review command section MUST document the following options that are currently missing:
- `--no-memory` — Disable review memory for this run
- `--no-semgrep` — Disable Semgrep static analysis
- `--no-trivy` — Disable Trivy security scanner
- `--no-cpd` — Disable CPD copy-paste detection
- `--verbose` / `-v` — Show detailed progress output

(Previously: These options were not documented.)

#### Scenario: User wants to skip memory for a review

- GIVEN a user reading `docs/cli.md`
- WHEN the user looks at review command options
- THEN `--no-memory` is documented with its effect (disables review memory for this run)

#### Scenario: User wants to disable specific analyzers

- GIVEN a user reading `docs/cli.md`
- WHEN the user looks at review command options
- THEN `--no-semgrep`, `--no-trivy`, and `--no-cpd` are each documented
- AND the documentation explains each disables the respective analyzer

#### Scenario: User wants verbose output

- GIVEN a user reading `docs/cli.md`
- WHEN the user looks at review command options
- THEN `--verbose` / `-v` is documented with its effect

---

### Requirement: Test Counts (HIGH — 4 files)

All files that display test counts MUST show the correct total of **1,728 tests** with the following per-package breakdown:

| Package          | Tests |
| ---------------- | ----- |
| `packages/db`    | 118   |
| `packages/core`  | 526   |
| `apps/cli`       | 209   |
| `apps/server`    | 413   |
| `apps/action`    | 195   |
| `apps/dashboard` | 267   |

(Previously: Various files showed outdated test counts.)

Files that MUST be updated:
1. `README.md`
2. `docs/tech-stack.md`
3. `docs/v1-vs-v2.md`
4. Any other file displaying test count metrics

#### Scenario: User reads test counts in README

- GIVEN a user reading the root `README.md`
- WHEN the user looks at test metrics
- THEN the total shows 1,728 tests
- AND the per-package breakdown is accurate

#### Scenario: User reads test counts in tech-stack

- GIVEN a user reading `docs/tech-stack.md`
- WHEN the user looks at test metrics
- THEN the total and breakdown match the values above

#### Scenario: Cross-file test count consistency

- GIVEN all files that mention test counts
- WHEN comparing the numbers across files
- THEN all files show the same total (1,728) and the same per-package breakdown
- AND no file shows a stale or different total

---

### Requirement: GitHub App Permissions (HIGH — 2 files)

All files that document GitHub App required permissions MUST list the correct current permissions:

| Permission    | Access Level     |
| ------------- | ---------------- |
| Pull requests | Read & Write     |
| Actions       | Write            |
| Secrets       | Read & Write     |
| Metadata      | Read (automatic) |

(Previously: Permissions listed were incorrect or outdated.)

Files that MUST be updated:
1. `docs/saas-getting-started.md`
2. `docs/self-hosted.md`

#### Scenario: User checks App permissions in SaaS guide

- GIVEN a user reading `docs/saas-getting-started.md`
- WHEN the user looks at GitHub App permissions
- THEN the 4 permissions listed above are shown correctly
- AND no additional or missing permissions are listed

#### Scenario: User checks App permissions in self-hosted guide

- GIVEN a user reading `docs/self-hosted.md`
- WHEN the user looks at GitHub App permissions
- THEN the same 4 permissions are listed, matching the SaaS guide exactly

#### Scenario: Permissions are consistent across files

- GIVEN `docs/saas-getting-started.md` and `docs/self-hosted.md`
- WHEN comparing the permissions tables
- THEN both files list identical permissions with identical access levels

---

### Requirement: `enable-memory` Action Input (HIGH — 2 files)

All files that document GitHub Action inputs MUST include the `enable-memory` input:

```
enable-memory    Enable SQLite review memory (default: true)
```

(Previously: The `enable-memory` input was not documented.)

Files that MUST be updated:
1. `README.md` (Action inputs section)
2. `docs/github-action.md` (inputs reference table)

#### Scenario: User finds enable-memory in Action inputs

- GIVEN a user reading `docs/github-action.md`
- WHEN the user looks at the inputs reference table
- THEN `enable-memory` is listed with type (boolean), default (`true`), and description

#### Scenario: User wants to disable memory in Action

- GIVEN a user who wants to run the Action without memory
- WHEN the user reads the `enable-memory` documentation
- THEN the user understands they can set `enable-memory: false` to disable SQLite memory
- AND the documentation explains the default is `true` (memory enabled)

---

## ADDED Requirements

### Requirement: API DELETE Endpoints Documentation (HIGH)

The `docs/api-reference.md` file MUST document the following 5 DELETE endpoints:
1. `DELETE /api/memory/observations/:id` — Delete a specific observation
2. `DELETE /api/memory/projects/:project/observations` — Delete all observations for a project
3. `DELETE /api/memory/observations` — Purge all observations
4. `DELETE /api/memory/sessions/:id` — Delete a specific session
5. `DELETE /api/memory/sessions/empty` — Clean up empty sessions

Each endpoint MUST include: HTTP method, path, description, path parameters (if any), and expected response status codes.

(Previously: These endpoints existed in the codebase but were not documented in the API reference.)

#### Scenario: User looks up observation deletion endpoint

- GIVEN a developer reading `docs/api-reference.md`
- WHEN the user searches for how to delete an observation
- THEN `DELETE /api/memory/observations/:id` is documented
- AND the `:id` path parameter is described
- AND the expected success response (e.g., 200 or 204) is listed

#### Scenario: User looks up project observation purge

- GIVEN a developer reading `docs/api-reference.md`
- WHEN the user searches for how to delete all observations for a project
- THEN `DELETE /api/memory/projects/:project/observations` is documented
- AND the `:project` path parameter is described

#### Scenario: User looks up bulk purge endpoint

- GIVEN a developer reading `docs/api-reference.md`
- WHEN the user searches for how to purge all observations
- THEN `DELETE /api/memory/observations` is documented
- AND the destructive nature of this operation is noted

#### Scenario: User looks up session cleanup endpoints

- GIVEN a developer reading `docs/api-reference.md`
- WHEN the user searches for session management endpoints
- THEN both `DELETE /api/memory/sessions/:id` and `DELETE /api/memory/sessions/empty` are documented

#### Scenario: All 5 DELETE endpoints are present

- GIVEN the updated `docs/api-reference.md`
- WHEN counting DELETE endpoints in the memory section
- THEN exactly 5 DELETE endpoints are documented as listed above

---

### Requirement: `severity` Column in Schema Documentation (HIGH)

The `docs/database-schema.md` file MUST document the `severity` column added to the `memory_observations` table:

```
severity    varchar(10)    Severity level of the observation
```

This column MUST be shown in the schema for both PostgreSQL and SQLite representations of the `memory_observations` table.

(Previously: The `severity` column existed in the codebase schema but was not documented.)

#### Scenario: User reads memory_observations schema

- GIVEN a developer reading `docs/database-schema.md`
- WHEN the user looks at the `memory_observations` table columns
- THEN `severity` is listed as `varchar(10)`
- AND its purpose is described

#### Scenario: Schema matches both database engines

- GIVEN the `memory_observations` table documentation
- WHEN the user checks column listings
- THEN the `severity` column appears in both the PostgreSQL and SQLite schema sections

---

### Requirement: Dashboard Memory Management Features (MEDIUM)

Documentation MUST describe the dashboard's memory management capabilities:

**Delete Operations (3 tiers):**
- Tier 1: Delete individual observations — simple confirm dialog
- Tier 2: Clear all observations for a repository — requires typing the repo name to confirm
- Tier 3: Purge all observations — requires typing "DELETE ALL" with a 5-second countdown

**Session Management:**
- Delete individual sessions
- Clean up empty sessions (sessions with no observations)

**UI Features:**
- Severity badges on observations
- StatsBar component showing memory statistics
- ObservationDetailModal for viewing observation details
- Severity and sort filters for observation lists

(Previously: Dashboard memory management features were not documented.)

Files that SHOULD be updated:
- `README.md` (dashboard features section)
- `docs/memory-system.md` (management section)

#### Scenario: User finds dashboard delete tiers

- GIVEN a user reading documentation about dashboard memory management
- WHEN the user looks for how to delete observations
- THEN 3 tiers of deletion are described with their confirmation requirements
- AND Tier 3 (purge all) is clearly marked as destructive with the "DELETE ALL" confirmation and 5-second countdown

#### Scenario: User finds session management features

- GIVEN a user reading documentation about dashboard memory management
- WHEN the user looks for session cleanup
- THEN the ability to delete individual sessions and clean up empty sessions is documented

#### Scenario: User finds observation UI features

- GIVEN a user reading documentation about the dashboard
- WHEN the user looks for observation display features
- THEN severity badges, filtering, and the detail modal are documented

---

### Requirement: `@clack/prompts` in Tech Stack (MEDIUM)

The `docs/tech-stack.md` file MUST list `@clack/prompts` (^0.9.1) as a dependency used for CLI TUI (terminal user interface) rendering.

(Previously: `@clack/prompts` was in use but not listed in the tech stack documentation.)

#### Scenario: User reads tech stack for CLI dependencies

- GIVEN a developer reading `docs/tech-stack.md`
- WHEN the user looks at CLI-related dependencies
- THEN `@clack/prompts` is listed with its version (^0.9.1) and purpose (CLI TUI)

---

### Requirement: SQLite in Architecture Documentation (MEDIUM)

The `docs/architecture.md` file MUST include SQLite (via `sql.js` WASM) as a storage component used by CLI and Action modes for review memory.

(Previously: Architecture docs only referenced PostgreSQL for storage.)

#### Scenario: User reads architecture for storage components

- GIVEN a developer reading `docs/architecture.md`
- WHEN the user reviews the storage/database architecture section
- THEN SQLite via `sql.js` (WASM) is listed alongside PostgreSQL
- AND its usage contexts (CLI at `~/.config/ghagga/memory.db`, Action via `@actions/cache`) are described

---

### Requirement: Updated Monorepo Tree (MEDIUM)

The `README.md` monorepo directory tree MUST reflect the current project structure. Any new packages, apps, or significant directories added since the tree was last updated MUST be included.

(Previously: Monorepo tree was outdated and did not reflect current structure.)

#### Scenario: User reads monorepo tree in README

- GIVEN a user reading the root `README.md`
- WHEN the user looks at the project structure tree
- THEN the tree matches the actual directory layout of the repository
- AND no significant directories are missing or incorrectly listed

---

### Requirement: Updated Dashboard Pages Table (MEDIUM)

The `README.md` dashboard section MUST include an accurate table of dashboard pages/routes including any new pages added for memory management.

(Previously: Dashboard pages table was outdated.)

#### Scenario: User reads dashboard pages in README

- GIVEN a user reading the root `README.md`
- WHEN the user looks at the dashboard pages table
- THEN all current dashboard pages are listed
- AND memory management pages/views are included

---

## MODIFIED Requirements (LOW)

### Requirement: Version Number References (LOW — multiple files)

All version references MUST be updated from `2.0.1` to `2.1.0` where they refer to the current release version.

(Previously: Various files referenced version 2.0.1.)

This applies to version badges, changelog references, and inline version mentions.

#### Scenario: No stale 2.0.1 references remain

- GIVEN all documentation files in the repository
- WHEN searching for version string `2.0.1`
- THEN zero matches are found in current-version contexts (changelogs and historical references MAY retain old version numbers)

#### Scenario: Current version reads 2.1.0

- GIVEN all files that display the current GHAGGA version
- WHEN reading the version number
- THEN the version is `2.1.0`

---

## Cross-Cutting Concerns

### CC1: Cross-File Consistency

When the same fact (memory availability, test count, permissions, version number) appears in multiple files, all files MUST state it identically. Topic-based batching during implementation MUST be used to prevent introducing inconsistencies.

#### Scenario: Memory availability is consistent everywhere

- GIVEN all 8 files that mention memory availability
- WHEN comparing the core claim (memory available in Server, CLI, Action)
- THEN all 8 files agree and none contradicts another

#### Scenario: Test counts are consistent everywhere

- GIVEN all files that mention test counts
- WHEN comparing the total and per-package numbers
- THEN all files show 1,728 total with matching breakdowns

### CC2: No New Inaccuracies

Every factual claim written or modified during this change MUST be verified against the actual source code before committing. The implementation MUST NOT introduce new incorrect statements while fixing old ones.

#### Scenario: Modified content matches source code

- GIVEN any documentation sentence modified during this change
- WHEN cross-referencing the claim against the relevant source file
- THEN the documentation accurately reflects the source code behavior

### CC3: Docsify Rendering

All modified markdown files MUST render correctly in the Docsify documentation site. No changes MAY break existing page rendering, table formatting, or link resolution.

#### Scenario: Docsify renders all modified files

- GIVEN all markdown files modified during this change
- WHEN loaded via the Docsify documentation site
- THEN all headings, tables, code blocks, and links render correctly
- AND no visual regressions are introduced

### CC4: Grep Verification

After implementation, the following grep checks MUST return zero matches (excluding the openspec change folder itself and changelogs):
1. Any file claiming memory is "not available" or "coming soon" for CLI or Action
2. Any outdated test count (the previous stale total)
3. Version string `2.0.1` in current-version contexts

#### Scenario: Grep verification passes

- GIVEN the completed implementation
- WHEN running grep for known stale patterns across documentation files
- THEN zero matches are found for each pattern listed above

---

## Acceptance Criteria Summary

| ID  | Priority | Requirement                      | Key Acceptance Criteria                                                                |
| --- | -------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| R1  | HIGH     | Memory Availability (8 files)    | All 8 files state memory is available in Server, CLI, and Action with correct backends |
| R2  | HIGH     | CLI Memory Subcommands (4 files) | `memory` command with 6 subcommands documented in 4 files                              |
| R3  | HIGH     | `--plain` Flag (4 files)         | `--plain` global option documented in 4 files                                          |
| R4  | HIGH     | Review Options                   | `--no-memory`, `--no-semgrep`, `--no-trivy`, `--no-cpd`, `--verbose` documented        |
| R5  | HIGH     | Test Counts (4 files)            | 1,728 total with correct per-package breakdown in all 4 files                          |
| R6  | HIGH     | GitHub App Permissions (2 files) | Correct 4-permission list in both files, consistent                                    |
| R7  | HIGH     | `enable-memory` Input (2 files)  | Input documented with type, default, and description                                   |
| R8  | HIGH     | API DELETE Endpoints             | 5 DELETE endpoints documented in `docs/api-reference.md`                               |
| R9  | HIGH     | `severity` Column                | Column documented in `docs/database-schema.md` for both DB engines                     |
| R10 | MEDIUM   | Dashboard Memory Features        | 3-tier delete, session mgmt, UI features documented                                    |
| R11 | MEDIUM   | `@clack/prompts` Tech Stack      | Listed in `docs/tech-stack.md` with version and purpose                                |
| R12 | MEDIUM   | SQLite in Architecture           | SQLite/sql.js documented as storage component in `docs/architecture.md`                |
| R13 | MEDIUM   | Monorepo Tree                    | `README.md` tree matches actual directory structure                                    |
| R14 | MEDIUM   | Dashboard Pages Table            | `README.md` dashboard pages table is current                                           |
| R15 | LOW      | Version Bumps (2.0.1 -> 2.1.0)   | Zero stale `2.0.1` references in current-version contexts                              |
| CC1 | —        | Cross-File Consistency           | Same fact stated identically across all files                                          |
| CC2 | —        | No New Inaccuracies              | Every modified claim verified against source code                                      |
| CC3 | —        | Docsify Rendering                | All modified files render correctly                                                    |
| CC4 | —        | Grep Verification                | Zero matches for stale patterns                                                        |
