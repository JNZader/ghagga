# API Reference

The GHAGGA server exposes a REST API for the dashboard, a webhook endpoint for GitHub, and authentication routes for dashboard OAuth Web Flow plus CLI-compatible Device Flow.

**Base URL**: `https://your-server.example.com` (default port `3000` in development)

## Authentication

All `/api/*` endpoints require a GitHub access token:

```
Authorization: Bearer <github_token>
```

The server calls `GET https://api.github.com/user` to verify the token and resolve the user's identity. It then looks up which GHAGGA installations the user belongs to — only data from those installations is accessible.

**Unauthenticated endpoints**: `/health`, `/webhook`, `/auth/*`.

## Response Format

### Success (GET endpoints)

```json
{
  "data": { ... },
  "pagination": { "page": 1, "limit": 50, "offset": 0 }
}
```

The `pagination` field is only present on paginated endpoints. Non-paginated GETs return `{ "data": ... }` only.

### Success (PUT/POST mutations)

```json
{ "data": { "message": "Settings updated" } }
```

### Errors

```json
{ "error": "Human-readable error message" }
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing/invalid parameters or body |
| `401` | Unauthorized — missing, invalid, or expired token |
| `403` | Forbidden — user doesn't have access to this installation/repo |
| `404` | Not found — repository or resource doesn't exist |
| `500` | Internal server error — includes `errorId` for support correlation |

All `500` responses include an `errorId` (8-char UUID) that is also logged server-side, enabling support ticket correlation:

```json
{ "error": "FETCH_FAILED", "message": "Internal server error", "errorId": "a1b2c3d4" }
```

---

## Health Check

```
GET /health
```

No authentication required.

**Response** `200`:

```json
{
  "status": "ok",
  "timestamp": "2025-01-15T12:00:00.000Z"
}
```

---

## GitHub Webhook

```
POST /webhook
```

Receives GitHub webhook events. No bearer auth — validated via HMAC-SHA256 signature.

**Required Headers**:

| Header | Description |
|--------|-------------|
| `X-Hub-Signature-256` | HMAC-SHA256 signature of the raw body using the webhook secret |
| `X-GitHub-Event` | Event type: `pull_request`, `installation`, `installation_repositories` |

**Handled Events**:

| Event | Actions | Behavior |
|-------|---------|----------|
| `pull_request` | `opened`, `synchronize`, `reopened` | Enqueues an AI review job via BullMQ |
| `installation` | `created` | Tracks the installation and its repositories |
| `installation` | `deleted` | Deactivates the installation |
| `installation_repositories` | `added`, `removed` | Updates tracked repositories |

**Response** (pull_request) `202`:

```json
{
  "message": "Review dispatched",
  "reviewId": "a1b2c3d4",
  "pr": 42,
  "repo": "owner/repo"
}
```

Other events return `200` with a `message` field.

---

## Runner Callback

```
POST /runner/callback
```

Receives static analysis results from a delegated GitHub Actions runner. No bearer auth — validated via HMAC-SHA256 signature.

**Required Headers**:

| Header | Description |
|--------|-------------|
| `X-Runner-Signature` | HMAC-SHA256 signature of the raw body using the per-dispatch callback secret |
| `Content-Type` | `application/json` |

**Body**:

```json
{
  "callbackId": "uuid-of-the-dispatch",
  "findings": [
    {
      "source": "semgrep",
      "severity": "high",
      "file": "src/index.ts",
      "line": 42,
      "message": "Possible SQL injection"
    }
  ],
  "toolVersions": {
    "semgrep": "1.56.0",
    "trivy": "0.69.3",
    "cpd": "7.9.0"
  },
  "durationMs": 17900
}
```

| Field | Type | Description |
|-------|------|-------------|
| `callbackId` | `string` | UUID matching the dispatch (links callback to the waiting job) |
| `findings` | `array` | Static analysis findings with source, severity, file, line, message |
| `toolVersions` | `object` | Versions of tools that ran |
| `durationMs` | `number` | Total analysis duration in milliseconds |

**Response** `200` (success):

```json
{ "message": "Findings received" }
```

**Response** `401` (invalid signature):

```json
{ "error": "Invalid signature" }
```

**Response** `404` (unknown callback ID — expired or already delivered):

```json
{ "error": "Unknown callback" }
```

---

## OAuth Web Flow (Dashboard)

These endpoints power the dashboard login flow. They require `STATE_SECRET`, and `/auth/callback` also requires `GITHUB_CLIENT_SECRET` on the server.

### Start Login

```
GET /auth/login
```

Redirects the browser to GitHub's OAuth authorize URL with an HMAC-signed `state` parameter.

**Response**: `302` redirect to `https://github.com/login/oauth/authorize?...`

### OAuth Callback

```
GET /auth/callback
```

Validates the signed `state`, exchanges the authorization `code` for a GitHub access token, and redirects back to the dashboard hash route.

**Success response**: `302` redirect to `https://jnzader.github.io/ghagga/app/#/auth/callback?token=...`

**Failure response**: `302` redirect to `https://jnzader.github.io/ghagga/app/#/auth/callback?error=...`

---

## OAuth Proxy (Device Flow, CLI compatibility)

These endpoints proxy GitHub's OAuth Device Flow. They remain available for CLI compatibility and non-browser clients. **No authentication required**.

### Request Device Code

```
POST /auth/device/code
```

Proxies to `https://github.com/login/device/code` with the GHAGGA OAuth App Client ID.

**Response** `200`:

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

### Poll for Access Token

```
POST /auth/device/token
```

Polls GitHub for an access token after the user enters their code.

**Body**:

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5"
}
```

**Response** `200` (success — user authorized):

```json
{
  "access_token": "ghu_xxxxxxxxxxxx",
  "token_type": "bearer",
  "scope": ""
}
```

**Response** `200` (pending — user hasn't entered code yet):

```json
{
  "error": "authorization_pending"
}
```

---

## Dashboard API

All endpoints below require `Authorization: Bearer <github_token>`.

### List Repositories

```
GET /api/repositories
```

Returns all repositories across the user's accessible installations.

**Response** `200`:

```json
{
  "data": [
    {
      "id": 1,
      "githubRepoId": 12345,
      "fullName": "owner/repo",
      "installationId": 100,
      "isActive": true,
      "reviewMode": "simple",
      "aiReviewEnabled": true
    }
  ]
}
```

### List Installations

```
GET /api/installations
```

Returns installations the authenticated user has access to.

**Response** `200`:

```json
{
  "data": [
    {
      "id": 100,
      "accountLogin": "my-org",
      "accountType": "Organization"
    }
  ]
}
```

### List Reviews

```
GET /api/reviews?repo=owner/repo&page=1&limit=50
```

Returns review history for a repository, paginated.

**Query Parameters**:

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `repo` | Yes | — | Full repository name (`owner/repo`) |
| `page` | No | `1` | Page number (1-indexed) |
| `limit` | No | `50` | Items per page (max `100`) |

**Response** `200`:

```json
{
  "data": [
    {
      "id": 1,
      "prNumber": 42,
      "status": "PASSED",
      "reviewMode": "simple",
      "createdAt": "2025-01-15T12:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "offset": 0
  }
}
```

### Review Statistics

```
GET /api/stats?repo=owner/repo
```

Returns aggregate review statistics for a repository.

**Query Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `repo` | Yes | Full repository name (`owner/repo`) |

**Response** `200`:

```json
{
  "data": {
    "totalReviews": 150,
    "passed": 120,
    "failed": 10,
    "needsHumanReview": 15,
    "skipped": 5,
    "passRate": 80.0,
    "reviewsByDay": []
  }
}
```

### Get Repository Settings

```
GET /api/settings?repo=owner/repo
```

Returns the settings for a specific repository, including its resolved global settings for reference.

**Query Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `repo` | Yes | Full repository name (`owner/repo`) |

**Response** `200`:

```json
{
  "data": {
    "repoId": 1,
    "repoFullName": "owner/repo",
    "useGlobalSettings": false,
    "aiReviewEnabled": true,
    "reviewMode": "simple",
    "providerChain": [
      {
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514",
        "hasApiKey": true,
        "maskedApiKey": "sk-...xYzW"
      }
    ],
    "enableSemgrep": true,
    "enableTrivy": true,
    "enableCpd": true,
    "enableMemory": true,
    "enabledTools": ["semgrep", "trivy", "cpd", "gitleaks", "shellcheck"],
    "disabledTools": ["psalm"],
    "registeredTools": ["semgrep", "trivy", "cpd", "gitleaks", "shellcheck", "markdownlint", "lizard", "ruff", "bandit", "golangci-lint", "biome", "pmd", "psalm", "clippy", "hadolint"],
    "customRules": "rule1\nrule2",
    "ignorePatterns": ["*.test.ts", "docs/**"],
    "globalSettings": {
      "providerChain": [
        {
          "provider": "github",
          "model": "gpt-4o-mini",
          "hasApiKey": false
        }
      ],
      "aiReviewEnabled": true,
      "reviewMode": "simple",
      "enableSemgrep": true,
      "enableTrivy": true,
      "enableCpd": true,
      "enableMemory": true,
      "enabledTools": [],
      "disabledTools": [],
      "customRules": "",
      "ignorePatterns": []
    }
  }
}
```

> **Note**: API keys are never returned in plain text. The `maskedApiKey` field shows the first 3 and last 4 characters (e.g., `sk-...xYzW`). The `hasApiKey` boolean indicates whether a key is stored.

> **Deprecated**: `enableSemgrep`, `enableTrivy`, and `enableCpd` are deprecated since v2.5.0. Use `enabledTools`/`disabledTools` instead to control individual tools from the 15-tool plugin registry. The legacy boolean fields still work but will be removed in a future version.

### Update Repository Settings

```
PUT /api/settings
```

Updates configuration for a repository. Supports partial updates — only include fields you want to change.

**Body**:

```json
{
  "repoFullName": "owner/repo",
  "useGlobalSettings": false,
  "aiReviewEnabled": true,
  "reviewMode": "workflow",
  "providerChain": [
    { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "apiKey": "sk-ant-..." },
    { "provider": "github", "model": "gpt-4o-mini" }
  ],
  "enableSemgrep": true,
  "enableTrivy": true,
  "enableCpd": false,
  "enableMemory": true,
  "enabledTools": ["semgrep", "trivy", "gitleaks"],
  "disabledTools": ["cpd"],
  "customRules": "rule1\nrule2",
  "ignorePatterns": ["*.test.ts", "docs/**"]
}
```

**Body Fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repoFullName` | `string` | Yes | Full repository name (`owner/repo`) |
| `useGlobalSettings` | `boolean` | No | Use installation-level settings instead of per-repo |
| `aiReviewEnabled` | `boolean` | No | Enable/disable AI review |
| `reviewMode` | `string` | No | Review mode: `simple`, `workflow`, `consensus` |
| `providerChain` | `array` | No | Ordered list of LLM providers (see below) |
| `enableSemgrep` | `boolean` | No | **Deprecated.** Enable Semgrep static analysis. Use `enabledTools`/`disabledTools` instead |
| `enableTrivy` | `boolean` | No | **Deprecated.** Enable Trivy vulnerability scanning. Use `enabledTools`/`disabledTools` instead |
| `enableCpd` | `boolean` | No | **Deprecated.** Enable copy-paste detection. Use `enabledTools`/`disabledTools` instead |
| `enableMemory` | `boolean` | No | Enable project memory |
| `enabledTools` | `string[]` | No | Tools to force-enable (e.g., `["semgrep", "gitleaks"]`). Overrides registry defaults |
| `disabledTools` | `string[]` | No | Tools to force-disable (e.g., `["cpd", "psalm"]`). Overrides registry defaults |
| `customRules` | `string` | No | Custom review rules (newline-separated) |
| `ignorePatterns` | `string[]` | No | Glob patterns for files to skip |
| `reviewLevel` | `string` | No | Review thoroughness level |

**Provider Chain Entries**:

```json
{ "provider": "anthropic", "model": "claude-sonnet-4-20250514", "apiKey": "sk-ant-..." }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | Yes | One of: `github`, `anthropic`, `openai`, `google`, `qwen`, `groq`, `cerebras`, `deepseek`, `openrouter` |
| `model` | `string` | Yes | Model identifier (e.g., `gpt-4o-mini`, `claude-sonnet-4-20250514`) |
| `apiKey` | `string` | No | API key (omit to keep existing key; `github` provider never needs one) |

> **API Key Behavior**: When you send a `providerChain` entry without an `apiKey`, the server preserves the previously stored encrypted key for that provider. Send a new `apiKey` to rotate it. The `github` provider uses the user's session token and never requires an API key.

> **Valid Providers**: `github`, `anthropic`, `openai`, `google`, `qwen`, `groq`, `cerebras`, `deepseek`, `openrouter`. The `ollama` provider is **not** available in the SaaS dashboard — use the CLI or GitHub Action instead.

**Response** `200`:

```json
{ "data": { "message": "Settings updated" } }
```

### Get Installation Settings (Global)

```
GET /api/installation-settings?installation_id=123
```

Returns the global (installation-level) settings that apply as defaults to all repositories in the installation.

**Query Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `installation_id` | Yes | Numeric installation ID |

**Response** `200`:

```json
{
  "data": {
    "installationId": 123,
    "accountLogin": "my-org",
    "providerChain": [
      {
        "provider": "github",
        "model": "gpt-4o-mini",
        "hasApiKey": false
      }
    ],
    "aiReviewEnabled": true,
    "reviewMode": "simple",
    "enableSemgrep": true,
    "enableTrivy": true,
    "enableCpd": true,
    "enableMemory": true,
    "enabledTools": [],
    "disabledTools": [],
    "registeredTools": ["semgrep", "trivy", "cpd", "gitleaks", "shellcheck", "markdownlint", "lizard", "ruff", "bandit", "golangci-lint", "biome", "pmd", "psalm", "clippy", "hadolint"],
    "customRules": "",
    "ignorePatterns": []
  }
}
```

### Update Installation Settings (Global)

```
PUT /api/installation-settings
```

Updates the global settings for an installation. These settings apply to all repositories that have `useGlobalSettings: true`.

**Body**:

```json
{
  "installationId": 123,
  "providerChain": [
    { "provider": "github", "model": "gpt-4o-mini" }
  ],
  "aiReviewEnabled": true,
  "reviewMode": "simple",
  "enableSemgrep": true,
  "enableTrivy": true,
  "enableCpd": true,
  "enableMemory": true,
  "enabledTools": ["semgrep", "trivy", "cpd", "gitleaks"],
  "disabledTools": [],
  "customRules": "rule1\nrule2",
  "ignorePatterns": ["*.test.ts"],
  "reviewLevel": "standard"
}
```

**Body Fields**: Same as [Update Repository Settings](#update-repository-settings), except `installationId` (number, required) replaces `repoFullName`, and there is no `useGlobalSettings` field.

**Response** `200`:

```json
{ "data": { "message": "Installation settings updated" } }
```

### List Memory Sessions

```
GET /api/memory/sessions?project=owner/repo
```

Returns memory sessions (one per review) for a project.

**Query Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `project` | Yes | Full repository name (`owner/repo`) |

**Response** `200`:

```json
{
  "data": [
    {
      "id": 1,
      "project": "owner/repo",
      "prNumber": 42,
      "createdAt": "2025-01-15T12:00:00.000Z"
    }
  ]
}
```

### List Session Observations

```
GET /api/memory/sessions/:id/observations
```

Returns all observations (learned facts) from a specific memory session.

**Path Parameters**:

| Parameter | Description |
|-----------|-------------|
| `id` | Numeric session ID |

**Response** `200`:

```json
{
  "data": [
    {
      "id": 1,
      "sessionId": 1,
      "type": "pattern",
      "content": "This project uses barrel exports in src/index.ts",
      "severity": null,
      "createdAt": "2025-01-15T12:00:00.000Z"
    }
  ]
}
```

### Delete Observation

```
DELETE /api/memory/observations/:id
```

Deletes a single observation by ID.

**Path Parameters**:

| Parameter | Description |
|-----------|-------------|
| `id` | Numeric observation ID |

**Response** `200`:

```json
{ "deleted": true }
```

**Response** `404`:

```json
{ "error": "Not found" }
```

### Clear Project Observations

```
DELETE /api/memory/projects/:project/observations
```

Deletes all observations for a specific project.

**Path Parameters**:

| Parameter | Description |
|-----------|-------------|
| `project` | Project identifier (`owner/repo`) |

**Response** `200`:

```json
{ "deleted": 42 }
```

### Purge All Observations

```
DELETE /api/memory/observations
```

Deletes **all** observations for the current installation.

**Response** `200`:

```json
{ "deleted": 128 }
```

### Delete Session

```
DELETE /api/memory/sessions/:id
```

Deletes a single memory session by ID.

**Path Parameters**:

| Parameter | Description |
|-----------|-------------|
| `id` | Numeric session ID |

**Response** `200`:

```json
{ "deleted": true }
```

**Response** `404`:

```json
{ "error": "Not found" }
```

### Clean Up Empty Sessions

```
DELETE /api/memory/sessions/empty
```

Deletes all sessions that have zero observations.

**Response** `200`:

```json
{ "deleted": 5 }
```

---

## CI Discovery

### Discover CI Jobs

```
GET /api/repositories/:repoId/discover-ci
```

Auto-discovers CI job configurations for a repository by analyzing its workflow files.

**Path Parameters**:

| Parameter | Description |
|-----------|-------------|
| `repoId` | Numeric repository ID |

**Response** `200`:

```json
{
  "data": {
    "jobs": [
      {
        "key": "lint",
        "name": "Lint",
        "profile": "node-lint",
        "classification": "safe/delegable"
      }
    ]
  }
}
```

---

## Delegated CI

### List Delegated CI Runs

```
GET /api/delegated-ci/runs
```

Returns delegated CI runs, optionally filtered by repository or PR.

**Query Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `repo` | No | Full repository name (`owner/repo`) |
| `pr` | No | Pull request number |
| `state` | No | Filter by state (e.g., `completed`, `failed`) |

**Response** `200`:

```json
{
  "data": [
    {
      "id": 1,
      "repositoryId": 10,
      "prNumber": 42,
      "jobKey": "lint",
      "classification": "safe/delegable",
      "state": "completed",
      "profile": "node-lint",
      "summary": "Lint passed",
      "createdAt": "2025-01-15T12:00:00.000Z"
    }
  ]
}
```

### Get Delegated CI Run

```
GET /api/delegated-ci/runs/:id
```

Returns a single delegated CI run by ID.

**Path Parameters**:

| Parameter | Description |
|-----------|-------------|
| `id` | Numeric run ID |

**Response** `200`:

```json
{
  "data": {
    "id": 1,
    "repositoryId": 10,
    "prNumber": 42,
    "jobKey": "lint",
    "classification": "safe/delegable",
    "state": "completed",
    "reasonCode": null,
    "reasonDetail": null,
    "callbackId": "uuid-123",
    "workflowRunId": 456,
    "profile": "node-lint",
    "summary": "Lint passed",
    "resultSummary": { "exitCode": 0, "durationMs": 12000 },
    "createdAt": "2025-01-15T12:00:00.000Z",
    "updatedAt": "2025-01-15T12:01:00.000Z"
  }
}
```

**Response** `404`:

```json
{ "error": "Not found" }
```

---

## Runner Management

### Check Runner Status

```
GET /api/runner/status
```

Checks whether the authenticated user's `ghagga-runner` repo exists.

**Response** `200`:

```json
{
  "data": {
    "exists": true,
    "fullName": "user/ghagga-runner"
  }
}
```

### Create Runner Repository

```
POST /api/runner/create
```

Creates a `ghagga-runner` repo from the template repository in the user's account.

**Response** `201`:

```json
{
  "data": {
    "fullName": "user/ghagga-runner",
    "url": "https://github.com/user/ghagga-runner"
  }
}
```

**Response** `409`:

```json
{ "error": "Runner repository already exists" }
```

### Configure Runner Secret

```
POST /api/runner/configure-secret
```

Sets the callback secret on the user's runner repository.

**Response** `200`:

```json
{ "data": { "message": "Secret configured" } }
```

---

## Provider Validation

### Validate Provider API Key

```
POST /api/providers/validate
```

Tests whether a provider API key is valid. Returns the list of available models if the key works.

**Body**:

```json
{
  "provider": "anthropic",
  "apiKey": "sk-ant-api03-..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | Yes | One of: `github`, `anthropic`, `openai`, `google`, `qwen`, `groq`, `cerebras`, `deepseek`, `openrouter` |
| `apiKey` | `string` | Conditional | Required for all providers except `github` (which uses the session token) |

**Response** `200` (valid key):

```json
{
  "valid": true,
  "models": ["claude-sonnet-4-20250514", "claude-haiku-4-20250414"]
}
```

**Response** `200` (invalid key):

```json
{
  "valid": false,
  "models": [],
  "error": "Validation request failed"
}
```

---

## Endpoint Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check |
| `POST` | `/webhook` | HMAC | GitHub webhook receiver |
| `POST` | `/runner/callback` | HMAC | Runner static analysis results |
| `GET` | `/auth/login` | No | Dashboard OAuth Web Flow -- redirect to GitHub |
| `GET` | `/auth/callback` | No | Dashboard OAuth Web Flow -- exchange code and redirect back |
| `POST` | `/auth/device/code` | No | OAuth Device Flow -- request codes |
| `POST` | `/auth/device/token` | No | OAuth Device Flow -- poll for token |
| `GET` | `/api/repositories` | Bearer | List user's repositories |
| `GET` | `/api/repositories/:repoId/discover-ci` | Bearer | Discover CI jobs for a repository |
| `GET` | `/api/installations` | Bearer | List user's installations |
| `GET` | `/api/reviews` | Bearer | List reviews (paginated) |
| `GET` | `/api/stats` | Bearer | Review statistics |
| `GET` | `/api/settings` | Bearer | Get repository settings |
| `PUT` | `/api/settings` | Bearer | Update repository settings |
| `GET` | `/api/installation-settings` | Bearer | Get global installation settings |
| `PUT` | `/api/installation-settings` | Bearer | Update global installation settings |
| `POST` | `/api/providers/validate` | Bearer | Validate provider API key |
| `GET` | `/api/delegated-ci/runs` | Bearer | List delegated CI runs |
| `GET` | `/api/delegated-ci/runs/:id` | Bearer | Get single delegated CI run |
| `GET` | `/api/runner/status` | Bearer | Check runner repo exists |
| `POST` | `/api/runner/create` | Bearer | Create runner from template |
| `POST` | `/api/runner/configure-secret` | Bearer | Set callback secret on runner |
| `GET` | `/api/memory/sessions` | Bearer | List memory sessions |
| `GET` | `/api/memory/sessions/:id/observations` | Bearer | List session observations |
| `DELETE` | `/api/memory/observations/:id` | Bearer | Delete a single observation |
| `DELETE` | `/api/memory/projects/:project/observations` | Bearer | Clear all observations for a project |
| `DELETE` | `/api/memory/observations` | Bearer | Purge all observations for the installation |
| `DELETE` | `/api/memory/sessions/:id` | Bearer | Delete a single session |
| `DELETE` | `/api/memory/sessions/empty` | Bearer | Clean up empty sessions |
