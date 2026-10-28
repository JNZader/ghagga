# API — Settings & Provider Validation Endpoints

## Purpose

Define the REST API endpoints for managing repository settings (provider chain, AI toggle, static tools) and validating provider API keys with dynamic model listing.

## Requirements

### Requirement: Get Repository Settings

The server MUST expose `GET /api/settings?repo={fullName}` that returns the complete configuration for a repository.

#### Scenario: Fetch settings for a tracked repo

- GIVEN an authenticated user with access to installation containing repo `JNZader/my-app`
- WHEN `GET /api/settings?repo=JNZader/my-app` is called
- THEN the response MUST return 200 with the repo's settings
- AND the response body MUST include `aiReviewEnabled`, `providerChain`, `reviewMode`, `enableSemgrep`, `enableTrivy`, `enableCpd`, `enableMemory`, `customRules`, `ignorePatterns`
- AND each entry in `providerChain` MUST include `provider`, `model`, and `hasApiKey` (boolean)
- AND each entry MUST NOT include `encryptedApiKey` (never expose encrypted keys to the client)
- AND entries with a stored key MUST include `maskedApiKey` (e.g., `"sk-...xxxx"`)

#### Scenario: Fetch settings for unknown repo

- GIVEN an authenticated user
- WHEN `GET /api/settings?repo=unknown/repo` is called
- THEN the response MUST return 404

#### Scenario: Fetch settings without repo param

- GIVEN an authenticated user
- WHEN `GET /api/settings` is called without the `repo` query parameter
- THEN the response MUST return 400

### Requirement: Update Repository Settings

The server MUST expose `PUT /api/settings` that updates all settings for a repository in a single request.

#### Scenario: Update full settings

- GIVEN an authenticated user with access to repo `JNZader/my-app`
- WHEN `PUT /api/settings` is called with body:

  ```json
  {
    "repoFullName": "JNZader/my-app",
    "aiReviewEnabled": true,
    "providerChain": [
      { "provider": "github", "model": "gpt-4o-mini" },
      { "provider": "openai", "model": "gpt-4o", "apiKey": "sk-live-xxx" }
    ],
    "reviewMode": "workflow",
    "enableSemgrep": true,
    "enableTrivy": true,
    "enableCpd": false,
    "enableMemory": true,
    "customRules": "",
    "ignorePatterns": ["*.md", "*.lock"]
  }
  ```
- THEN the response MUST return 200
- AND the `provider_chain` in the database MUST have 2 entries
- AND the OpenAI entry's `apiKey` MUST be encrypted before storage
- AND the GitHub Models entry MUST have `encryptedApiKey: null`

#### Scenario: Update preserves existing API keys when not provided

- GIVEN a repo with a provider chain entry `{ provider: 'openai', encryptedApiKey: 'enc_existing' }`
- WHEN `PUT /api/settings` is called with the same provider entry WITHOUT an `apiKey` field
- THEN the existing `encryptedApiKey` MUST be preserved (not overwritten to null)

#### Scenario: Update settings for repo user cannot access

- GIVEN an authenticated user who does NOT have access to repo `other/repo`
- WHEN `PUT /api/settings` is called for that repo
- THEN the response MUST return 403

### Requirement: Validate Provider API Key

The server MUST expose `POST /api/providers/validate` that tests an API key against a provider and returns available models on success.

#### Scenario: Validate a valid OpenAI key

- GIVEN an authenticated user
- WHEN `POST /api/providers/validate` is called with `{ "provider": "openai", "apiKey": "sk-live-valid" }`
- THEN the response MUST return 200
- AND the body MUST include `{ "valid": true, "models": ["gpt-4o", "gpt-4o-mini", ...] }`

#### Scenario: Validate an invalid API key

- GIVEN an authenticated user
- WHEN `POST /api/providers/validate` is called with `{ "provider": "openai", "apiKey": "sk-invalid" }`
- THEN the response MUST return 200
- AND the body MUST include `{ "valid": false, "error": "..." }`
- AND the `models` field MUST be an empty array

#### Scenario: Validate GitHub Models provider

- GIVEN an authenticated user with a valid GitHub session token
- WHEN `POST /api/providers/validate` is called with `{ "provider": "github" }`
- THEN the server MUST use the user's session token (from the Authorization header) to test against GitHub Models API
- AND return `{ "valid": true, "models": ["gpt-4o-mini", "gpt-4o", ...] }`

#### Scenario: Validate with missing apiKey for non-GitHub provider

- GIVEN an authenticated user
- WHEN `POST /api/providers/validate` is called with `{ "provider": "anthropic" }` (no apiKey)
- THEN the response MUST return 400 with an error message

#### Scenario: Validate Anthropic key (no models endpoint)

- GIVEN an authenticated user
- WHEN `POST /api/providers/validate` is called with `{ "provider": "anthropic", "apiKey": "sk-ant-valid" }`
- THEN the server MUST test the key by making a minimal API call (e.g., list models or a small generation)
- AND on success, return `{ "valid": true, "models": [...] }` with a curated static list of Anthropic models

#### Scenario: Validate Google key

- GIVEN an authenticated user
- WHEN `POST /api/providers/validate` is called with `{ "provider": "google", "apiKey": "AIza-valid" }`
- THEN the server MUST test the key against Google's Generative AI API
- AND on success, return `{ "valid": true, "models": [...] }` with available Gemini models

### Requirement: Ollama Excluded from SaaS API

The validation and settings endpoints MUST NOT accept `'ollama'` as a provider value.

#### Scenario: Reject Ollama provider in validation

- GIVEN an authenticated user
- WHEN `POST /api/providers/validate` is called with `{ "provider": "ollama" }`
- THEN the response MUST return 400 with a message indicating Ollama is not available in the SaaS dashboard

#### Scenario: Reject Ollama in settings update

- GIVEN an authenticated user
- WHEN `PUT /api/settings` is called with a provider chain entry containing `provider: 'ollama'`
- THEN the response MUST return 400
