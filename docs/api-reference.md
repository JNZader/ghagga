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

Receives static analysis results from the inline GitHub Actions workflow injected at `.github/workflows/ghagga.yml`. No bearer auth — validated via HMAC-SHA256 signature with TTL enforcement.

**Required Headers**:

| Header | Description |
|--------|-------------|
| `X-Ghagga-Signature` | `sha256=<hex>` — HMAC of the raw body using the per-dispatch derived secret |
| `Content-Type` | `application/json` |

**Body** (`StaticAnalysisCallbackPayload`):

```json
{
  "callbackId": "550e8400-e29b-41d4-a716-446655440000.m1abc",
  "repoFullName": "owner/repo",
  "prNumber": 42,
  "headSha": "abc123…",
  "staticAnalysis": {
    "semgrep": { "status": "success", "findings": [], "executionTimeMs": 5421 },
    "trivy":   { "status": "success", "findings": [], "executionTimeMs": 8190 },
    "cpd":     { "status": "skipped", "findings": [], "executionTimeMs": 0 }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `callbackId` | `string` | `{uuid}.{timestamp_base36}` — used for HMAC re-derivation and TTL enforcement |
| `repoFullName` | `string` | Target repository (`owner/repo`) |
| `prNumber` | `number` | Pull request number |
| `headSha` | `string` | Head commit SHA the workflow analyzed |
| `staticAnalysis` | `object` | Per-tool result map (`StaticAnalysisResult`) |

**Response** `200` (success):

```json
{ "ok": true }
```

**Response** `400` (invalid JSON or missing required fields):

```json
{ "error": "Missing required fields" }
```

**Response** `401` (missing or invalid signature, or TTL expired):

```json
{ "error": "Invalid signature" }
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

**Success response**: `302` redirect to `https://ghagga.javierzader.com/app/#/auth/callback?token=...`

**Failure response**: `302` redirect to `https://ghagga.javierzader.com/app/#/auth/callback?error=...`

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
        "provider": "gateway",
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
          "provider": "cli-bridge",
          "model": "auto",
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

> **Deprecated**: `enableSemgrep`, `enableTrivy`, and `enableCpd` are deprecated since v2.5.0. Use `enabledTools`/`disabledTools` instead to control individual tools from the 16-tool plugin registry. The legacy boolean fields still work but will be removed in a future version.

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
    { "provider": "gateway", "model": "claude-sonnet-4-20250514", "apiKey": "sk-gateway-..." },
    { "provider": "cli-bridge", "model": "auto" }
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
{ "provider": "gateway", "model": "claude-sonnet-4-20250514", "apiKey": "sk-gateway-..." }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | Yes | One of: `gateway`, `cli-bridge`, `ollama` |
| `model` | `string` | Yes | Model identifier (e.g., `auto`, `claude-sonnet-4-20250514`). Use `auto` to let the provider select the best available model |
| `apiKey` | `string` | No | API key (omit to keep existing key; `cli-bridge` and `ollama` do not require one) |

> **API Key Behavior**: When you send a `providerChain` entry without an `apiKey`, the server preserves the previously stored encrypted key for that provider. Send a new `apiKey` to rotate it. The `cli-bridge` and `ollama` providers do not require an API key.

> **Valid Providers**: `gateway`, `cli-bridge`, `ollama`. Pre-v2 legacy provider values are automatically remapped to `gateway` for backward compatibility. The `ollama` provider is stored as a valid setting but is **not** accepted by `POST /api/providers/validate` — see that endpoint for runtime restrictions.

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
        "provider": "cli-bridge",
        "model": "auto",
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
    { "provider": "cli-bridge", "model": "auto" }
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

## Provider Validation

### Validate Provider API Key

```
POST /api/providers/validate
```

Validates a SaaS dashboard provider configuration. Returns the list of available models when the configuration is reachable.

The dashboard only supports two runtime targets:

- `gateway` — a self-hosted LLM gateway. Validation pings `${gatewayUrl}/health`.
- `cli-bridge` — local CLI tools (Claude Code, OpenCode, etc.) running on the user's machine. Validation enumerates available CLIs; no API key is required.

The `ollama` provider is intentionally rejected by this endpoint — it is only available via the CLI and Action runtimes, not the SaaS dashboard.

**Body**:

```json
{
  "provider": "gateway",
  "gatewayUrl": "https://gateway.example.com"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | Yes | One of: `gateway`, `cli-bridge` |
| `gatewayUrl` | `string` | Conditional | Required for `gateway` to perform a `/health` probe. If omitted, the response is `valid: true` with `models: ["auto"]` so the dashboard can defer the URL prompt. |
| `apiKey` | `string` | No | Accepted in the body for forward compatibility but ignored by both runtime targets (gateway uses the URL, cli-bridge uses local CLIs). |

**Response** `200` (valid configuration):

```json
{
  "valid": true,
  "models": ["auto"]
}
```

**Response** `200` (invalid configuration):

```json
{
  "valid": false,
  "models": [],
  "error": "Gateway health check failed (HTTP 503)"
}
```

**Response** `400` (validation error):

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Unknown provider: invalid"
}
```

Returned when `provider` is missing, equals `ollama`, or is not one of `gateway` / `cli-bridge`.

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
| `GET` | `/api/installations` | Bearer | List user's installations |
| `GET` | `/api/reviews` | Bearer | List reviews (paginated) |
| `GET` | `/api/stats` | Bearer | Review statistics |
| `GET` | `/api/settings` | Bearer | Get repository settings |
| `PUT` | `/api/settings` | Bearer | Update repository settings |
| `GET` | `/api/installation-settings` | Bearer | Get global installation settings |
| `PUT` | `/api/installation-settings` | Bearer | Update global installation settings |
| `POST` | `/api/providers/validate` | Bearer | Validate provider API key |
| `GET` | `/api/memory/sessions` | Bearer | List memory sessions |
| `GET` | `/api/memory/sessions/:id/observations` | Bearer | List session observations |
| `DELETE` | `/api/memory/observations/:id` | Bearer | Delete a single observation |
| `DELETE` | `/api/memory/projects/:project/observations` | Bearer | Clear all observations for a project |
| `DELETE` | `/api/memory/observations` | Bearer | Purge all observations for the installation |
| `DELETE` | `/api/memory/sessions/:id` | Bearer | Delete a single session |
| `DELETE` | `/api/memory/sessions/empty` | Bearer | Clean up empty sessions |
