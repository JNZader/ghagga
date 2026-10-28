# Tasks: Test Coverage Audit — Close Coverage Gaps Before v2.1.0

## Phase 1: Quick Wins — Pure Functions & Constants

Zero dependencies, zero mocking. Each task creates one test file testing deterministic exports.
- [x] T1.1 Create `apps/cli/src/ui/format.test.ts` — test all 6 pure functions
  - `formatTable()`: headers + separator + rows, single-row, empty rows, column padding
  - `formatSize()`: bytes range (<1024), KB range, MB range, boundary values (0, 1024, 1048576)
  - `formatId()`: zero-padding (42 -> "00000042"), large id, id=0
  - `truncate()`: string shorter than maxLen, exactly maxLen, longer (appends "...")
  - `formatKeyValue()`: default indent (3), custom indent, long label padding
  - `formatMarkdownResult()`: PASSED with no findings ("Nice work!"), FAILED with grouped findings by source (semgrep/trivy/cpd/ai render order), findings with/without line number, findings with/without suggestion, static analysis summary (toolsRun + toolsSkipped), all STATUS_EMOJI and SEVERITY_EMOJI branches
  - **Est: 14-18 tests** | Mock: `vi.mock('./theme.js')` for theme constants (or import directly since they're constants)

- [x] T1.2 Create `apps/cli/src/ui/theme.test.ts` — test constants + `resolveStepIcon()`
  - `BRAND`: shape has `name` and `tagline` strings
  - `STATUS_EMOJI`: all 4 ReviewStatus keys mapped ('PASSED', 'FAILED', 'NEEDS_HUMAN_REVIEW', 'SKIPPED')
  - `SEVERITY_EMOJI`: all 5 FindingSeverity keys mapped ('critical', 'high', 'medium', 'low', 'info')
  - `STEP_ICON`: all 12 known step keys mapped
  - `SOURCE_LABELS`: all 4 source keys mapped ('semgrep', 'trivy', 'cpd', 'ai')
  - `resolveStepIcon()`: known step returns STEP_ICON value, `'specialist-X'` returns `'👤'`, `'vote-X'` returns `'🗳️'`, unknown step returns `'▸'`
  - **Est: 6-8 tests** | Mock: none

- [x] T1.3 Create `packages/core/src/types.test.ts` — test DEFAULT_SETTINGS and DEFAULT_MODELS shape
  - `DEFAULT_SETTINGS`: has all 7 keys (enableSemgrep, enableTrivy, enableCpd, enableMemory, customRules, ignorePatterns, reviewLevel), booleans are true, reviewLevel is 'normal', customRules is empty array, ignorePatterns is non-empty array
  - `DEFAULT_MODELS`: has all 6 provider keys ('anthropic', 'openai', 'google', 'github', 'ollama', 'qwen'), each value is a non-empty string
  - **Est: 2-3 tests** | Mock: none

- [x] T1.4 Create `packages/db/src/schema.test.ts` — test DEFAULT_REPO_SETTINGS shape
  - `DEFAULT_REPO_SETTINGS`: has all 7 keys matching RepoSettings interface, boolean defaults match (all true), reviewLevel is 'normal', customRules is empty array, ignorePatterns matches expected list
  - **Est: 1-2 tests** | Mock: none

- [x] T1.5 Create `apps/action/src/tools/types.test.ts` — test TOOL_VERSIONS and TOOL_TIMEOUT_MS constants
  - `TOOL_VERSIONS`: has 'semgrep', 'trivy', 'pmd' keys, each is a semver-like string
  - `TOOL_TIMEOUT_MS`: equals 180_000 (3 minutes)
  - `ToolName` type coverage: the file exports the type (just assert the constants exist and are valid)
  - **Est: 2-3 tests** | Mock: none

- [x] T1.6 Create `apps/dashboard/src/lib/cn.test.ts` — test cn() utility
  - `cn()`: single class string, multiple classes, conditional class (falsy excluded), clsx array syntax, Tailwind merge conflict resolution (e.g., `cn('p-4', 'p-2')` -> `'p-2'`)
  - **Est: 3-4 tests** | Mock: none

## Phase 2: Critical Path Coverage

Files that need mocking but are on critical code paths. Highest-risk gaps.
- [x] T2.1 Create `packages/core/src/providers/index.test.ts` — test provider factory for all 6 branches + error case
  - Mock: `vi.mock('@ai-sdk/anthropic')`, `vi.mock('@ai-sdk/openai')`, `vi.mock('@ai-sdk/google')` — each returns a factory function
  - `createProvider('anthropic', key)`: calls `createAnthropic({ apiKey })`
  - `createProvider('openai', key)`: calls `createOpenAI({ apiKey })`
  - `createProvider('google', key)`: calls `createGoogleGenerativeAI({ apiKey })`
  - `createProvider('github', key)`: calls `createOpenAI` with GitHub Models baseURL and `name: 'github-models'`
  - `createProvider('ollama', key)`: calls `createOpenAI` with Ollama baseURL, `name: 'ollama'`, falls back to `'ollama'` when key is empty
  - `createProvider('qwen', key)`: calls `createOpenAI` with Qwen/DashScope baseURL, `name: 'qwen'`
  - `createProvider(unknownProvider)`: throws `'Unknown provider: ...'`
  - `createModel()`: calls createProvider internally, returns result of calling provider instance with model string
  - **Est: 9-11 tests** | Mock: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`

- [x] T2.2 Create `apps/cli/src/ui/tui.test.ts` — test TUI facade: plain vs styled mode, CI detection
  - Mock: `vi.mock('@clack/prompts')` — mock all clack functions (intro, outro, log.*, spinner)
  - `init()`: default (no args) resolves to plain (non-TTY in test env)
  - `init({ plain: true })`: forces plain mode
  - `isPlain()`: returns true after `init({ plain: true })`, behavior after init without opts
  - Plain mode: `intro()` calls `console.log` with `═══` prefix, `outro()` calls `console.log` with `───` prefix
  - Plain mode: `log.info/success/warn/step/message` all call `console.log`, `log.error` calls `console.error`
  - Styled mode: `intro()` delegates to `clack.intro()`, `outro()` delegates to `clack.outro()`
  - Styled mode: `log.*` methods delegate to corresponding `clack.log.*` methods
  - `spinner()` plain mode: returns object where `start()/message()` are no-ops, `stop(msg)` calls `console.log(msg)`
  - `spinner()` styled mode: delegates to `clack.spinner()`, wraps start/message/stop
  - **Est: 12-16 tests** | Mock: `@clack/prompts`, `console.log`, `console.error`

- [x] T2.3 Create `apps/cli/src/lib/oauth.test.ts` — test device flow, polling loop, error paths
  - Mock: `vi.stubGlobal('fetch')` for all network calls, `vi.useFakeTimers()` for polling
  - `GITHUB_CLIENT_ID`: is exported and equals `'Ov23liyYpSgDqOLUFa5k'`
  - `requestDeviceCode()`: success — sends POST to github.com/login/device/code with client_id, returns parsed JSON
  - `requestDeviceCode()`: failure — throws on non-ok response with status and body text
  - `pollForAccessToken()`: success after 1 poll — returns AccessTokenResponse with access_token
  - `pollForAccessToken()`: authorization_pending then success — keeps polling, returns on second attempt
  - `pollForAccessToken()`: slow_down — increases interval by 5 seconds, continues polling
  - `pollForAccessToken()`: expired_token — throws "Device code expired"
  - `pollForAccessToken()`: access_denied — throws "Authorization was denied"
  - `pollForAccessToken()`: unknown error — throws "OAuth error: {error}" with optional description
  - `pollForAccessToken()`: deadline exceeded — throws timeout error
  - `fetchGitHubUser()`: success — sends GET to api.github.com/user with Bearer token, returns GitHubUser
  - `fetchGitHubUser()`: failure — throws on non-ok response with status
  - **Est: 10-13 tests** | Mock: global fetch, fake timers

- [x] T2.4 Extend `apps/server/src/memory/postgres.test.ts` — add tests for core methods (search, save, create, end, close)
  - Existing tests cover only management stubs (listObservations, getObservation, etc.)
  - Add a new `describe('PostgresMemoryStorage — core methods')` block
  - `searchObservations()`: calls `ghagga-db.searchObservations` with db, project, query, options; maps full rows to MemoryObservationRow subset (id, type, title, content, filePaths); handles null filePaths
  - `saveObservation()`: calls `ghagga-db.saveObservation` with db + data; maps row to MemoryObservationRow subset; handles null filePaths
  - `createSession()`: calls `ghagga-db.createMemorySession` with db + data; returns `{ id }`
  - `endSession()`: calls `ghagga-db.endMemorySession` with db + sessionId + summary
  - `close()`: is a no-op (resolves without error)
  - **Est: 7-9 tests** | Mock: extend existing `vi.mock('ghagga-db')` with mock implementations

- [x] T2.5 Modify `apps/action/src/index.ts` — add `run()` guard for testability
  - Replace bare `run()` call at line 258 with: `if (process.env.NODE_ENV !== 'test') { run(); }`
  - This is the ONLY production source change in the entire proposal
  - Verify: existing `apps/action/src/index.test.ts` still passes after the guard
  - **Est: 0 new tests** (enables T2.6) | Source change only

- [x] T2.6 Extend `apps/action/src/index.test.ts` — add integration-style tests for `run()` lifecycle
  - Existing tests verify input parsing, API key resolution, result handling, and error handling as unit logic
  - Add tests that actually invoke `run()` via dynamic import (possible after T2.5 guard):
    - `run()` with valid inputs: calls reviewPipeline, posts comment, sets outputs
    - `run()` with empty diff: sets output status=SKIPPED, findings-count=0, no reviewPipeline call
    - `run()` with no PR context: calls setFailed with "pull_request event" message
    - `run()` with missing GitHub token: calls setFailed with "GitHub token is required"
    - `run()` with paid provider and no api-key: calls setFailed
    - `run()` with FAILED review result: calls setFailed with "critical issues"
    - `run()` with pipeline error: calls setFailed with "GHAGGA review failed"
    - Memory lifecycle: restoreCache -> create SQLite -> reviewPipeline -> close -> saveCache
  - **Est: 6-8 tests** | Mock: `@actions/core`, `@actions/github`, `@actions/cache`, `ghagga-core`

## Phase 3: Dashboard Hooks & Components

Extend existing dashboard test patterns. All use `vi.stubGlobal('fetch')` + `createWrapper()`.
- [x] T3.1 Extend `apps/dashboard/src/lib/api.test.ts` — test remaining 11 hooks
  - Existing tests cover: useRunnerStatus (5), useCreateRunner (4), useConfigureRunnerSecret (3) = 12 tests
  - Add tests for these hooks using the same mockFetch + createWrapper pattern:
  - `useReviews()`: returns paginated reviews, passes repo filter param, passes page param
  - `useStats(repo)`: returns stats, disabled when repo is empty
  - `useRepositories()`: returns repository list
  - `useSettings(repo)`: returns settings, disabled when repo is empty
  - `useUpdateSettings()`: sends PUT, invalidates settings cache for the repo
  - `useValidateProvider()`: sends POST with provider+apiKey payload
  - `useInstallations()`: returns installation list
  - `useInstallationSettings(id)`: returns settings, disabled when id is 0/falsy
  - `useUpdateInstallationSettings()`: sends PUT, invalidates installation-settings + settings cache
  - `useMemorySessions(project)`: returns sessions, disabled when project is empty
  - `useObservations(sessionId)`: returns observations, disabled when sessionId is 0/falsy
  - **Est: 18-22 tests** | Mock: global fetch, localStorage

- [x] T3.2 Create `apps/dashboard/src/lib/oauth.test.ts` — test isServerAvailable and fetchGitHubUser
  - Mock: `vi.stubGlobal('fetch')`
  - `isServerAvailable()`: returns true when /health responds ok, returns false when fetch throws (network error), returns false when response is not ok (500), returns false when request times out (abort signal)
  - `fetchGitHubUser()`: success — returns GitHubUser from api.github.com/user, failure — throws "Invalid or expired token" on non-ok response
  - **Est: 5-6 tests** | Mock: global fetch

- [x] T3.3 Create `apps/dashboard/src/lib/repo-context.test.tsx` — test context provider + hook
  - Mock: `vi.stubGlobal('localStorage')` for getItem/setItem/removeItem
  - `RepoProvider`: renders children, initializes selectedRepo from localStorage, defaults to `''` when localStorage throws
  - `useSelectedRepo()`: returns selectedRepo and setSelectedRepo, setSelectedRepo updates state and persists to localStorage, setting empty string removes from localStorage
  - `useSelectedRepo()`: throws when used outside RepoProvider
  - **Est: 5-6 tests** | Mock: localStorage, render with React Testing Library

- [x] T3.4 Create smoke render tests for dashboard pages: `Dashboard.tsx`, `Reviews.tsx`, `Settings.tsx`, `Memory.tsx`
  - Create `apps/dashboard/src/pages/Dashboard.test.tsx`: smoke render with mocked fetch (loading state renders without crash)
  - Create `apps/dashboard/src/pages/Reviews.test.tsx`: smoke render, table headers visible on data load
  - Create `apps/dashboard/src/pages/Settings.test.tsx`: smoke render, form renders with defaults
  - Create `apps/dashboard/src/pages/Memory.test.tsx`: smoke render, session list renders
  - All pages need: `createWrapper()` for QueryClient, `vi.stubGlobal('fetch')` for API calls, router context if applicable
  - **Est: 6-10 tests** (2-3 per page) | Mock: global fetch, QueryClient wrapper

- [x] T3.5 Create tests for simple dashboard components: SeverityBadge, StatusBadge, Card, Layout
  - Locate components in `apps/dashboard/src/components/` and create co-located test files
  - SeverityBadge: renders each severity level with correct text/color class
  - StatusBadge: renders each review status with correct text/color class
  - Card: renders children, applies custom className
  - Layout: renders sidebar + main content area, renders children in main slot
  - **Est: 8-12 tests** | Mock: minimal (pure presentational components)

## Phase 4: CLI Commands & Remaining

CLI commands with established mock patterns, plus low-priority items.
- [x] T4.1 Create `apps/cli/src/commands/login.test.ts` — test login command orchestration
  - Mock: `vi.mock('../lib/config.js')`, `vi.mock('../lib/oauth.js')`, `vi.mock('../ui/tui.js')`
  - Already logged in: prints "Already logged in as {login}", returns without device flow
  - Happy path: calls requestDeviceCode -> shows user_code -> pollForAccessToken -> fetchGitHubUser -> saveConfig with token+login+defaults
  - Browser open attempt: tryOpenBrowser is called with verification_uri (test both success and failure paths)
  - Spinner lifecycle: start('Waiting...') -> stop('Authorization received')
  - Error handling: login failure calls tui.log.error with message, exits with code 1
  - **Est: 4-6 tests** | Mock: config, oauth, tui, child_process (for tryOpenBrowser)

- [x] T4.2 Create `apps/cli/src/commands/logout.test.ts` — test logout command
  - Mock: `vi.mock('../lib/config.js')`, `vi.mock('../ui/tui.js')`
  - Not logged in: calls `tui.log.info` with "Not currently logged in"
  - Logged in: calls `clearConfig()`, shows success message with the login name
  - **Est: 2-3 tests** | Mock: config, tui

- [x] T4.3 Create `apps/cli/src/commands/status.test.ts` — test status command output
  - Mock: `vi.mock('../lib/config.js')`, `vi.mock('../lib/oauth.js')`, `vi.mock('../ui/tui.js')`
  - Not logged in: shows config path, "Not logged in", suggests "ghagga login"
  - Logged in with valid token: shows config path, login, provider, model, validates token via fetchGitHubUser, shows "Valid"
  - Logged in with expired token: fetchGitHubUser throws, shows "Expired or invalid", suggests re-auth
  - **Est: 3-4 tests** | Mock: config, oauth, tui

- [x] T4.4 Create `packages/db/src/client.test.ts` — test createDatabase and createDatabaseFromEnv
  - Mock: `vi.mock('drizzle-orm/node-postgres')`, `vi.mock('pg')`
  - `createDatabase(connectionString)`: creates pg.Pool with correct config (max: 10, timeouts), calls drizzle with pool + schema
  - `createDatabaseFromEnv()`: reads `process.env.DATABASE_URL`, calls createDatabase with it
  - `createDatabaseFromEnv()`: throws when DATABASE_URL is not set
  - **Est: 3-4 tests** | Mock: drizzle-orm/node-postgres, pg

- [x] T4.5 (Low priority) Create remaining server tests
  - `apps/server/src/lib/logger.test.ts`: Pino logger is configured, exports a logger instance
  - `apps/server/src/inngest/client.test.ts`: Inngest client is configured with correct app name
  - **Est: 2-3 tests** | Mock: minimal (config assertions)

- [x] T4.6 (Low priority) Create remaining dashboard component tests
  - `apps/dashboard/src/components/settings/ProviderEntry.test.tsx`: renders provider name, API key input, validation state
  - `apps/dashboard/src/components/settings/ProviderChainEditor.test.tsx`: renders chain entries, add/remove/reorder buttons
  - **Est: 4-6 tests** | Mock: React Testing Library renders

## Summary

| Phase     | Tasks  | Est. Tests  | Focus                                     |
| --------- | ------ | ----------- | ----------------------------------------- |
| Phase 1   | 6      | 28-38       | Pure functions & constants (zero mocking) |
| Phase 2   | 6      | 44-57       | Critical path coverage (mocking required) |
| Phase 3   | 5      | 42-56       | Dashboard hooks & components              |
| Phase 4   | 6      | 18-26       | CLI commands & remaining                  |
| **Total** | **23** | **132-177** |                                           |

## Implementation Order

1. **Phase 1 first** — zero dependencies, establishes test file scaffolding, builds confidence
2. **T2.5 (run guard)** — the only source change; do it early so CI validates it across all subsequent commits
3. **T2.1-T2.4** — critical path mocking tasks, independent of each other (can be parallelized)
4. **T2.6** — depends on T2.5 (guard must be in place)
5. **Phase 3** — T3.1 depends on existing api.test.ts patterns; T3.2-T3.5 are independent
6. **Phase 4** — lowest priority; T4.1-T4.3 share CLI mock patterns; T4.4-T4.6 are independent

## Notes

- **Test file locations follow existing patterns**: CLI tests go alongside source (`src/ui/format.test.ts`, `src/commands/login.test.ts`), Core tests alongside source (`src/providers/index.test.ts`), Dashboard tests alongside source (`src/lib/oauth.test.ts`), Action tests alongside source or in `__tests__/`
- **T2.4 extends an existing file** (`postgres.test.ts`) — all others create new files
- **T2.6 extends an existing file** (`index.test.ts`) — adds integration tests to existing unit test suite
- **T3.1 extends an existing file** (`api.test.ts`) — adds hooks to existing test file
- **All other tasks create new test files** — no risk of merge conflicts with existing tests
- **The only production source change** is T2.5 (Action run guard) — everything else is additive test code
