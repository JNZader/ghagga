# Proposal: Documentation v2.1 Update

## Intent

After 15 major changes to GHAGGA, the documentation is significantly out of sync with the actual codebase. An audit identified 52 issues (28 HIGH, 16 MEDIUM, 8 LOW) across 14+ files. Users relying on docs encounter wrong feature availability claims, missing CLI commands, incorrect permissions, and stale metrics. This erodes trust and increases support burden. This change brings all documentation in line with the v2.1 state of the codebase.

## Scope

### In Scope

- Fix 28 HIGH priority issues: memory availability corrections (8 files), missing CLI memory subcommands (4 files), missing `--plain` flag (4 files), wrong test counts (4 files), wrong GitHub App permissions (2 files), missing `enable-memory` Action input (2 files), missing DELETE endpoints in API reference, missing `severity` column in schema docs, missing `--no-memory` flag
- Fix 16 MEDIUM priority issues: undocumented dashboard memory management features, missing `@clack/prompts` in tech stack, missing SQLite in architecture docs, outdated monorepo tree, outdated dashboard pages table
- Fix 8 LOW priority issues: version number bumps (2.0.1 -> 2.1.0)
- Ensure cross-file consistency (same feature described identically everywhere)

### Out of Scope

- Code changes of any kind
- New documentation pages or restructuring
- Landing page updates (`landing/`)
- Docsify configuration changes (`docs/index.html`, `docs/_sidebar.md` structure)
- Automated doc generation tooling

## Approach

Batch updates grouped by topic rather than by file, to ensure consistency across all files that reference the same feature:
1. **Memory availability sweep** — Update all 8 files that incorrectly state memory is unavailable in CLI/Action. Add SQLite-based memory documentation where missing.
2. **CLI commands sweep** — Add `ghagga memory` subcommands (list, search, show, delete, stats, clear), `--plain` flag, and `--no-memory` flag across CLI docs.
3. **Metrics and permissions sweep** — Correct test counts to 1,728 (with per-package breakdown), fix GitHub App permissions, add `enable-memory` Action input.
4. **API and schema sweep** — Add 5 missing DELETE endpoints to `docs/api-reference.md`, add `severity` column to `docs/database-schema.md`.
5. **Dashboard and architecture sweep** — Document dashboard memory management features, add `@clack/prompts` to tech stack, add SQLite to architecture, update monorepo tree and dashboard pages table.
6. **Version bump sweep** — Update version references from 2.0.1 to 2.1.0.

Design phase is skipped since this is a docs-only change with no architectural decisions.

## Affected Areas

| Area                           | Impact   | Description                                                                                                                                    |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                    | Modified | Memory availability, CLI memory subcommands, `--plain` flag, test counts, `enable-memory` input, monorepo tree, dashboard pages, version bumps |
| `docs/cli.md`                  | Modified | Memory availability, memory subcommands, `--plain` flag, `--no-memory` flag                                                                    |
| `docs/github-action.md`        | Modified | Memory availability, `enable-memory` input                                                                                                     |
| `docs/architecture.md`         | Modified | Memory availability, SQLite in architecture                                                                                                    |
| `docs/memory-system.md`        | Modified | Memory availability for CLI/Action                                                                                                             |
| `docs/review-pipeline.md`      | Modified | Memory availability                                                                                                                            |
| `docs/README.md`               | Modified | Memory availability                                                                                                                            |
| `docs/quick-start.md`          | Modified | CLI memory subcommands                                                                                                                         |
| `docs/tech-stack.md`           | Modified | `--plain` flag, test counts, `@clack/prompts`                                                                                                  |
| `docs/v1-vs-v2.md`             | Modified | Test counts                                                                                                                                    |
| `docs/saas-getting-started.md` | Modified | GitHub App permissions                                                                                                                         |
| `docs/self-hosted.md`          | Modified | GitHub App permissions                                                                                                                         |
| `docs/api-reference.md`        | Modified | 5 missing DELETE endpoints                                                                                                                     |
| `docs/database-schema.md`      | Modified | Missing `severity` column                                                                                                                      |
| `apps/cli/README.md`           | Modified | Memory availability, memory subcommands, `--plain` flag                                                                                        |

## Risks

| Risk                                                     | Likelihood | Mitigation                                                            |
| -------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| Introducing new inaccuracies while fixing old ones       | Medium     | Cross-reference every claim against actual source code before writing |
| Missing a file that references a changed feature         | Low        | Use grep/search across entire repo for each term being updated        |
| Breaking docsify rendering with bad markdown             | Low        | Preview docsify locally after changes                                 |
| Inconsistent language across files after partial updates | Medium     | Topic-based batching (not file-based) ensures same wording everywhere |

## Rollback Plan

All changes are documentation-only (markdown files). Rollback is a simple `git revert` of the merge commit. No database migrations, no config changes, no runtime impact.

## Dependencies

- Access to actual source code to verify current feature state (already available in repo)
- No external dependencies

## Success Criteria

- [ ] All 28 HIGH priority issues resolved
- [ ] All 16 MEDIUM priority issues resolved
- [ ] All 8 LOW priority issues resolved
- [ ] Every file that mentions memory availability correctly states SQLite-based support for CLI and Action
- [ ] `ghagga memory` subcommands documented in all relevant files
- [ ] `--plain` and `--no-memory` flags documented in all relevant files
- [ ] Test count shows 1,728 with correct per-package breakdown everywhere it appears
- [ ] GitHub App permissions list is correct in both affected files
- [ ] API reference includes all DELETE endpoints
- [ ] Database schema includes `severity` column
- [ ] No cross-file inconsistencies introduced
- [ ] Docsify site renders correctly with all changes
