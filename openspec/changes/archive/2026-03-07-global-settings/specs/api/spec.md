# Spec: Global Settings — API Layer

## REQ-GS-API-1: Get Installation Settings

`GET /api/installation-settings?installation_id={id}`

### Scenario GS-API-1a: Success

- **Given** the user is authenticated and has access to installation 5
- **When** `GET /api/installation-settings?installation_id=5`
- **Then** returns 200 with `{ data: { installationId, providerChain (masked), aiReviewEnabled, reviewMode, settings } }`

### Scenario GS-API-1b: No settings exist yet

- **Given** the user is authenticated and has access to installation 5
- **And** no `installation_settings` row exists
- **When** `GET /api/installation-settings?installation_id=5`
- **Then** returns 200 with default values (empty chain, aiReviewEnabled=true, reviewMode='simple', DEFAULT_REPO_SETTINGS)

### Scenario GS-API-1c: Forbidden

- **Given** the user does NOT have access to installation 5
- **When** `GET /api/installation-settings?installation_id=5`
- **Then** returns 403

### Scenario GS-API-1d: Missing parameter

- **When** `GET /api/installation-settings` (no installation_id)
- **Then** returns 400

## REQ-GS-API-2: Update Installation Settings

`PUT /api/installation-settings`

Body: `{ installationId, providerChain?, aiReviewEnabled?, reviewMode?, settings? }`

### Scenario GS-API-2a: Success — create new

- **Given** no settings row exists for installation 5
- **When** `PUT /api/installation-settings` with `{ installationId: 5, providerChain: [...], reviewMode: 'workflow' }`
- **Then** creates the row, returns 200 with `{ message: 'Installation settings updated' }`

### Scenario GS-API-2b: Success — update existing

- **Given** settings exist for installation 5
- **When** `PUT /api/installation-settings` with `{ installationId: 5, aiReviewEnabled: false }`
- **Then** updates only the provided fields, preserves others

### Scenario GS-API-2c: API key merge

- **Given** settings exist with an Anthropic key in the chain
- **When** `PUT` with a chain entry for Anthropic with no `apiKey` field
- **Then** the existing encrypted key MUST be preserved (same merge logic as per-repo)

### Scenario GS-API-2d: Ollama rejected

- **When** `PUT` with a chain entry for `provider: 'ollama'`
- **Then** returns 400 with error message

### Scenario GS-API-2e: Forbidden

- **Given** the user does NOT have access to installation 5
- **When** `PUT /api/installation-settings` with `{ installationId: 5, ... }`
- **Then** returns 403

## REQ-GS-API-3: Get Repo Settings — Extended

The existing `GET /api/settings?repo=...` MUST be extended to include:
- `useGlobalSettings` boolean
- `globalSettings` object (the installation-level settings, if they exist) — so the dashboard can show inherited values

### Scenario GS-API-3a: Repo uses global

- **Given** repo has `use_global_settings = true`
- **When** `GET /api/settings?repo=owner/repo`
- **Then** response includes `useGlobalSettings: true` and `globalSettings: { ... }` with the installation's settings

### Scenario GS-API-3b: Repo uses custom

- **Given** repo has `use_global_settings = false`
- **When** `GET /api/settings?repo=owner/repo`
- **Then** response includes `useGlobalSettings: false` and the repo's own settings. `globalSettings` MAY still be included for reference.

## REQ-GS-API-4: Update Repo Settings — Use Global Toggle

The existing `PUT /api/settings` MUST accept a `useGlobalSettings` boolean.

### Scenario GS-API-4a: Switch to global

- **Given** repo has `use_global_settings = false`
- **When** `PUT /api/settings` with `{ repoFullName: '...', useGlobalSettings: true }`
- **Then** sets `use_global_settings = true` on the repo. Per-repo chain is NOT deleted (preserved in case user switches back).

### Scenario GS-API-4b: Switch to custom

- **Given** repo has `use_global_settings = true`
- **When** `PUT /api/settings` with `{ repoFullName: '...', useGlobalSettings: false, providerChain: [...] }`
- **Then** sets `use_global_settings = false` and saves the custom chain.

## REQ-GS-API-5: Webhook Resolution

The webhook handler MUST resolve effective settings before dispatching to Inngest.

### Scenario GS-API-5a: Repo uses global

- **Given** a PR webhook arrives for a repo with `use_global_settings = true`
- **And** the installation has settings with `providerChain: [{provider: 'anthropic', ...}]`
- **When** the webhook dispatches to Inngest
- **Then** the event data contains the installation's provider chain and settings

### Scenario GS-API-5b: Repo uses custom

- **Given** a PR webhook arrives for a repo with `use_global_settings = false`
- **When** the webhook dispatches to Inngest
- **Then** the event data contains the repo's own provider chain and settings

### Scenario GS-API-5c: No installation settings exist

- **Given** a PR webhook arrives for a repo with `use_global_settings = true`
- **And** no installation settings row exists
- **When** the webhook dispatches to Inngest
- **Then** the event data uses defaults (empty chain → GitHub Models fallback in pipeline, ai_review_enabled=true)
