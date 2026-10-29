# Proposal: Test Coverage Audit — Close Coverage Gaps Before v2.1.0

## Intent

GHAGGA has ~1,321 passing tests across its 6 packages, but an exploration identified ~91-147 missing tests across ~30 source files. These gaps concentrate in critical paths: the CLI's formatting and OAuth layers, the provider factory, the dashboard's API hooks, the Action's entry point, and the server's Postgres memory adapter.

Shipping v2.1.0 with these gaps means regressions in formatting, authentication, or provider routing could reach users undetected. The recent `cli-tui` change explicitly deferred TUI testing to this change. This is purely additive test code — no source refactoring, no architecture decisions — just closing the gaps while existing patterns and conventions are fresh.

## Scope

### In Scope

- **HIGH priority tests (~50-65 new tests)**: Tests for `format.ts`, provider factory, `tui.ts`, `oauth.ts`, `postgres.ts` memory methods, dashboard API hooks, and Action `run()` lifecycle
- **MEDIUM priority tests (~25-40 new tests)**: Tests for `theme.ts`, CLI commands (`login`, `logout`, `status`), dashboard OAuth/context/pages, `ProviderEntry.tsx`, and `db/client.ts`
- **LOW priority tests (~8-15 new tests)**: Tests for constants (`DEFAULT_SETTINGS`, `DEFAULT_MODELS`, `DEFAULT_REPO_SETTINGS`), config singletons (`inngest/client.ts`, `logger.ts`), simple utilities (`cn.ts`), and dashboard presentational components
- **Minimal testability refactoring**: Guard `run()` in `apps/action/src/index.ts` so it doesn't execute at import time (e.g., `if (require.main === module)` or `if (!process.env.VITEST)` guard) — the only source-code change in this proposal
- **Follow existing test patterns per package**: explicit vitest imports, `vi.mock()` / `vi.hoisted()`, React Testing Library + `vi.stubGlobal('fetch')` for dashboard, `@ai-sdk/*` mocking for core

### Out of Scope

- **Coverage threshold configuration** (e.g., `coverageThreshold` in vitest config, CI enforcement gates) — separate future change
- **Source code refactoring for testability** beyond the Action `run()` guard — if a file is hard to test, write what we can and document the gap
- **E2E / integration tests** — this change is unit tests only; Playwright tests are a separate concern
- **New test infrastructure** (custom test runners, shared fixtures library, test data factories beyond what already exists) — use existing patterns
- **Performance / benchmark tests** — out of scope for coverage audit

## Approach

### Phased Execution

The work is split into four phases ordered by value-per-effort and dependency minimization:

**Phase 1 — Pure Functions (quick wins, no mocks)**
Target: `format.ts` (12-15 tests), `theme.ts` (4-6 tests), `types.ts` constants (2-3 tests), `schema.ts` defaults (1-2 tests), `cn.ts` (1-2 tests), `tools/types.ts` constants (1-2 tests).
These are deterministic functions with zero dependencies — fast to write, fast to run, and they establish the test file scaffolding for later phases.

**Phase 2 — Critical Path Coverage (mocking required)**
Target: `providers/index.ts` (8-10 tests), `tui.ts` (10-14 tests), `cli/oauth.ts` (8-12 tests), `postgres.ts` (6-8 tests), `dashboard/api.ts` (10-15 tests), `action/index.ts` (4-6 tests).
These are the highest-risk gaps. Provider routing, OAuth device flow, memory persistence, and the Action entry point are all paths that, if broken, affect every user. Requires `vi.mock()` for external dependencies, fake timers for polling, and React Testing Library `renderHook` for dashboard hooks.

**Phase 3 — Dashboard Hooks & Components**
Target: `dashboard/oauth.ts` (4-6 tests), `repo-context.tsx` (3-4 tests), `Dashboard.tsx` (2-3 tests), `Reviews.tsx` (3-4 tests), `Settings.tsx` (4-6 tests), `Memory.tsx` (2-3 tests), `ProviderEntry.tsx` (3-4 tests), simple components (6-10 tests).
Dashboard components use the established `vi.stubGlobal('fetch')` + custom `QueryClient` wrapper pattern. `Settings.tsx` (459 lines) is the most complex — focus on happy path and validation states rather than exhaustive interaction testing. Recharts components get smoke-test renders only (jsdom flakiness risk).

**Phase 4 — CLI Commands & Low-Priority Items**
Target: `login.ts` (3-5 tests), `logout.ts` (2-3 tests), `status.ts` (3-4 tests), `inngest/client.ts` (1-2 tests), `logger.ts` (2-3 tests), `db/client.ts` (2-3 tests).
CLI commands already have a well-established mock pattern (mock `ghagga-core`, `node:fs`, config modules; capture console output). Low-priority config/logger tests are straightforward constant assertions.

### Test Conventions (follow existing patterns)

- **All packages**: Explicit `import { describe, it, expect, vi } from 'vitest'` — no globals
- **CLI**: `vi.mock('ghagga-core')`, `vi.mock('node:fs')`, capture `console.log` via spy
- **Server**: `vi.mock('ghagga-db')`, thin adapter assertions
- **Dashboard**: React Testing Library + `vi.stubGlobal('fetch', ...)` + `createTestQueryClient()` wrapper
- **Core**: `vi.mock('@ai-sdk/anthropic')` etc., test data factories
- **Mocking**: `vi.hoisted()` for shared mock declarations, `vi.mock()` at module level

### The One Source Change

`apps/action/src/index.ts` calls `run()` at module scope, making it impossible to import for testing without triggering the full action lifecycle. A guard will be added:

```typescript
// At the end of the file, replace bare `run()` call:
if (process.env.NODE_ENV !== 'test') {
  run();
}
```

This is the only production source change in this entire proposal.

## Affected Areas

| Area                                                            | Impact       | Description                                                                    |
| --------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `apps/cli/src/ui/format.test.ts`                                | New          | Tests for all 6 pure formatting functions                                      |
| `apps/cli/src/ui/tui.test.ts`                                   | New          | Tests for TUI facade: plain vs styled mode, CI detection                       |
| `apps/cli/src/ui/theme.test.ts`                                 | New          | Tests for constants and `resolveStepIcon()`                                    |
| `apps/cli/src/lib/oauth.test.ts`                                | New          | Tests for device flow, polling loop, error handling                            |
| `apps/cli/src/commands/login.test.ts`                           | New          | Tests for login command orchestration                                          |
| `apps/cli/src/commands/logout.test.ts`                          | New          | Tests for logout command                                                       |
| `apps/cli/src/commands/status.test.ts`                          | New          | Tests for status command output                                                |
| `packages/core/src/providers/index.test.ts`                     | New          | Tests for provider factory, all 6 branches                                     |
| `packages/core/src/types.test.ts`                               | New          | Tests for DEFAULT_SETTINGS, DEFAULT_MODELS constants                           |
| `packages/db/src/client.test.ts`                                | New          | Tests for createDatabase with pg mocking                                       |
| `packages/db/src/schema.test.ts`                                | New          | Tests for DEFAULT_REPO_SETTINGS constant                                       |
| `apps/server/src/memory/postgres.test.ts`                       | New/Modified | Tests for core Postgres memory methods (beyond stubs)                          |
| `apps/server/src/inngest/client.test.ts`                        | New          | Tests for Inngest client config                                                |
| `apps/server/src/lib/logger.test.ts`                            | New          | Tests for Pino logger configuration                                            |
| `apps/dashboard/src/lib/api.test.ts`                            | New/Modified | Tests for 11 untested hooks                                                    |
| `apps/dashboard/src/lib/oauth.test.ts`                          | New          | Tests for isServerAvailable, fetchGitHubUser                                   |
| `apps/dashboard/src/lib/repo-context.test.tsx`                  | New          | Tests for React context provider                                               |
| `apps/dashboard/src/lib/cn.test.ts`                             | New          | Tests for cn() utility                                                         |
| `apps/dashboard/src/pages/Dashboard.test.tsx`                   | New          | Smoke render tests                                                             |
| `apps/dashboard/src/pages/Reviews.test.tsx`                     | New          | Table and modal interaction tests                                              |
| `apps/dashboard/src/pages/Settings.test.tsx`                    | New          | Form state and validation tests                                                |
| `apps/dashboard/src/pages/Memory.test.tsx`                      | New          | Session viewer render tests                                                    |
| `apps/dashboard/src/components/settings/ProviderEntry.test.tsx` | New          | Form component tests                                                           |
| `apps/dashboard/src/components/*.test.tsx`                      | New          | Simple component render tests (Layout, SeverityBadge, StatusBadge, Card, etc.) |
| `apps/action/src/index.ts`                                      | Modified     | Add `run()` guard for testability                                              |
| `apps/action/src/index.test.ts`                                 | New          | Tests for `run()` invocation and memory lifecycle                              |
| `apps/action/src/tools/types.test.ts`                           | New          | Tests for tool type constants                                                  |

## Risks

| Risk                                                                             | Likelihood | Mitigation                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action `run()` guard changes runtime behavior                                    | Low        | Use `process.env.NODE_ENV !== 'test'` which is never set to `'test'` in production. GitHub Actions sets `NODE_ENV` to `production` or leaves it unset. Verify with a manual Action run after merge.              |
| Dashboard recharts components are flaky in jsdom                                 | Medium     | Keep recharts tests as smoke renders only (`render(<Component />)` + check no throw). Do not assert on SVG internals or chart dimensions. Mark as `it.skip` if flaky in CI — document the limitation.            |
| `Settings.tsx` (459 lines) is hard to test thoroughly                            | Medium     | Focus on: form renders with defaults, required field validation, save triggers API call. Do not attempt full interaction matrix. Document untested paths as TODO comments in the test file.                      |
| OAuth polling tests with fake timers can be fragile                              | Low        | Use `vi.useFakeTimers()` with explicit `vi.advanceTimersByTime()` calls. Avoid `vi.runAllTimers()` which can infinite-loop on polling. Test the finite cases: success after N polls, timeout, user cancellation. |
| Postgres memory tests require realistic pg mocking                               | Low        | Follow existing server test pattern: mock the Drizzle client at module level, assert query shapes. Do not spin up a real Postgres instance — that's integration testing (out of scope).                          |
| Large number of test files could create merge conflicts with concurrent work     | Low        | Each test file is independent (new files, not modifying existing tests). The only conflict-prone file is `apps/action/src/index.ts` (the guard change). Coordinate with any in-flight Action changes.            |
| Test count target (~80+) may not be met if some files are simpler than estimated | Low        | The exploration estimated 91-147 tests. Targeting 80+ leaves margin. If we land at 75, that's still a major improvement. The goal is coverage, not a specific number.                                            |

## Rollback Plan

1. **All test files are additive**: Every new `*.test.ts` / `*.test.tsx` file can be deleted without affecting any production code or existing tests
2. **The Action guard is the only source change**: Reverting `apps/action/src/index.ts` to the bare `run()` call restores exact prior behavior
3. **No config changes**: No `vitest.config.ts` modifications, no `package.json` dependency additions, no build changes
4. **git revert scope**: Single feature branch. `git revert` of the merge commit cleanly removes all new test files and the one-line guard change
5. **Zero risk to existing 1,321 tests**: New tests do not modify any existing test files' assertions or mocks

## Dependencies

- **No new npm dependencies** — all testing uses the existing vitest, `@testing-library/react`, `@testing-library/jest-dom`, and `vi.mock()` infrastructure already installed in each package
- **Existing test patterns** documented in each package's existing test files serve as the implementation guide
- **`cli-tui` change must be merged first** — the TUI tests in Phase 2 depend on `apps/cli/src/ui/tui.ts` existing (already merged per the archived change)
- **`memory-management` change must be merged first** — the Postgres memory tests and CLI command tests depend on the `MemoryStorage` interface extensions (already merged per the archived change)

## Distribution Mode Impact

| Mode              | Impact                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| **CLI**           | Tests added for TUI, formatting, OAuth, commands — no runtime change                                  |
| **SaaS**          | Tests added for Postgres memory, logger, Inngest config — no runtime change                           |
| **GitHub Action** | `run()` guard added to `index.ts`; tests added for run lifecycle — guard is transparent in production |
| **Dashboard**     | Tests added for hooks, pages, components — no runtime change                                          |

## Success Criteria

- [ ] All HIGH priority files (7 files) have dedicated test suites with meaningful coverage
- [ ] Total test count across the monorepo increases by at least 80 (from ~1,321 to ~1,401+)
- [ ] All existing 1,321 tests continue to pass with zero modifications
- [ ] All new tests pass in CI (GitHub Actions) on first merge
- [ ] `apps/action/src/index.ts` has a testability guard that does not affect production runtime
- [ ] Each phase can be merged independently without breaking other phases
- [ ] No new npm dependencies are added to any package
- [ ] New test files follow the established patterns per package (explicit vitest imports, `vi.mock()` at module level, `vi.hoisted()` for shared mocks)
- [ ] Dashboard recharts tests do not introduce CI flakiness (smoke renders only)
- [ ] `pnpm test` passes across all 6 packages after the change
