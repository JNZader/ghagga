# Proposal: Automatic Runner Repository Creation

## Archive Metadata

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| **Status**        | ✅ ARCHIVED                                                   |
| **Archived date** | 2026-03-05                                                    |
| **Verification**  | PASS WITH WARNINGS                                            |
| **Tests**         | 534 total (server: 319, dashboard: 30, action: 185) — 226 new |

### Commits

| Hash      | Message                                        |
| --------- | ---------------------------------------------- |
| `7c30a5b` | feat(runner): createRunnerRepo() + OAuth scope |
| `d6a2ce9` | feat(runner): runner management endpoints      |
| `a9e120b` | feat(dashboard): Runner card UI                |
| `2a3f3c8` | test(runner): 226 tests (534 total)            |
| `35f1778` | docs(runner): docs + SDD artifacts             |

### Pending Manual Step

- [ ] Remove `Administration: Read & Write` from GitHub App settings
- [ ] Remove `Contents: Read & Write` from GitHub App settings

---

## Intent

Users currently must manually create the `ghagga-runner` repository from a template before static analysis (Semgrep, Trivy, CPD) can work. This is the single biggest friction point in onboarding — it requires navigating to a template repo, understanding what it does, and clicking "Use this template" outside the GHAGGA Dashboard.

Since every user MUST visit the Dashboard anyway (to configure LLM API keys for AI reviews), we can eliminate this manual step entirely by adding an "Enable Runner" button that creates the runner repo automatically via the GitHub API, using the user's own OAuth token with `public_repo` scope.

This is **Option C** from prior analysis: leverage the Dashboard's existing OAuth Device Flow to obtain a token with repo-creation permissions, keeping the GitHub App's permissions minimal.

## Scope

### In Scope

- Change OAuth Device Flow scope from `''` to `'public_repo'` in `apps/server/src/routes/oauth.ts`
- New server endpoint `POST /api/runner/create` that creates `{owner}/ghagga-runner` from the template `JNZader/ghagga-runner-template` using the user's OAuth token
- Automatic runner secret configuration after repo creation (reuse existing `setRunnerSecret()`)
- "Enable Runner" button + status indicator in the Dashboard
- Runner status check endpoint `GET /api/runner/status` (wraps existing `discoverRunnerRepo()`)
- Graceful handling of pre-existing runner repos (422 → friendly "already exists" message)
- Re-auth flow for users who authenticated before the scope change (token lacks `public_repo`)
- Remove `Administration: R&W` and `Contents: R&W` from GitHub App permissions (documented manual step)
- Update documentation: `docs/security.md`, `docs/self-hosted.md`, `docs/quick-start.md`, `docs/runner-architecture.md`

### Out of Scope

- Private runner repos (would consume user's 2000 min/month GitHub Actions quota — against the "everything free" principle)
- Organization-level runner repos (orgs may have different permission models — future work)
- Automatic runner repo updates when template changes (users can manually sync or we address later)
- Migration of existing users who already created runner repos manually (they continue working as-is)
- Revoking the `public_repo` scope after creation (GitHub OAuth doesn't support scope downgrade per-token)
- CLI and GitHub Action distribution modes (they don't use the Dashboard OAuth flow)

## Approach

### 1. OAuth Scope Upgrade

Change the single `scope: ''` line in `oauth.ts` to `scope: 'public_repo'`. This is the GitHub Device Flow — no client secret needed, the Client ID `Ov23liyYpSgDqOLUFa5k` is already public. Users who previously authenticated will need to re-authenticate to get the new scope.

### 2. Server Endpoints

Add two new authenticated endpoints to `apps/server/src/routes/api.ts`:
- **`GET /api/runner/status`** — Calls `discoverRunnerRepo(user.githubLogin, token)` and returns `{ exists: boolean, repoFullName?: string }`. The Dashboard polls this on load to show the correct UI state.

- **`POST /api/runner/create`** — Orchestrates the full creation flow:
  1. Check if `{owner}/ghagga-runner` already exists (return 409 if so)
  2. Call `POST /repos/JNZader/ghagga-runner-template/generate` with the user's OAuth token to create `{owner}/ghagga-runner` as a **public** repo
  3. Wait briefly for GitHub to finish template generation (~2-3 seconds)
  4. Call `setRunnerSecret()` to configure `GHAGGA_CALLBACK_SECRET` on the new repo
  5. Return `{ created: true, repoFullName: '{owner}/ghagga-runner' }`

Both endpoints use the user's OAuth token (extracted from `Authorization: Bearer` header by the existing auth middleware). The token is never exposed to the client beyond what the Device Flow already provides.

### 3. Dashboard UI

Add a Runner section to the Dashboard (likely in `Settings.tsx` or `GlobalSettings.tsx`):
- **State: No runner** → Show "Enable Runner" button with explanation text
- **State: Creating** → Show spinner + "Creating runner repository..."
- **State: Ready** → Show green checkmark + link to `github.com/{owner}/ghagga-runner`
- **State: Error** → Show error message with retry option
- **State: Needs re-auth** → Show message explaining scope upgrade + "Re-authenticate" button

### 4. Scope Mismatch Detection

When the user's token doesn't have `public_repo` scope, the template generate API will return 403. The server endpoint detects this and returns a specific error code (e.g., `{ error: 'insufficient_scope' }`) so the Dashboard can prompt re-authentication.

### 5. GitHub App Permission Reduction

After this change, the GitHub App no longer needs `Administration: R&W` or `Contents: R&W` because:
- Repo creation → OAuth token (not App)
- Secret management → OAuth token (not App) via `setRunnerSecret()` which already uses the user's token
- The App only needs: Pull requests R&W, Actions Write, Secrets R&W, Metadata Read

This is a manual step in GitHub App settings, documented in the tasks.

## Affected Areas

| Area                                          | Impact   | Description                                                          |
| --------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `apps/server/src/routes/oauth.ts`             | Modified | Change `scope: ''` to `scope: 'public_repo'`                         |
| `apps/server/src/routes/api.ts`               | Modified | Add `GET /api/runner/status` and `POST /api/runner/create` endpoints |
| `apps/server/src/github/runner.ts`            | Modified | Add `createRunnerRepo()` function using template generate API        |
| `apps/dashboard/src/pages/GlobalSettings.tsx` | Modified | Add Runner section with enable button and status display             |
| `apps/dashboard/src/lib/`                     | Modified | Add API client functions for runner endpoints                        |
| `apps/server/src/routes/api.test.ts`          | Modified | Add tests for new endpoints                                          |
| `docs/security.md`                            | Modified | Document `public_repo` scope and its implications                    |
| `docs/self-hosted.md`                         | Modified | Update runner setup instructions                                     |
| `docs/quick-start.md`                         | Modified | Simplify onboarding flow (no manual repo creation)                   |
| `docs/runner-architecture.md`                 | Modified | Update architecture to reflect auto-creation flow                    |
| GitHub App settings (manual)                  | Modified | Remove `Administration: R&W` and `Contents: R&W` permissions         |

## Risks

| Risk                                                                                   | Likelihood                | Mitigation                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_repo` scope grants write access to ALL user's public repos (GitHub limitation) | High (inherent)           | Document clearly in security docs and in the Dashboard UI before the user clicks "Enable Runner". This is a known GitHub OAuth limitation — there is no finer-grained scope for "create repos only". |
| User already has a `ghagga-runner` repo (from manual setup or another tool)            | Medium                    | Check with `discoverRunnerRepo()` before creating. Return friendly 409 "already exists" with link to the repo.                                                                                       |
| Existing users' tokens lack `public_repo` scope (authenticated before scope change)    | High (all existing users) | Detect 403 from template generate API → return `insufficient_scope` error → Dashboard shows "Re-authenticate" button that restarts Device Flow with new scope.                                       |
| Template repo `JNZader/ghagga-runner-template` is deleted or made private              | Low                       | Check template existence at endpoint level. Return clear error. Document that the template must remain public.                                                                                       |
| GitHub rate limits on template generation API                                          | Low                       | The generate endpoint has standard rate limits (5000/hr for authenticated users). One call per user onboarding is negligible.                                                                        |
| Race condition: user clicks "Enable Runner" twice quickly                              | Low                       | Server-side: check existence before creating. Client-side: disable button during creation. 422 from GitHub if race occurs → handle gracefully.                                                       |
| Runner repo created but secret setup fails (partial state)                             | Low                       | Return partial success with instructions to retry. The `GET /api/runner/status` endpoint will show the repo exists, and the Dashboard can offer a "Configure Secrets" retry button.                  |

## Rollback Plan

1. **OAuth scope**: Revert `scope: 'public_repo'` back to `scope: ''` in `oauth.ts`. Existing tokens continue working (GitHub doesn't revoke on scope reduction). New authentications will get empty scope.
2. **Server endpoints**: Remove the two new endpoints from `api.ts` and `createRunnerRepo()` from `runner.ts`. No database changes involved — this feature is stateless on our side.
3. **Dashboard UI**: Remove the Runner section from `GlobalSettings.tsx`. Revert to manual setup instructions.
4. **GitHub App permissions**: Re-add `Administration: R&W` and `Contents: R&W` if needed (manual step).
5. **Existing runner repos created by this feature**: They continue working — they're standard GitHub repos owned by the user. No cleanup needed.
6. **Documentation**: Revert doc changes to reference manual template setup.

No database migrations, no destructive changes. Fully reversible.

## Dependencies

- Template repo `JNZader/ghagga-runner-template` MUST remain public and accessible
- GitHub Template Repository API (`POST /repos/{template_owner}/{template_repo}/generate`) — stable, GA since 2019
- Existing `setRunnerSecret()` and `discoverRunnerRepo()` functions in `runner.ts` (no changes to their signatures)
- `libsodium-wrappers` (already a dependency, used by `setRunnerSecret()` for sealed-box encryption)

## Distribution Mode Impact

| Mode               | Impact                                                             |
| ------------------ | ------------------------------------------------------------------ |
| **SaaS**           | Primary target — this is a Dashboard feature                       |
| **GitHub Action**  | No impact — Action mode uses the App installation token, not OAuth |
| **CLI**            | No impact — CLI uses local config, not the Dashboard               |
| **1-click deploy** | No impact — self-hosted users configure their own runner setup     |

## Success Criteria

- [ ] User clicks "Enable Runner" in Dashboard → `ghagga-runner` repo is created in their GitHub account from `JNZader/ghagga-runner-template`
- [ ] Runner repo is created as **public** (for free GitHub Actions minutes)
- [ ] Runner secret (`GHAGGA_CALLBACK_SECRET`) is automatically configured after creation
- [ ] If `ghagga-runner` repo already exists, Dashboard shows friendly "already set up" message with link
- [ ] OAuth scope is `public_repo` for new authentications
- [ ] Users with old tokens (empty scope) see a "Re-authenticate" prompt when trying to enable the runner
- [ ] GitHub App permissions reduced: no `Administration: R&W` or `Contents: R&W`
- [ ] `docs/security.md` documents the `public_repo` scope implications
- [ ] `docs/quick-start.md` reflects the simplified onboarding (no manual repo creation)
- [ ] Tests cover: successful creation, already-exists case, insufficient scope, template not found
- [ ] Zero impact on CLI, Action, and 1-click deploy distribution modes
