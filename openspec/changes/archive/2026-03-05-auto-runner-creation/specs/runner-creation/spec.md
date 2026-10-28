# Delta for Runner Repo Lifecycle — Auto-Creation via Dashboard OAuth

This delta spec **supersedes** the "Runner Repo Auto-Creation on Installation" requirement from the `actions-runner-architecture` change. Runner repo creation moves from an automatic webhook-triggered flow (GitHub App creates repos on `installation.created`) to a user-initiated flow via the Dashboard using the user's own OAuth token.

---

## MODIFIED Requirements

### Requirement: Runner Repo Creation via Dashboard

Previously: The system automatically created `{owner}/ghagga-runner` when the GitHub App was installed, using the App's installation token with `Administration: R&W` and `Contents: R&W` permissions.

The system MUST allow users to create the `{owner}/ghagga-runner` repository on-demand from the Dashboard via a `POST /api/runner/create` endpoint. The system MUST use the user's OAuth token (obtained via GitHub Device Flow with `public_repo` scope) to call the GitHub Template Repository API. The system MUST NOT use the GitHub App installation token for repository creation.

#### Scenario: Fresh user enables runner — happy path

- GIVEN a user "alice" is authenticated in the Dashboard with an OAuth token that has `public_repo` scope
- AND no repository named `alice/ghagga-runner` exists
- WHEN alice clicks "Enable Runner" (triggers `POST /api/runner/create`)
- THEN the server MUST call `POST /repos/JNZader/ghagga-runner-template/generate` with alice's OAuth token
- AND the request MUST specify `owner: "alice"`, `name: "ghagga-runner"`, `private: false`
- AND the server MUST wait for the repo to become accessible (poll `GET /repos/alice/ghagga-runner` with retries, max 10 seconds)
- AND the server MUST call `setRunnerSecret()` to configure `GHAGGA_CALLBACK_SECRET` on the new repo
- AND the server MUST return HTTP 201 with `{ created: true, repoFullName: "alice/ghagga-runner" }`

#### Scenario: Organization user enables runner

- GIVEN a user "bob" is authenticated and belongs to organization "acme-corp"
- AND bob's OAuth token has `public_repo` scope
- AND no repository named `acme-corp/ghagga-runner` exists
- WHEN bob triggers `POST /api/runner/create` with `owner: "acme-corp"`
- THEN the server MUST use bob's OAuth token to create `acme-corp/ghagga-runner` from the template
- AND the repo MUST be public
- AND bob MUST have permission to create repos in the "acme-corp" organization (GitHub enforces this)
- AND if bob lacks org repo creation permission, the GitHub API MUST return 403 and the server MUST return `{ error: "org_permission_denied", message: "You don't have permission to create repositories in acme-corp" }`

#### Scenario: Runner repo already exists — detected before create

- GIVEN user "alice" already has a repository `alice/ghagga-runner`
- WHEN alice triggers `POST /api/runner/create`
- THEN the server MUST first call `discoverRunnerRepo("alice", token)`
- AND the server MUST detect the repo already exists
- AND the server MUST return HTTP 409 with `{ error: "already_exists", repoFullName: "alice/ghagga-runner" }`
- AND the server MUST NOT attempt to call the template generate API

#### Scenario: Runner repo already exists — GitHub returns 422

- GIVEN user "alice" triggers `POST /api/runner/create`
- AND the `discoverRunnerRepo()` check passes (repo not found, possibly due to a race condition)
- WHEN the template generate API returns HTTP 422 (name already taken)
- THEN the server MUST handle this as a non-error condition
- AND the server MUST return HTTP 409 with `{ error: "already_exists", repoFullName: "alice/ghagga-runner" }`

#### Scenario: Runner secret auto-configuration after creation

- GIVEN the server successfully created `alice/ghagga-runner` from the template
- WHEN the creation step completes
- THEN the server MUST call `setRunnerSecret("alice/ghagga-runner", "GHAGGA_CALLBACK_SECRET", <secret>, token)`
- AND the secret MUST be encrypted using libsodium sealed box (existing `setRunnerSecret()` behavior)
- AND if the secret setup fails, the server MUST return HTTP 201 with `{ created: true, secretConfigured: false, repoFullName: "alice/ghagga-runner" }`
- AND the Dashboard MUST show a warning that secret configuration failed with a "Retry" option

#### Scenario: Runner secret refresh on existing repo

- GIVEN user "alice" already has `alice/ghagga-runner`
- AND alice wants to refresh the runner secret (e.g., via a "Reconfigure" button)
- WHEN alice triggers `POST /api/runner/configure-secret`
- THEN the server MUST call `setRunnerSecret()` to set a fresh `GHAGGA_CALLBACK_SECRET`
- AND the server MUST return HTTP 200 with `{ configured: true }`

#### Scenario: Created repo MUST be public

- GIVEN a user triggers runner creation
- WHEN the template generate API is called
- THEN the request body MUST include `private: false`
- AND the server MUST verify the created repo is public by checking the API response
- AND if the repo was somehow created as private (e.g., org policy forces private repos), the server MUST return a warning: `{ created: true, warning: "repo_is_private", message: "The runner repo was created as private. Private repos consume your GitHub Actions minutes quota (2000 min/month)." }`

#### Scenario: Concurrent "Enable Runner" clicks (idempotency)

- GIVEN user "alice" clicks "Enable Runner" twice in rapid succession
- WHEN both `POST /api/runner/create` requests arrive
- THEN the first request MUST proceed normally and create the repo
- AND the second request MUST detect the repo already exists (either via `discoverRunnerRepo()` or GitHub's 422)
- AND the second request MUST return HTTP 409 `{ error: "already_exists" }` — NOT an error to the user
- AND the Dashboard MUST handle 409 as a success condition

---

## ADDED Requirements

### Requirement: OAuth Scope for Repository Creation

The GitHub Device Flow OAuth request MUST include the `public_repo` scope to enable runner repo creation via the user's token.

#### Scenario: New user authenticates with public_repo scope

- GIVEN a new user starts the GitHub Device Flow from the Dashboard
- WHEN the server proxies `POST /auth/device/code` to GitHub
- THEN the request body MUST include `scope: "public_repo"`
- AND the GitHub authorization page MUST show the user that GHAGGA requests `public_repo` access
- AND upon successful authentication, the user's token MUST have the `public_repo` scope

#### Scenario: Existing user has token without public_repo scope

- GIVEN user "alice" authenticated before the scope change (her token has empty scope)
- WHEN alice tries to enable the runner (`POST /api/runner/create`)
- AND the template generate API returns HTTP 403 (insufficient scope)
- THEN the server MUST return HTTP 403 with `{ error: "insufficient_scope", message: "Your token doesn't have permission to create repositories. Please re-authenticate." }`
- AND the Dashboard MUST show a "Re-authenticate" button
- AND clicking "Re-authenticate" MUST restart the Device Flow with `scope: "public_repo"`
- AND after re-authentication, the Dashboard MUST retry the runner creation automatically

#### Scenario: Token expired or revoked between status check and create

- GIVEN user "alice" has a valid session in the Dashboard
- AND her OAuth token is revoked on GitHub (e.g., via GitHub settings)
- WHEN alice triggers `POST /api/runner/create`
- THEN the auth middleware MUST detect the invalid token (GitHub `/user` API returns 401)
- AND the server MUST return HTTP 401
- AND the Dashboard MUST redirect alice to the login flow

### Requirement: Runner Status Check Endpoint

The system MUST provide a `GET /api/runner/status` endpoint that reports whether the authenticated user's runner repo exists.

#### Scenario: Runner repo exists

- GIVEN user "alice" has a repository `alice/ghagga-runner`
- WHEN the Dashboard loads and calls `GET /api/runner/status`
- THEN the server MUST call `discoverRunnerRepo("alice", token)`
- AND the server MUST return HTTP 200 with `{ exists: true, repoFullName: "alice/ghagga-runner" }`

#### Scenario: Runner repo does not exist

- GIVEN user "alice" does NOT have a repository `alice/ghagga-runner`
- WHEN the Dashboard loads and calls `GET /api/runner/status`
- THEN the server MUST return HTTP 200 with `{ exists: false }`

#### Scenario: Runner repo exists but is private

- GIVEN user "alice" has a PRIVATE repository `alice/ghagga-runner`
- WHEN the Dashboard calls `GET /api/runner/status`
- THEN the server MUST return HTTP 200 with `{ exists: true, repoFullName: "alice/ghagga-runner", isPrivate: true, warning: "Runner repo is private — GitHub Actions minutes will be consumed from your quota (2000 min/month for free accounts)." }`

#### Scenario: GitHub API error during status check

- GIVEN the GitHub API is temporarily unavailable (5xx)
- WHEN the Dashboard calls `GET /api/runner/status`
- THEN the server MUST return HTTP 502 with `{ error: "github_unavailable", message: "Could not check runner status. Please try again." }`

### Requirement: Dashboard Runner UI

The Dashboard MUST display a Runner section in the Global Settings page that shows the runner status and provides actions to create or manage the runner repo.

#### Scenario: Dashboard shows "not configured" state

- GIVEN user "alice" has no `ghagga-runner` repo
- WHEN alice opens the Global Settings page
- THEN the Dashboard MUST display a Runner section with:
  - A heading "Static Analysis Runner"
  - An explanation that GHAGGA uses a GitHub Actions runner for static analysis
  - A note about the `public_repo` scope requirement and its implications
  - An "Enable Runner" button (primary action)

#### Scenario: Dashboard shows "creating" state

- GIVEN user "alice" clicked "Enable Runner"
- WHEN the `POST /api/runner/create` request is in progress
- THEN the button MUST be disabled
- AND a spinner/loading indicator MUST be shown
- AND the text MUST say "Creating runner repository..."
- AND no other actions in the Runner section MUST be clickable

#### Scenario: Dashboard shows "enabled" state

- GIVEN `GET /api/runner/status` returns `{ exists: true, repoFullName: "alice/ghagga-runner" }`
- WHEN the Global Settings page renders the Runner section
- THEN the Dashboard MUST display:
  - A green status indicator (checkmark or badge)
  - The text "Runner enabled" with a link to `https://github.com/alice/ghagga-runner`
  - A "Reconfigure Secret" button (secondary action)

#### Scenario: Dashboard shows "needs re-auth" state

- GIVEN `POST /api/runner/create` returned `{ error: "insufficient_scope" }`
- WHEN the Dashboard handles the error
- THEN the Dashboard MUST display:
  - A warning message: "Your session needs to be refreshed to enable the runner."
  - A brief explanation of why re-authentication is needed
  - A "Re-authenticate" button
- AND the "Enable Runner" button MUST be hidden

#### Scenario: Dashboard shows error state with retry

- GIVEN `POST /api/runner/create` returned a 5xx or network error
- WHEN the Dashboard handles the error
- THEN the Dashboard MUST display:
  - An error message: "Failed to create runner repository. Please try again."
  - A "Retry" button
- AND the error MUST be dismissible

#### Scenario: Dashboard shows private repo warning

- GIVEN `GET /api/runner/status` returns `{ exists: true, isPrivate: true, warning: "..." }`
- WHEN the Global Settings page renders
- THEN the Dashboard MUST display a yellow warning banner with the private repo message
- AND the runner SHOULD still be shown as "enabled" (it works, just costs money)

### Requirement: Template Repository Availability

The system MUST handle the case where the template repository `JNZader/ghagga-runner-template` is unavailable.

#### Scenario: Template repo not found (deleted or private)

- GIVEN the template `JNZader/ghagga-runner-template` has been deleted or made private
- WHEN a user triggers `POST /api/runner/create`
- AND the template generate API returns HTTP 404
- THEN the server MUST return HTTP 502 with `{ error: "template_unavailable", message: "The runner template is temporarily unavailable. Please try again later or contact support." }`
- AND the server MUST log a critical error: "Runner template repo JNZader/ghagga-runner-template is not accessible"

#### Scenario: Template generate API rate limited

- GIVEN the user's token has hit GitHub API rate limits
- WHEN the template generate API returns HTTP 403 with rate limit headers
- THEN the server MUST distinguish between rate limiting and insufficient scope
- AND the server MUST check the `X-RateLimit-Remaining` header
- AND if rate limited, the server MUST return HTTP 429 with `{ error: "rate_limited", retryAfter: <seconds> }`

### Requirement: GitHub App Permission Reduction

After this change is deployed, the GitHub App MUST have its permissions reduced to remove `Administration: Read & Write` and `Contents: Read & Write`.

#### Scenario: Permissions reduced after deployment

- GIVEN the auto-runner-creation feature is deployed and verified
- WHEN the GitHub App settings are updated (manual step)
- THEN `Administration: Read & Write` MUST be removed
- AND `Contents: Read & Write` MUST be removed
- AND the remaining permissions MUST be: Pull requests R&W, Actions Write, Secrets R&W, Metadata Read (auto)
- AND existing installations MUST receive a permission update prompt from GitHub
- AND the system MUST continue functioning without the removed permissions

#### Scenario: Permission reduction does not break existing functionality

- GIVEN the GitHub App permissions have been reduced
- WHEN a review is triggered on `alice/my-project`
- THEN the review pipeline MUST function normally (PR comments, dispatch, secret setting)
- AND runner repo discovery (`discoverRunnerRepo()`) MUST still work (uses OAuth token, not App token)
- AND workflow dispatch MUST still work (uses OAuth token with Actions Write)

### Requirement: Documentation Updates

The project documentation MUST be updated to reflect the new runner creation flow, OAuth scope, and permission changes.

#### Scenario: Security documentation updated

- GIVEN `docs/security.md` exists
- WHEN the change is complete
- THEN the document MUST include a section explaining:
  - The `public_repo` OAuth scope and why it's needed
  - That `public_repo` grants write access to all user's public repos (GitHub limitation)
  - That the token is only used server-side for the template generate call
  - That the GitHub App permissions have been reduced

#### Scenario: Quick-start documentation updated

- GIVEN `docs/quick-start.md` exists
- WHEN the change is complete
- THEN the manual "create runner from template" step MUST be replaced with "Click 'Enable Runner' in the Dashboard"
- AND the document MUST mention the `public_repo` scope authorization prompt

#### Scenario: Self-hosted documentation updated

- GIVEN `docs/self-hosted.md` exists
- WHEN the change is complete
- THEN the document MUST explain that self-hosted users can still create the runner manually from the template
- AND the auto-creation feature MUST be documented as a SaaS-only convenience

#### Scenario: Runner architecture documentation updated

- GIVEN `docs/runner-architecture.md` exists
- WHEN the change is complete
- THEN the document MUST describe the new creation flow (Dashboard → OAuth → Template Generate API)
- AND the document MUST explain the shift from App-based to OAuth-based repo creation
- AND any diagrams showing the old flow MUST be updated

---

## REMOVED Requirements

### Requirement: Runner Repo Auto-Creation on Installation

(Reason: Runner repo creation is moving from an automatic App-triggered flow to a user-initiated Dashboard flow. The `installation.created` webhook handler will no longer create runner repos. Users create repos on-demand via the Dashboard, which provides better UX — users must visit the Dashboard anyway to configure API keys, and the "Enable Runner" button makes the action explicit and transparent.)

### Requirement: Runner Repo Deletion on Uninstall

(Reason: Since the runner repo is now created by the user's own OAuth token and owned by the user, GHAGGA SHOULD NOT delete user-owned repos on uninstall. The user owns the repo and can delete it themselves. This also removes the need for `Administration: R&W` on the GitHub App.)

---

## Acceptance Criteria Summary

| ID     | Requirement                     | Criteria                                                                                | Priority |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| ARC-01 | OAuth Scope Upgrade             | Device Flow requests `public_repo` scope; tokens grant repo creation ability            | P0       |
| ARC-02 | Runner Create Endpoint          | `POST /api/runner/create` creates repo from template, sets secret, returns 201          | P0       |
| ARC-03 | Runner Status Endpoint          | `GET /api/runner/status` returns `{ exists, repoFullName?, isPrivate? }`                | P0       |
| ARC-04 | Secret Auto-Configuration       | `setRunnerSecret()` called after creation; partial failure handled gracefully           | P0       |
| ARC-05 | Dashboard Runner UI             | Five states rendered correctly: not-configured, creating, enabled, needs-re-auth, error | P0       |
| ARC-06 | Scope Mismatch Detection        | 403 from template API → `insufficient_scope` error → re-auth prompt                     | P0       |
| ARC-07 | Existing Repo Handling          | 409 returned when repo exists; Dashboard treats as success                              | P1       |
| ARC-08 | Repo Must Be Public             | `private: false` in template generate call; warning if org forces private               | P0       |
| ARC-09 | Idempotent Create               | Concurrent clicks produce at most one repo; no errors shown to user                     | P1       |
| ARC-10 | Template Unavailable            | 404 from template → 502 to client with clear message; critical log                      | P1       |
| ARC-11 | Rate Limit Handling             | Distinguish rate limit from scope error; return 429 with retry-after                    | P2       |
| ARC-12 | Private Repo Warning            | Status endpoint reports `isPrivate: true` with billing warning                          | P2       |
| ARC-13 | GitHub App Permission Reduction | Remove Admin R&W and Contents R&W; documented manual step                               | P1       |
| ARC-14 | Documentation Updates           | security.md, quick-start.md, self-hosted.md, runner-architecture.md updated             | P1       |
| ARC-15 | Secret Refresh                  | Separate endpoint or action to reconfigure secret on existing repo                      | P2       |
| ARC-16 | Org Repo Creation               | Works for org owners; clear error for users without org repo-create permission          | P2       |
