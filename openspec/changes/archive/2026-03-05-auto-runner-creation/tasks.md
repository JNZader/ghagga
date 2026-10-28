# Tasks: Automatic Runner Repository Creation

## Archive Status

✅ **All 14 tasks complete** — Archived 2026-03-05

### Commits

| Hash      | Message                                        | Tasks                  |
| --------- | ---------------------------------------------- | ---------------------- |
| `7c30a5b` | feat(runner): createRunnerRepo() + OAuth scope | T1.1, T1.2, T1.3, T1.4 |
| `d6a2ce9` | feat(runner): runner management endpoints      | T2.1, T2.2             |
| `a9e120b` | feat(dashboard): Runner card UI                | T3.1, T3.2, T3.3, T3.4 |
| `2a3f3c8` | test(runner): 226 tests (534 total)            | T1.5, T2.3             |
| `35f1778` | docs(runner): docs + SDD artifacts             | T4.1, T4.2             |

---

## Summary

| Phase     | Tasks  | Focus                                              | Est. Effort |
| --------- | ------ | -------------------------------------------------- | ----------- |
| Phase 1   | 5      | Server Foundation (types, OAuth, runner functions) | ~3h         |
| Phase 2   | 3      | Server Endpoints + Tests                           | ~3h         |
| Phase 3   | 4      | Dashboard UI (types, hooks, auth, UI)              | ~3h         |
| Phase 4   | 2      | Documentation & Cleanup                            | ~1.5h       |
| **Total** | **14** |                                                    | **~10.5h**  |

---

## Phase 1: Server Foundation

### - [x] T1.1: Add runner creation types and error class to `runner.ts`

**Description**: Add all TypeScript types and the custom error class needed by the runner creation feature. This is the foundation that all other tasks depend on.

**Files**:
- `apps/server/src/github/runner.ts` — Add types and error class

**What to implement**:
- `RunnerErrorCode` type union (`insufficient_scope | already_exists | template_unavailable | rate_limited | org_permission_denied | creation_timeout | secret_failed | github_error`)
- `RunnerCreationError` class extending `Error` with `code`, `retryAfter?`, `repoFullName?` fields
- `RunnerCreationResult` interface (`created`, `repoFullName`, `isPrivate`, `secretConfigured`)
- `CreateRunnerRepoOptions` interface (`ownerLogin`, `token`, `callbackSecretValue`)
- Template constants: `TEMPLATE_OWNER = 'JNZader'`, `TEMPLATE_REPO = 'ghagga-runner-template'`

**Dependencies**: None
**Effort**: S
**Acceptance Criteria**:
- All types compile without errors
- `RunnerCreationError` can be instantiated with all error codes
- Types are exported from the module

### - [x] T1.2: Extend `discoverRunnerRepo()` to return `isPrivate` field

**Description**: Modify the existing `discoverRunnerRepo()` function to include `isPrivate: boolean` in its return type. The GitHub API response for `GET /repos/{owner}/{repo}` already includes the `private` field — just need to capture it. This avoids a redundant API call in the status endpoint.

**Files**:
- `apps/server/src/github/runner.ts` — Modify `DiscoveredRunner` interface and `discoverRunnerRepo()` implementation

**What to implement**:
- Add `isPrivate: boolean` to the `DiscoveredRunner` interface (or equivalent return type)
- Read `private` from the GitHub API response and map to `isPrivate` in the return value
- Ensure existing callers of `discoverRunnerRepo()` are unaffected (additive field)

**Dependencies**: None
**Effort**: S
**Acceptance Criteria**:
- `discoverRunnerRepo()` returns `isPrivate: boolean` when repo exists
- Existing callers continue working (ARC-03, ARC-12)

### - [x] T1.3: Change OAuth Device Flow scope to `public_repo`

**Description**: Change the `scope` parameter in the GitHub Device Flow request from `''` to `'public_repo'`. This is a one-line change on line 36 of `oauth.ts`.

**Files**:
- `apps/server/src/routes/oauth.ts` — Change `scope: ''` → `scope: 'public_repo'`

**What to implement**:
- Locate the `scope: ''` parameter in the Device Flow code request (line ~36)
- Change to `scope: 'public_repo'`

**Dependencies**: None
**Effort**: S
**Acceptance Criteria**:
- New Device Flow requests include `scope=public_repo` in the body (ARC-01)
- Existing authentication flow continues working

### - [x] T1.4: Implement `createRunnerRepo()` function

**Description**: Implement the core function that creates a runner repo from the template, polls for readiness, and configures the secret. This is the most complex server-side task.

**Files**:
- `apps/server/src/github/runner.ts` — Add `createRunnerRepo()` function

**What to implement**:
1. Check if repo already exists via `discoverRunnerRepo()` → throw `already_exists` if so
2. Call `POST /repos/JNZader/ghagga-runner-template/generate` with `{ owner, name: "ghagga-runner", private: false, include_all_branches: false, description: "..." }`
3. Handle error responses:
   - 422 → `already_exists`
   - 403 + `X-RateLimit-Remaining === 0` → `rate_limited` (with `retryAfter` from `X-RateLimit-Reset`)
   - 403 + body contains "organization"/"permission" → `org_permission_denied`
   - 403 (other) → `insufficient_scope`
   - 404 → `template_unavailable`
   - Other → `github_error`
4. Poll `discoverRunnerRepo()` until accessible: max 15 attempts, 2s interval (30s total) → throw `creation_timeout` if not ready
5. Call `setRunnerSecret()` to set `GHAGGA_CALLBACK_SECRET` — if fails, set `secretConfigured: false` (not a fatal error)
6. Return `RunnerCreationResult`

**Dependencies**: T1.1, T1.2
**Effort**: L
**Acceptance Criteria**:
- Happy path creates repo, polls until ready, sets secret, returns result (ARC-02, ARC-04)
- All 7 error codes correctly mapped from GitHub API responses (ARC-06, ARC-07, ARC-10, ARC-11)
- Partial failure (secret fails) returns `secretConfigured: false` (ARC-04)
- Created repo requested as `private: false` (ARC-08)

### - [x] T1.5: Write unit tests for `createRunnerRepo()` and `RunnerCreationError`

**Description**: Write comprehensive unit tests for the `createRunnerRepo()` function covering all error paths, polling logic, and the `RunnerCreationError` class.

**Files**:
- `apps/server/src/github/runner.test.ts` — Create new test file (or add to existing if one exists)

**What to test**:
- `RunnerCreationError` construction with all error codes
- Happy path: repo created, polled, secret set
- `already_exists`: pre-check catches existing repo
- `already_exists`: GitHub 422 race condition
- `insufficient_scope`: GitHub 403 without rate limit
- `rate_limited`: GitHub 403 with `X-RateLimit-Remaining: 0`
- `org_permission_denied`: GitHub 403 with org-related body
- `template_unavailable`: GitHub 404
- `creation_timeout`: polling exhausts all attempts
- `secret_failed`: repo created but `setRunnerSecret()` throws → returns `secretConfigured: false`
- Private repo warning: template API returns `private: true` in response

**Dependencies**: T1.1, T1.2, T1.4
**Effort**: M
**Acceptance Criteria**:
- All error code paths tested
- Polling logic verified (correct number of attempts, interval)
- Tests pass: `pnpm vitest run apps/server/src/github/runner.test.ts`

---

## Phase 2: Server Endpoints

### - [x] T2.1: Add `GET /api/runner/status` endpoint

**Description**: Add the runner status endpoint to `createApiRouter()` in `api.ts`. Extracts user and token from auth context, calls `discoverRunnerRepo()`, returns structured response with optional private repo warning.

**Files**:
- `apps/server/src/routes/api.ts` — Add route inside `createApiRouter()`

**What to implement**:
- Token extraction: `const authHeader = c.req.header('Authorization') ?? ''; const token = authHeader.replace(/^Bearer\s+/i, '');`
- Call `discoverRunnerRepo(user.githubLogin, token)`
- If not found: return `200 { data: { exists: false } }`
- If found: return `200 { data: { exists: true, repoFullName, isPrivate? } }`
- If found and private: include `warning` field with billing message
- If GitHub error: return `502 { error: "github_unavailable", message: "..." }`

**Dependencies**: T1.2
**Effort**: S
**Acceptance Criteria**:
- Endpoint returns correct shape for existing repo (ARC-03)
- Endpoint returns `{ exists: false }` for missing repo (ARC-03)
- Private repos include warning (ARC-12)
- GitHub errors return 502 (ARC-03)

### - [x] T2.2: Add `POST /api/runner/create` and `POST /api/runner/configure-secret` endpoints

**Description**: Add the runner creation and secret configuration endpoints to `createApiRouter()`. The create endpoint orchestrates via `createRunnerRepo()` and maps `RunnerCreationError` codes to HTTP responses. The configure-secret endpoint re-sets the secret on an existing repo.

**Files**:
- `apps/server/src/routes/api.ts` — Add two routes inside `createApiRouter()`

**What to implement**:

`POST /api/runner/create`:
- Extract user and token from auth context (same pattern as T2.1)
- Call `createRunnerRepo({ ownerLogin: user.githubLogin, token, callbackSecretValue: process.env.GHAGGA_WEBHOOK_SECRET! })`
- Success: return `201 { data: { created: true, repoFullName, secretConfigured, isPrivate } }`
- If `isPrivate`: add `warning` field
- Map `RunnerCreationError` codes to HTTP status codes:
  - `insufficient_scope` → 403
  - `already_exists` → 409 (include `repoFullName`)
  - `rate_limited` → 429 (include `retryAfter`)
  - `template_unavailable` → 502
  - `org_permission_denied` → 403
  - `creation_timeout` → 502
  - `secret_failed` → 201 with `secretConfigured: false` (partial success)
  - `github_error` → 502

`POST /api/runner/configure-secret`:
- Extract user and token
- Call `discoverRunnerRepo()` → if not found, return `404 { error: "runner_not_found" }`
- Call `setRunnerSecret(repoFullName, "GHAGGA_CALLBACK_SECRET", process.env.GHAGGA_WEBHOOK_SECRET!, token)`
- Success: return `200 { data: { configured: true } }`
- Error: return `502 { error: "github_error" }`

**Dependencies**: T1.1, T1.2, T1.4
**Effort**: M
**Acceptance Criteria**:
- Create endpoint returns 201 on success (ARC-02)
- All error codes properly mapped to HTTP responses (ARC-06, ARC-07, ARC-08, ARC-10, ARC-11, ARC-16)
- Configure-secret returns 200 on success, 404 if repo missing (ARC-15)
- Secret partial failure returns 201 with `secretConfigured: false` (ARC-04)

### - [x] T2.3: Write endpoint tests in `api.test.ts`

**Description**: Add a comprehensive test suite for all three runner endpoints following the existing test pattern in `api.test.ts` (mock auth middleware, mock runner functions, test via `app.request()`).

**Files**:
- `apps/server/src/routes/api.test.ts` — Add `describe` blocks for runner endpoints

**What to implement**:
- Set up mocks: `mockDiscoverRunnerRepo`, `mockCreateRunnerRepo`, `mockSetRunnerSecret`, `RunnerCreationError` mock class
- Add to the existing `vi.mock('../github/runner.js', ...)` block (or add new one)

Test cases for `GET /api/runner/status`:
- Returns `{ exists: true, repoFullName }` when repo found
- Returns `{ exists: false }` when repo not found
- Returns `isPrivate: true` + warning for private repo
- Returns 502 on GitHub API error

Test cases for `POST /api/runner/create`:
- Happy path: 201 with `created: true`
- `already_exists` → 409 with `repoFullName`
- `insufficient_scope` → 403
- `rate_limited` → 429 with `retryAfter`
- `template_unavailable` → 502
- `org_permission_denied` → 403
- `creation_timeout` → 502
- `secret_failed` → 201 with `secretConfigured: false`
- `isPrivate: true` → 201 with warning
- Generic error → 502

Test cases for `POST /api/runner/configure-secret`:
- Happy path: 200 with `configured: true`
- Repo not found: 404
- Secret set fails: 502

**Dependencies**: T2.1, T2.2
**Effort**: L
**Acceptance Criteria**:
- All 17+ test cases pass
- Covers every error code path
- Token extraction verified in at least one test
- Tests pass: `pnpm vitest run apps/server/src/routes/api.test.ts`

---

## Phase 3: Dashboard UI

### - [x] T3.1: Add runner types to Dashboard `types.ts`

**Description**: Add the TypeScript types that the Dashboard needs for runner API responses.

**Files**:
- `apps/dashboard/src/lib/types.ts` — Add runner types

**What to implement**:
- `RunnerStatus` interface: `{ exists: boolean; repoFullName?: string; isPrivate?: boolean; warning?: string }`
- `RunnerCreateResult` interface: `{ created: boolean; repoFullName: string; secretConfigured: boolean; isPrivate: boolean; warning?: string }`
- `RunnerConfigureResult` interface: `{ configured: boolean }`
- `RunnerError` interface: `{ error: string; message?: string; repoFullName?: string; retryAfter?: number }`

**Dependencies**: None (can run in parallel with Phase 1/2)
**Effort**: S
**Acceptance Criteria**:
- Types compile without errors
- Types match the server response shapes from design.md

### - [x] T3.2: Add runner API hooks to Dashboard `api.ts`

**Description**: Add React Query hooks for the three runner endpoints using the existing `fetchData<T>()` / `useMutation` / `useQuery` patterns.

**Files**:
- `apps/dashboard/src/lib/api.ts` — Add hooks

**What to implement**:
- `useRunnerStatus(ownerLogin?: string)` — `useQuery` calling `GET /api/runner/status`, enabled only when `ownerLogin` is truthy, `staleTime: 30_000`, `retry: 1`
- `useCreateRunner()` — `useMutation` calling `POST /api/runner/create`, invalidates `['runner', 'status']` on success
- `useConfigureRunnerSecret()` — `useMutation` calling `POST /api/runner/configure-secret`

**Dependencies**: T3.1
**Effort**: S
**Acceptance Criteria**:
- Hooks use correct query keys and fetch paths
- `useCreateRunner` invalidates runner status cache on success (ARC-05)
- `staleTime` set to avoid hammering GitHub API

### - [x] T3.3: Add `reAuthenticate()` method to auth context

**Description**: Add a `reAuthenticate()` method to the `AuthContext` that clears the current token and restarts the Device Flow. Used when the user's token lacks the `public_repo` scope.

**Files**:
- `apps/dashboard/src/lib/auth.tsx` — Add method to auth context

**What to implement**:
- Add `reAuthenticate: () => Promise<void>` to `AuthContextType` interface
- Implementation: clear `localStorage` token/user keys, set `token`/`user` state to null, call existing `startLogin()` to restart Device Flow
- Wrap in `useCallback` with `[startLogin]` dependency

**Dependencies**: None
**Effort**: S
**Acceptance Criteria**:
- Calling `reAuthenticate()` clears credentials and starts new Device Flow (ARC-06)
- New Device Flow requests `public_repo` scope (from T1.3)

### - [x] T3.4: Build Runner section in `GlobalSettings.tsx`

**Description**: Add the full Runner Card UI to the Global Settings page, placed before the Static Analysis card. Implements the 6-state state machine: checking, not_configured, creating, ready, error, needs_reauth.

**Files**:
- `apps/dashboard/src/pages/GlobalSettings.tsx` — Add Runner Card section

**What to implement**:
- Import runner hooks (`useRunnerStatus`, `useCreateRunner`, `useConfigureRunnerSecret`) and `useAuth` for `reAuthenticate`
- Call `useRunnerStatus(user?.githubLogin)` for status
- Call `useCreateRunner()` for creation mutation
- Call `useConfigureRunnerSecret()` for secret reconfiguration
- Add `needsReauth` state with `useEffect` that detects `insufficient_scope` from `ApiError` (parse JSON from `err.message`, check `body.error === 'insufficient_scope'`)
- Render `<Card>` + `<CardHeader title="Static Analysis Runner" description="...">` using existing components
- State: **checking** — Spinner + "Checking runner status..."
- State: **not_configured** — Explanation text + `public_repo` scope warning + "Enable Runner" primary button
- State: **creating** — Spinner + "Creating runner repository..." (button disabled)
- State: **ready** — Green checkmark + "Runner enabled" + repo link + "Reconfigure Secret" secondary button + private repo warning (if applicable)
- State: **error** — Red error message + "Retry" button
- State: **needs_reauth** — Yellow warning about scope + "Re-authenticate" button
- Use existing Tailwind theme tokens: `text-primary`, `text-text-secondary`, `surface-card`, `primary-600`, etc.

**Dependencies**: T3.1, T3.2, T3.3
**Effort**: L
**Acceptance Criteria**:
- All 6 UI states render correctly (ARC-05)
- "Enable Runner" triggers `POST /api/runner/create` (ARC-02)
- Scope error shows re-auth prompt (ARC-06)
- 409 "already exists" treated as success in Dashboard (ARC-07, ARC-09)
- Private repo warning displayed when applicable (ARC-12)
- "Reconfigure Secret" triggers `POST /api/runner/configure-secret` (ARC-15)
- Runner card placed before Static Analysis card

---

## Phase 4: Documentation & Cleanup

### - [x] T4.1: Update documentation files

**Description**: Update all four documentation files to reflect the new runner creation flow, OAuth scope change, and permission reduction.

**Files**:
- `docs/security.md` — Add section on `public_repo` scope, why it's needed, that token is server-side only, GitHub App permission reduction
- `docs/quick-start.md` — Replace manual "create runner from template" step with "Click 'Enable Runner' in the Dashboard" + mention OAuth scope prompt
- `docs/self-hosted.md` — Note that auto-creation is SaaS-only; self-hosted users still create runner manually from template
- `docs/runner-architecture.md` — Update creation flow description: Dashboard → OAuth → Template Generate API; update diagrams if they reference the old App-based flow

**Dependencies**: T2.2 (endpoints must be final to document accurately)
**Effort**: M
**Acceptance Criteria**:
- All four docs updated with accurate information (ARC-14)
- Security implications of `public_repo` clearly documented
- Quick-start reflects simplified onboarding flow
- Self-hosted distinction documented

### - [x] T4.2: Document GitHub App permission reduction (manual step)

**Description**: Create a clear checklist for the manual GitHub App permission reduction that must be performed after deployment. This is NOT a code task — it's an ops step documented in `tasks.md` and `proposal.md`.

**Files**:
- This file (`tasks.md`) — Document the manual steps below

**Manual steps (post-deployment)**:
1. Verify auto-runner-creation feature is working in production
2. Go to GitHub App settings → Permissions
3. Remove `Administration: Read & Write`
4. Remove `Contents: Read & Write`
5. Verify remaining permissions: Pull requests R&W, Actions Write, Secrets R&W, Metadata Read (auto)
6. Monitor for any issues from existing installations (GitHub sends permission update prompts)
7. Verify review pipeline still functions: PR comments, workflow dispatch, secret setting

**Post-deployment checklist**:
- [ ] Feature deployed and verified working for new users
- [ ] Feature verified working for existing users (re-auth flow)
- [ ] GitHub App: `Administration: Read & Write` permission removed
- [ ] GitHub App: `Contents: Read & Write` permission removed
- [ ] Remaining permissions verified: Pull requests R&W, Actions Write, Secrets R&W, Metadata Read
- [ ] Existing installations monitored for 24h after permission change
- [ ] Review pipeline smoke test: PR comment posted, workflow dispatched, runner callback received

---

## Implementation Order

```
T1.1 (types) ──┐
T1.2 (discover) ┼──→ T1.4 (createRunnerRepo) ──→ T1.5 (unit tests)
T1.3 (scope)   ─┘                                      │
                                                        ▼
T3.1 (dash types) ──→ T3.2 (hooks) ──┐     T2.1 (status endpoint)
T3.3 (reAuth)    ─────────────────────┼──→  T2.2 (create + configure endpoints)
                                      │           │
                                      ▼           ▼
                                 T3.4 (UI)   T2.3 (endpoint tests)
                                      │           │
                                      └─────┬─────┘
                                            ▼
                                      T4.1 (docs)
                                      T4.2 (permissions)
```

**Recommended session order**: T1.1 → T1.2 → T1.3 → T1.4 → T1.5 → T2.1 → T2.2 → T2.3 → T3.1 → T3.2 → T3.3 → T3.4 → T4.1 → T4.2

---

## Acceptance Criteria Cross-Reference

| ARC ID | Description                     | Covered by Tasks       |
| ------ | ------------------------------- | ---------------------- |
| ARC-01 | OAuth scope upgrade             | T1.3                   |
| ARC-02 | Runner create endpoint          | T1.4, T2.2             |
| ARC-03 | Runner status endpoint          | T1.2, T2.1             |
| ARC-04 | Secret auto-configuration       | T1.4, T2.2             |
| ARC-05 | Dashboard Runner UI (5 states)  | T3.4                   |
| ARC-06 | Scope mismatch detection        | T1.4, T2.2, T3.3, T3.4 |
| ARC-07 | Existing repo handling (409)    | T1.4, T2.2, T3.4       |
| ARC-08 | Repo must be public             | T1.4, T2.2             |
| ARC-09 | Idempotent create               | T1.4, T3.4             |
| ARC-10 | Template unavailable            | T1.4, T2.2             |
| ARC-11 | Rate limit handling             | T1.4, T2.2             |
| ARC-12 | Private repo warning            | T1.2, T2.1, T3.4       |
| ARC-13 | GitHub App permission reduction | T4.2                   |
| ARC-14 | Documentation updates           | T4.1                   |
| ARC-15 | Secret refresh                  | T2.2, T3.4             |
| ARC-16 | Org repo creation               | T1.4, T2.2             |
