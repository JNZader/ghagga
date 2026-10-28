# Tasks: Documentation v2.1 Update

All tasks are documentation-only (markdown edits). No code changes. Tasks are grouped by topic sweep to ensure cross-file consistency per the proposal approach.

---

## Phase 1: Memory Sweep (HIGH — 8 files)

Fixes the most widespread issue: incorrect memory availability statements across 8 files + adds SQLite memory documentation.
- [ ] 1.1 Fix memory availability in `README.md` — change memory feature table/section from "No"/"Coming soon" to "Yes (SQLite)" for CLI and Action modes; add storage backend per mode (PostgreSQL for Server, SQLite via `sql.js` for CLI at `~/.config/ghagga/memory.db`, SQLite via `sql.js` + `@actions/cache` for Action)
- [ ] 1.2 Fix memory availability in `docs/cli.md` — update memory section to state CLI uses SQLite via `sql.js` at `~/.config/ghagga/memory.db`; remove any "not available" / "coming soon" / "server-only" language
- [ ] 1.3 Fix memory availability in `docs/github-action.md` — update memory section to state Action uses SQLite via `sql.js` persisted with `@actions/cache`; remove any "not available" / "coming soon" language
- [ ] 1.4 Fix memory availability in `docs/architecture.md` — update memory references to include CLI and Action modes as supported
- [ ] 1.5 Fix memory availability in `docs/memory-system.md` — update storage backends section to list all three: PostgreSQL (tsvector FTS for Server), SQLite (FTS5 for CLI), SQLite (FTS5 + `@actions/cache` for Action); ensure the availability table shows all three modes as supported
- [ ] 1.6 Fix memory availability in `docs/review-pipeline.md` — update any memory availability statements to reflect all three modes
- [ ] 1.7 Fix memory availability in `docs/README.md` — update memory feature description to state availability in all three modes
- [ ] 1.8 Fix memory availability in `apps/cli/README.md` — update memory section to state CLI supports SQLite-based memory at `~/.config/ghagga/memory.db`
- [ ] 1.9 Add SQLite memory backend documentation to `docs/memory-system.md` — document the SQLite storage layer: `sql.js` WASM runtime, FTS5 full-text search, CLI storage path (`~/.config/ghagga/memory.db`), Action persistence via `@actions/cache`, and how SQLite adapter mirrors the PostgreSQL adapter interface

**Spec coverage**: R1 (Memory Availability — 8 files), partial R12 (SQLite architecture)
**Verification**: Grep all 8 files for "not available", "coming soon", "server-only" — expect zero matches. Grep for "SQLite" in all 8 files — expect matches.

---

## Phase 2: CLI Commands Sweep (HIGH — 4 files)

Documents the `ghagga memory` subcommands and missing CLI flags across all CLI reference files.
- [ ] 2.1 Document `ghagga memory` subcommands in `docs/cli.md` — add `memory` as a top-level command (making 5 total: `login`, `logout`, `status`, `review [path]`, `memory`); document all 6 subcommands with syntax and description: `memory list`, `memory search <query>`, `memory show <id>`, `memory delete <id>`, `memory stats`, `memory clear`; note that memory is stored at `~/.config/ghagga/memory.db`
- [ ] 2.2 Document `ghagga memory` subcommands in `apps/cli/README.md` — add `memory` to the commands list alongside `login`, `logout`, `status`, `review`; list all 6 subcommands with usage syntax
- [ ] 2.3 Document `ghagga memory` subcommands in `docs/quick-start.md` — add memory commands to any CLI command reference or quick-start examples
- [ ] 2.4 Document `ghagga memory` subcommands in `README.md` — add or update CLI features section to mention/summarize the memory subcommands
- [ ] 2.5 Add `--plain` flag to global options in `docs/cli.md` — add `--plain` to the global options table with description: "Disable styled TUI output (auto-detected in CI/non-TTY)"; global options should list: `--version` / `-V`, `--plain`, `--help` / `-h`
- [ ] 2.6 Add `--plain` flag to global options in `apps/cli/README.md` — add `--plain` to global options
- [ ] 2.7 Add `--plain` flag to global options in `README.md` — add `--plain` to CLI options where listed
- [ ] 2.8 Add `--plain` flag mention to `docs/tech-stack.md` — reference `--plain` in the context of `@clack/prompts` TUI rendering
- [ ] 2.9 Add review command options to `docs/cli.md` — document `--no-memory` (disable review memory for this run), `--no-semgrep` (disable Semgrep), `--no-trivy` (disable Trivy), `--no-cpd` (disable CPD), `--verbose` / `-v` (show detailed progress) in the review command options section

**Spec coverage**: R2 (CLI Memory Subcommands — 4 files), R3 (`--plain` Flag — 4 files), R4 (Review Options)
**Verification**: Check each file for the `memory` command listing. Grep for `--plain` in all 4 files. Verify review options in `docs/cli.md`.

---

## Phase 3: Metrics & Permissions Sweep (HIGH — 6 files)

Corrects test counts and GitHub App permissions across all affected files.
- [ ] 3.1 Fix test count in `README.md` — update total to 1,728 with per-package breakdown: `packages/db` (118), `packages/core` (526), `apps/cli` (209), `apps/server` (413), `apps/action` (195), `apps/dashboard` (267)
- [ ] 3.2 Fix test count in `docs/tech-stack.md` — update total and per-package breakdown to match 1,728
- [ ] 3.3 Fix test count in `docs/v1-vs-v2.md` — update total and any breakdown to match 1,728
- [ ] 3.4 Grep all docs for any other stale test count references — search for any outdated totals and fix them to 1,728
- [ ] 3.5 Fix GitHub App permissions in `docs/saas-getting-started.md` — update permissions table to: Pull requests (Read & Write), Actions (Write), Secrets (Read & Write), Metadata (Read, automatic)
- [ ] 3.6 Fix GitHub App permissions in `docs/self-hosted.md` — update permissions table to match exactly the same 4 permissions listed in `docs/saas-getting-started.md`
- [ ] 3.7 Add `enable-memory` Action input to `docs/github-action.md` — add to inputs reference table: `enable-memory`, type boolean, default `true`, description "Enable SQLite review memory"
- [ ] 3.8 Add `enable-memory` Action input to `README.md` — add to Action inputs section with same description

**Spec coverage**: R5 (Test Counts — 4 files), R6 (GitHub App Permissions — 2 files), R7 (`enable-memory` Input — 2 files)
**Verification**: Grep for old test count total — expect zero matches. Compare permissions tables in both files — must be identical. Verify `enable-memory` appears in both files.

---

## Phase 4: API, Schema & Tech Stack (HIGH/MEDIUM — 3 files)

Adds missing API endpoints, schema columns, and tech stack entries.
- [ ] 4.1 Add 5 DELETE endpoints to `docs/api-reference.md` — document each with HTTP method, path, description, path parameters, and response status codes:
  - `DELETE /api/memory/observations/:id` — Delete a specific observation
  - `DELETE /api/memory/projects/:project/observations` — Delete all observations for a project
  - `DELETE /api/memory/observations` — Purge all observations (note: destructive)
  - `DELETE /api/memory/sessions/:id` — Delete a specific session
  - `DELETE /api/memory/sessions/empty` — Clean up empty sessions
- [ ] 4.2 Add `severity` field to API response documentation in `docs/api-reference.md` — update observation response schema to include `severity` field where observations are returned
- [ ] 4.3 Add `severity` column to `docs/database-schema.md` — add `severity varchar(10)` to the `memory_observations` table in both PostgreSQL and SQLite schema sections with description "Severity level of the observation"
- [ ] 4.4 Add `@clack/prompts` to `docs/tech-stack.md` — list `@clack/prompts` (^0.9.1) as CLI TUI dependency with purpose description
- [ ] 4.5 Update test counts in `docs/tech-stack.md` — ensure the testing section shows 1,728 total (may already be done in Phase 3 task 3.2, verify and skip if so)

**Spec coverage**: R8 (API DELETE Endpoints), R9 (`severity` Column), R11 (`@clack/prompts`)
**Verification**: Count DELETE endpoints in API reference — must be exactly 5. Check `severity` appears in both DB engine schema sections. Verify `@clack/prompts` listed.

---

## Phase 5: Dashboard & Architecture (MEDIUM — 3 files)

Documents dashboard memory management features and updates architecture docs.
- [ ] 5.1 Document dashboard memory management features in `docs/memory-system.md` — add section describing: 3-tier delete operations (Tier 1: individual observation delete with confirm dialog; Tier 2: clear all observations for a repo with repo-name-typing confirmation; Tier 3: purge all observations with "DELETE ALL" typing + 5-second countdown); session management (delete individual sessions, clean up empty sessions)
- [ ] 5.2 Document dashboard memory UI features in `README.md` — update dashboard features section to mention: severity badges on observations, StatsBar component, ObservationDetailModal, severity and sort filters, memory management pages
- [ ] 5.3 Add `enable-memory` Action input documentation to `README.md` — if not already added in task 3.8, add to the Action section
- [ ] 5.4 Update dashboard pages table in `README.md` — add any new pages/routes including memory management views
- [ ] 5.5 Update monorepo directory tree in `README.md` — verify tree matches current project structure; add any missing packages, apps, or significant directories
- [ ] 5.6 Update `docs/architecture.md` — add SQLite via `sql.js` (WASM) as a storage component alongside PostgreSQL; describe usage: CLI stores at `~/.config/ghagga/memory.db`, Action persists via `@actions/cache`; add SQLite adapter to the adapter/storage table if one exists

**Spec coverage**: R10 (Dashboard Memory Features), R12 (SQLite in Architecture), R13 (Monorepo Tree), R14 (Dashboard Pages Table)
**Verification**: Check `docs/memory-system.md` for 3-tier delete documentation. Check `docs/architecture.md` for SQLite references. Verify monorepo tree against actual `ls` output.

---

## Phase 6: Version & Final Verification (LOW — cross-cutting)

Bumps version references and performs final cross-file consistency checks.
- [ ] 6.1 Update version references in `README.md` — change `2.0.1` to `2.1.0` in version badges, inline mentions, and any current-version contexts (preserve `2.0.1` in changelogs/historical references)
- [ ] 6.2 Update version references in `docs/v1-vs-v2.md` — change `2.0.1` to `2.1.0` where it refers to the current version
- [ ] 6.3 Grep all docs for remaining `2.0.1` references — search `docs/` and root `README.md` for `2.0.1` in current-version contexts; fix any remaining instances
- [ ] 6.4 Cross-file consistency verification — run the following grep checks across all docs (excluding `openspec/` and changelogs):
  - Grep for "not available", "coming soon", "server-only" near "memory" — expect zero matches
  - Grep for the old stale test count total — expect zero matches
  - Grep for `2.0.1` in current-version contexts — expect zero matches
  - Verify memory availability language is consistent across all 8 files from Phase 1
  - Verify test counts are identical across all files from Phase 3
  - Verify permissions tables are identical between `docs/saas-getting-started.md` and `docs/self-hosted.md`
- [ ] 6.5 Docsify rendering check — verify all modified markdown files have valid table formatting, no broken links, and correct heading hierarchy for Docsify rendering

**Spec coverage**: R15 (Version Bumps), CC1 (Cross-File Consistency), CC2 (No New Inaccuracies), CC3 (Docsify Rendering), CC4 (Grep Verification)
**Verification**: All grep checks return zero stale matches. Visual inspection of rendered docs.
