# Proposal: Biome Linting & Formatting

## Intent

Add Biome as the unified linter and formatter for the entire GHAGGA monorepo. The v2.2.0 audit flagged the complete absence of linting/formatting as HIGH priority (item #4). Biome is chosen over ESLint+Prettier because it is a single tool (lint + format), significantly faster (Rust-based), and has excellent TypeScript support out of the box with zero configuration required for basic setups. This change also bundles two trivial audit quick-fixes (items #7 and #8) that are easiest to address as part of the initial lint cleanup.

## Scope

### In Scope

1. **Install Biome** — Add `@biomejs/biome` as a root dev dependency (shared across all workspace packages).
2. **Root configuration** — Create `biome.json` at the repository root with recommended rules, formatter settings (2-space indent, 100-char line width, single quotes), and ignore patterns for generated/build output directories.
3. **Monorepo scripts** — Add `lint` and `lint:fix` scripts to the root `package.json` that invoke `biome check` across the entire workspace.
4. **Turbo pipeline** — Add `lint` task to `turbo.json` so it integrates with the existing Turborepo pipeline.
5. **CI integration** — Add a `lint` step to `.github/workflows/ci.yml` that runs before tests (fail-fast on style issues).
6. **Initial codebase cleanup** — Run `biome check --write` to auto-fix what's possible, then manually fix remaining issues so the entire codebase passes lint cleanly.
7. **Audit item #7** — Replace `console.error` with `pino` logger in `apps/server/src/routes/oauth.ts` (lines 207-208, 221).
8. **Audit item #8** — Move hardcoded OAuth GitHub Client ID to environment variable (`GITHUB_CLIENT_ID` in server, `VITE_GITHUB_CLIENT_ID` in dashboard).

### Out of Scope

- Pre-commit hooks (e.g., Husky + lint-staged) — future DX improvement, not needed for initial setup
- Per-package `biome.json` overrides — start simple with a single root config
- Editor integration docs — developers can install the Biome VS Code extension independently
- Migration from any existing ESLint/Prettier config — there is none to migrate from

## Approach

**Root-level Biome configuration** — A single `biome.json` at the repo root applies to all packages and apps. Biome's monorepo support works well with a root config because it automatically finds files in subdirectories.

**Rule philosophy:**
- Enable Biome's `recommended` ruleset (covers correctness + style)
- Set `noUnusedVariables`, `noUnusedImports`, and `noExplicitAny` to `warn` level (not error) to allow gradual cleanup without blocking CI
- Formatter: 2-space indent, 100-char line width, single quotes (consistent with existing code style observed across the codebase)

**Ignore patterns:** `node_modules`, `dist`, `coverage`, `.turbo`, `.next`, `pnpm-lock.yaml`

**CI strategy:** Add a `lint` job to the existing CI workflow that runs `pnpm lint` after dependency install. This runs in parallel with typecheck/build (not dependent on them). Lint failure blocks merge.

**Audit quick fixes** are bundled here because they're trivial changes that will surface as lint warnings anyway (console.error usage, hardcoded values).

## Affected Areas

| Area                              | Impact   | Description                                                                                     |
| --------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `biome.json`                      | New      | Root Biome configuration file                                                                   |
| `package.json` (root)             | Modified | Add `@biomejs/biome` dev dependency, add `lint`/`lint:fix` scripts                              |
| `turbo.json`                      | Modified | Update `lint` task configuration (already exists but currently has no per-package lint scripts) |
| `.github/workflows/ci.yml`        | Modified | Add lint step to CI pipeline                                                                    |
| `apps/server/src/routes/oauth.ts` | Modified | Replace `console.error` with logger (audit #7)                                                  |
| `apps/server/src/**/*.ts`         | Modified | Move OAuth Client ID to env var (audit #8)                                                      |
| `apps/dashboard/src/**/*.ts`      | Modified | Move OAuth Client ID to env var (audit #8)                                                      |
| `**/*.ts`, `**/*.tsx`             | Modified | Auto-fix formatting and lint issues across all packages                                         |

## Risks

| Risk                                                           | Likelihood | Mitigation                                                                                                                                            |
| -------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large formatting diff makes git history harder to read         | Medium     | Accept the one-time churn. After initial commit, all future diffs will be clean. Consider a `.git-blame-ignore-revs` entry for the formatting commit. |
| Biome rules conflict with existing code patterns               | Low        | Start with `recommended` rules and set contentious rules to `warn`. Adjust config iteratively.                                                        |
| CI lint step increases CI time                                 | Low        | Biome is extremely fast (~100ms for a project this size). Negligible impact.                                                                          |
| Audit quick fixes (oauth.ts, env vars) introduce bugs          | Low        | Both are trivial changes. Existing tests cover OAuth flow. Manual verification of env var fallback.                                                   |
| Dashboard breaks if `VITE_GITHUB_CLIENT_ID` env var is not set | Medium     | Use the current hardcoded value as the fallback default, so behavior is unchanged unless explicitly overridden.                                       |

## Rollback Plan

1. Delete `biome.json` from root
2. Remove `@biomejs/biome` from root `package.json` dev dependencies
3. Revert `lint`/`lint:fix` script changes in root `package.json`
4. Revert turbo.json lint task changes
5. Revert CI workflow lint step
6. Run `pnpm install` to update lockfile
7. The audit quick fixes (logger, env var) are independent improvements that should be kept even if Biome is reverted

## Dependencies

- `@biomejs/biome` — npm package (Rust-based linter/formatter, installed via npm)
- No other new dependencies required
- Existing `pino` logger in `apps/server/` is already a dependency (used for audit item #7 fix)

## Success Criteria

- [ ] `biome.json` exists at project root with recommended rules and formatter config
- [ ] `pnpm lint` runs Biome check across all workspace packages and exits 0
- [ ] `pnpm lint:fix` auto-fixes formatting and auto-fixable lint issues
- [ ] CI workflow includes lint step that runs before tests
- [ ] CI lint step failure blocks PR merge
- [ ] No `console.error` calls remain in `apps/server/src/routes/oauth.ts`
- [ ] OAuth Client ID is read from `GITHUB_CLIENT_ID` env var in server (with fallback)
- [ ] OAuth Client ID is read from `VITE_GITHUB_CLIENT_ID` env var in dashboard (with fallback)
- [ ] All existing tests pass after changes (`pnpm test`)
- [ ] No regressions in OAuth flow (login still works)
