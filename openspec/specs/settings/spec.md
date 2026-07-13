# Settings — Unified Specification

> **Origin**: Merged from two SDD changes archived 2026-03-07:
> - `settings-provider-chain` — Provider chain schema, API endpoints, core pipeline integration, dashboard settings page redesign
> - `global-settings` — Installation-level settings, per-repo global/custom toggle, effective settings resolution
> **Updated**: 2026-03-08 — Merged delta from `extensible-static-analysis` change (tool list fields, tool grid UI, Zod/Inngest extensions)

---

## Section 1: Database Layer

### 1.1 Provider Chain Storage

The `repositories` table MUST store a `provider_chain` column of type JSONB, containing an ordered array of provider configurations.

Each entry in the array MUST contain:
- `provider`: one of `'anthropic'`, `'openai'`, `'google'`, `'github'`
- `model`: a string identifying the model (e.g., `'gpt-4o-mini'`)
- `encryptedApiKey`: a string with the AES-256-GCM encrypted key, or `null` for providers that use the session token (GitHub Models)

The array order defines the fallback priority (index 0 = primary).

#### Scenario: New repository gets empty provider chain

- GIVEN a new GitHub App installation event with a repository
- WHEN the repository is created in the database
- THEN `provider_chain` MUST be set to `[]` (empty array)
- AND `ai_review_enabled` MUST be set to `true`

#### Scenario: Provider chain stores multiple providers in order

- GIVEN a repository with id=1
- WHEN the user saves a chain of [GitHub Models (gpt-4o-mini), OpenAI (gpt-4o)]
- THEN `provider_chain` MUST be stored as a JSONB array with 2 entries
- AND the first entry MUST have `provider: 'github'` and `encryptedApiKey: null`
- AND the second entry MUST have `provider: 'openai'` and a non-null `encryptedApiKey`

### 1.2 AI Review Toggle

The `repositories` table MUST have an `ai_review_enabled` column of type boolean, defaulting to `true`.

#### Scenario: AI review disabled

- GIVEN a repository with `ai_review_enabled = false`
- WHEN a PR webhook triggers a review
- THEN the pipeline MUST skip all LLM agent calls
- AND MUST still run enabled static analysis tools

#### Scenario: AI review enabled with empty chain

- GIVEN a repository with `ai_review_enabled = true` and `provider_chain = []`
- WHEN a PR webhook triggers a review
- THEN the pipeline MUST treat it as if AI review is disabled
- AND MUST log a warning about misconfiguration

### 1.3 Migration from Flat Columns

The database migration MUST preserve existing data by converting the old flat columns into the new provider chain format.

#### Scenario: Migrate repo with existing provider config

- GIVEN a repository with `llm_provider = 'openai'`, `llm_model = 'gpt-4o'`, `encrypted_api_key = 'enc_xyz...'`
- WHEN the migration runs
- THEN `provider_chain` MUST be set to `[{ provider: 'openai', model: 'gpt-4o', encryptedApiKey: 'enc_xyz...' }]`
- AND `ai_review_enabled` MUST be set to `true`

#### Scenario: Migrate repo with no provider config

- GIVEN a repository with `llm_provider = 'github'`, `llm_model = null`, `encrypted_api_key = null`
- WHEN the migration runs
- THEN `provider_chain` MUST be set to `[{ provider: 'github', model: 'gpt-4o-mini', encryptedApiKey: null }]`
- AND `ai_review_enabled` MUST be set to `true`

#### Scenario: Old columns preserved for rollback

- GIVEN the migration has run successfully
- WHEN the old columns (`llm_provider`, `llm_model`, `encrypted_api_key`) are inspected
- THEN they MUST still exist in the table (not dropped)
- AND their data MUST be unchanged

### 1.4 Provider Chain Update

The system MUST support updating the provider chain for a repository via `updateRepoSettings()`.

#### Scenario: Replace entire provider chain

- GIVEN a repository with a chain of [GitHub Models]
- WHEN `updateRepoSettings()` is called with a new chain of [Anthropic, OpenAI]
- THEN the stored `provider_chain` MUST be replaced entirely with the new chain
- AND `updatedAt` MUST be set to the current timestamp

#### Scenario: Toggle AI review off

- GIVEN a repository with `ai_review_enabled = true`
- WHEN `updateRepoSettings()` is called with `{ aiReviewEnabled: false }`
- THEN `ai_review_enabled` MUST be set to `false`
- AND the `provider_chain` MUST remain unchanged

### 1.5 Installation Settings Table

The system MUST provide an `installation_settings` table with a 1:1 relationship to `installations`.

#### Fields
- `id` (serial PK)
- `installation_id` (FK → installations.id, UNIQUE, NOT NULL)
- `provider_chain` (JSONB, default `[]`) — same shape as `DbProviderChainEntry[]`
- `ai_review_enabled` (boolean, default `true`)
- `review_mode` (varchar(20), default `'simple'`)
- `settings` (JSONB, default `DEFAULT_REPO_SETTINGS`) — static analysis toggles, custom rules, ignore patterns
- `created_at`, `updated_at` (timestamps)

#### Scenario: Table creation

- Given the migration is applied
- When I query `installation_settings`
- Then the table exists with all specified columns and constraints

#### Scenario: Unique constraint on installation_id

- Given an `installation_settings` row exists for installation 1
- When I attempt to insert another row for installation 1
- Then the insert MUST fail with a unique constraint violation

### 1.6 Use Global Settings Flag on Repositories

The `repositories` table MUST have a `use_global_settings` boolean column (default `true`).

#### Scenario: New repos default to global

- Given a new repository is created via `upsertRepository`
- When no explicit `use_global_settings` value is provided
- Then the column MUST default to `true`

#### Scenario: Existing repos with provider_chain get override

- Given the migration runs
- When a repository has a non-empty `provider_chain` (length > 0)
- Then `use_global_settings` MUST be set to `false`

#### Scenario: Existing repos with empty chain get global

- Given the migration runs
- When a repository has an empty `provider_chain` (`[]`)
- Then `use_global_settings` MUST remain `true` (the default)

### 1.7 Query Functions

#### Scenario: Get installation settings

- Given an installation with id=5 has a settings row
- When I call `getInstallationSettings(db, 5)`
- Then it returns the settings row

#### Scenario: Get installation settings — not found

- Given no settings row exists for installation id=99
- When I call `getInstallationSettings(db, 99)`
- Then it returns `null`

#### Scenario: Upsert installation settings — create

- Given no settings row exists for installation id=5
- When I call `upsertInstallationSettings(db, 5, { providerChain: [...], ... })`
- Then a new row is created and returned

#### Scenario: Upsert installation settings — update

- Given a settings row exists for installation id=5
- When I call `upsertInstallationSettings(db, 5, { aiReviewEnabled: false })`
- Then the existing row is updated (not duplicated)

### 1.8 Effective Settings Resolution

The system MUST provide a function to resolve the effective settings for a repository.

#### Scenario: Repo uses global settings

- Given repo has `use_global_settings = true`
- And installation has settings with provider_chain `[{provider: 'anthropic', ...}]`
- When I call `getEffectiveSettings(db, repoId)`
- Then it returns the installation-level settings

#### Scenario: Repo uses custom settings

- Given repo has `use_global_settings = false`
- And repo has its own provider_chain
- When I call `getEffectiveSettings(db, repoId)`
- Then it returns the repo-level settings

#### Scenario: Repo uses global but no installation settings exist

- Given repo has `use_global_settings = true`
- And no `installation_settings` row exists for its installation
- When I call `getEffectiveSettings(db, repoId)`
- Then it returns sensible defaults (empty chain, aiReviewEnabled=true, DEFAULT_REPO_SETTINGS)

---

## Section 2: API Layer

### 2.1 Get Repository Settings

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

### 2.2 Update Repository Settings

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

### 2.3 Validate Provider API Key

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

### 2.4 Ollama Excluded from SaaS API

The validation and settings endpoints MUST NOT accept `'ollama'` as a provider value.

#### Scenario: Reject Ollama provider in validation

- GIVEN an authenticated user
- WHEN `POST /api/providers/validate` is called with `{ "provider": "ollama" }`
- THEN the response MUST return 400 with a message indicating Ollama is not available in the SaaS dashboard

#### Scenario: Reject Ollama in settings update

- GIVEN an authenticated user
- WHEN `PUT /api/settings` is called with a provider chain entry containing `provider: 'ollama'`
- THEN the response MUST return 400

### 2.5 Get Installation Settings

`GET /api/installation-settings?installation_id={id}`

#### Scenario: Success

- Given the user is authenticated and has access to installation 5
- When `GET /api/installation-settings?installation_id=5`
- Then returns 200 with `{ data: { installationId, providerChain (masked), aiReviewEnabled, reviewMode, settings } }`

#### Scenario: No settings exist yet

- Given the user is authenticated and has access to installation 5
- And no `installation_settings` row exists
- When `GET /api/installation-settings?installation_id=5`
- Then returns 200 with default values (empty chain, aiReviewEnabled=true, reviewMode='simple', DEFAULT_REPO_SETTINGS)

#### Scenario: Forbidden

- Given the user does NOT have access to installation 5
- When `GET /api/installation-settings?installation_id=5`
- Then returns 403

#### Scenario: Missing parameter

- When `GET /api/installation-settings` (no installation_id)
- Then returns 400

### 2.6 Update Installation Settings

`PUT /api/installation-settings`

Body: `{ installationId, providerChain?, aiReviewEnabled?, reviewMode?, settings? }`

#### Scenario: Success — create new

- Given no settings row exists for installation 5
- When `PUT /api/installation-settings` with `{ installationId: 5, providerChain: [...], reviewMode: 'workflow' }`
- Then creates the row, returns 200 with `{ message: 'Installation settings updated' }`

#### Scenario: Success — update existing

- Given settings exist for installation 5
- When `PUT /api/installation-settings` with `{ installationId: 5, aiReviewEnabled: false }`
- Then updates only the provided fields, preserves others

#### Scenario: API key merge

- Given settings exist with an Anthropic key in the chain
- When `PUT` with a chain entry for Anthropic with no `apiKey` field
- Then the existing encrypted key MUST be preserved (same merge logic as per-repo)

#### Scenario: Ollama rejected

- When `PUT` with a chain entry for `provider: 'ollama'`
- Then returns 400 with error message

#### Scenario: Forbidden

- Given the user does NOT have access to installation 5
- When `PUT /api/installation-settings` with `{ installationId: 5, ... }`
- Then returns 403

### 2.7 Get Repo Settings — Extended for Global Settings

The existing `GET /api/settings?repo=...` MUST be extended to include:
- `useGlobalSettings` boolean
- `globalSettings` object (the installation-level settings, if they exist) — so the dashboard can show inherited values

#### Scenario: Repo uses global

- Given repo has `use_global_settings = true`
- When `GET /api/settings?repo=owner/repo`
- Then response includes `useGlobalSettings: true` and `globalSettings: { ... }` with the installation's settings

#### Scenario: Repo uses custom

- Given repo has `use_global_settings = false`
- When `GET /api/settings?repo=owner/repo`
- Then response includes `useGlobalSettings: false` and the repo's own settings. `globalSettings` MAY still be included for reference.

### 2.8 Update Repo Settings — Use Global Toggle

The existing `PUT /api/settings` MUST accept a `useGlobalSettings` boolean.

#### Scenario: Switch to global

- Given repo has `use_global_settings = false`
- When `PUT /api/settings` with `{ repoFullName: '...', useGlobalSettings: true }`
- Then sets `use_global_settings = true` on the repo. Per-repo chain is NOT deleted (preserved in case user switches back).

#### Scenario: Switch to custom

- Given repo has `use_global_settings = true`
- When `PUT /api/settings` with `{ repoFullName: '...', useGlobalSettings: false, providerChain: [...] }`
- Then sets `use_global_settings = false` and saves the custom chain.

### 2.9 Webhook Resolution

The webhook handler MUST resolve effective settings before dispatching to Inngest.

#### Scenario: Repo uses global

- Given a PR webhook arrives for a repo with `use_global_settings = true`
- And the installation has settings with `providerChain: [{provider: 'anthropic', ...}]`
- When the webhook dispatches to Inngest
- Then the event data contains the installation's provider chain and settings

#### Scenario: Repo uses custom

- Given a PR webhook arrives for a repo with `use_global_settings = false`
- When the webhook dispatches to Inngest
- Then the event data contains the repo's own provider chain and settings

#### Scenario: No installation settings exist

- Given a PR webhook arrives for a repo with `use_global_settings = true`
- And no installation settings row exists
- When the webhook dispatches to Inngest
- Then the event data uses defaults (empty chain → GitHub Models fallback in pipeline, ai_review_enabled=true)

---

## Section 3: Core Pipeline Integration

### 3.1 Static-Only Review Mode

The `reviewPipeline` MUST support running without any LLM calls when AI review is disabled.

#### Scenario: Pipeline runs with AI disabled

- GIVEN a `ReviewInput` with `aiReviewEnabled: false`
- WHEN `reviewPipeline()` is called
- THEN the pipeline MUST run all enabled static analysis tools (Semgrep, Trivy, CPD)
- AND MUST NOT make any LLM API calls
- AND MUST return a `ReviewResult` with `status: 'PASSED'` if no critical/high findings, or `'FAILED'` if there are
- AND `metadata.provider` MUST be `'none'`
- AND `metadata.model` MUST be `'static-only'`
- AND `metadata.tokensUsed` MUST be `0`

#### Scenario: Pipeline skips memory search when AI disabled

- GIVEN a `ReviewInput` with `aiReviewEnabled: false` and `enableMemory: true`
- WHEN `reviewPipeline()` is called
- THEN memory search MUST be skipped (memory is only useful for LLM context)
- AND memory persistence MUST still run (to record static analysis observations)

### 3.2 Provider Chain Fallback in Pipeline

When AI review is enabled, the pipeline MUST use the provider chain via `generateWithFallback()` instead of direct single-provider calls.

#### Scenario: Primary provider succeeds

- GIVEN a provider chain of [GitHub Models (gpt-4o-mini), OpenAI (gpt-4o)]
- WHEN the pipeline runs and GitHub Models responds successfully
- THEN only the first provider MUST be called
- AND `metadata.provider` MUST be `'github'`
- AND `metadata.model` MUST be `'gpt-4o-mini'`

#### Scenario: Primary provider fails, fallback succeeds

- GIVEN a provider chain of [GitHub Models (gpt-4o-mini), OpenAI (gpt-4o)]
- WHEN the pipeline runs and GitHub Models returns a 429 (rate limit)
- THEN the pipeline MUST automatically try OpenAI
- AND if OpenAI succeeds, `metadata.provider` MUST be `'openai'`
- AND `metadata.model` MUST be `'gpt-4o'`

#### Scenario: All providers fail

- GIVEN a provider chain of [GitHub Models, OpenAI]
- WHEN both providers return 5xx errors
- THEN the pipeline MUST still return static analysis results
- AND `status` SHOULD be `'NEEDS_HUMAN_REVIEW'`
- AND the `summary` MUST indicate that AI review failed but static analysis completed
- AND `metadata.tokensUsed` MUST be `0`

### 3.3 ReviewInput Accepts Provider Chain

The `ReviewInput` type MUST accept either a single provider (backward compat for CLI/Action) or a provider chain.

#### Scenario: CLI passes single provider

- GIVEN a CLI invocation with `--provider openai --model gpt-4o --api-key sk-xxx`
- WHEN `ReviewInput` is constructed
- THEN it MUST work with the existing `provider`, `model`, `apiKey` fields
- AND the pipeline MUST treat it as a chain of 1

#### Scenario: Server passes provider chain

- GIVEN a webhook-triggered review with a provider chain from the database
- WHEN `ReviewInput` is constructed
- THEN it MUST use the `providerChain` field
- AND the pipeline MUST use `generateWithFallback()` with all entries

### 3.4 Consensus Mode with Provider Chain

In consensus mode, the pipeline currently uses the same provider 3 times with different stances. With a provider chain, it SHOULD still use the primary provider for all 3 stances (not spread across providers).

#### Scenario: Consensus uses primary provider

- GIVEN a provider chain of [OpenAI (gpt-4o), Anthropic (claude-sonnet)]
- WHEN consensus mode runs
- THEN all 3 stances (for, against, neutral) MUST use OpenAI gpt-4o
- AND the fallback chain is only used if the primary provider fails for ALL stances

### 3.5 Inngest Review Function Reads Provider Chain

The Inngest `ghagga-review` function MUST read the provider chain from the event data and build the appropriate `ReviewInput`.

#### Scenario: Inngest receives chain from webhook

- GIVEN a webhook dispatches a review event with `providerChain` and `aiReviewEnabled`
- WHEN the Inngest function's `run-review` step executes
- THEN it MUST decrypt API keys for each chain entry
- AND pass the full chain to `reviewPipeline()`

#### Scenario: Inngest handles AI disabled

- GIVEN a webhook dispatches a review event with `aiReviewEnabled: false`
- WHEN the Inngest function executes
- THEN it MUST skip the API key decryption step
- AND pass `aiReviewEnabled: false` to `reviewPipeline()`

---

## Section 4: Dashboard UI

### 4.1 Static Analysis Section

The Settings page MUST display a "Static Analysis" section with toggleable tools, always visible regardless of AI review state.

#### Scenario: Toggle static tools

- GIVEN the user has selected a repository
- WHEN the Settings page loads
- THEN checkboxes for Semgrep, Trivy, and CPD MUST be visible
- AND their state MUST reflect the current saved settings

#### Scenario: Save with all static tools disabled

- GIVEN the user unchecks Semgrep, Trivy, and CPD
- WHEN the user clicks "Save Settings"
- THEN all three tools MUST be saved as disabled
- AND the review pipeline MUST skip all static analysis for this repo

### 4.2 AI Review Master Toggle

The Settings page MUST display an "AI Review" toggle that controls whether LLM-based review is enabled.

#### Scenario: AI review toggle off

- GIVEN the user toggles AI Review to OFF
- WHEN the toggle changes
- THEN the provider chain section MUST be hidden
- AND the review mode selector (simple/workflow/consensus) MUST be hidden
- AND saving settings MUST set `aiReviewEnabled: false`

#### Scenario: AI review toggle on

- GIVEN the user toggles AI Review to ON
- WHEN the toggle changes
- THEN the provider chain section MUST become visible
- AND the review mode selector MUST become visible

### 4.3 Provider Chain Editor

When AI Review is enabled, the Settings page MUST display an ordered list of provider configurations.

#### Scenario: Empty chain shows add button

- GIVEN a repo with an empty provider chain and AI review enabled
- WHEN the Settings page loads
- THEN an "Add Provider" button MUST be visible
- AND a help text SHOULD suggest adding at least one provider

#### Scenario: Add a provider

- GIVEN the provider chain is empty
- WHEN the user clicks "Add Provider"
- THEN a new row MUST appear with a provider dropdown, API key input, and a disabled model dropdown
- AND the provider dropdown MUST show: GitHub Models (Free), Anthropic, OpenAI, Google
- AND MUST NOT show Ollama

#### Scenario: Add a second provider as fallback

- GIVEN the chain has 1 provider (GitHub Models)
- WHEN the user clicks "Add Fallback Provider"
- THEN a second row MUST appear below the first
- AND it MUST be labeled as "#2" or "Fallback"

#### Scenario: Remove a provider from the chain

- GIVEN the chain has 2 providers
- WHEN the user clicks the remove button on the second provider
- THEN the second provider MUST be removed
- AND the first provider MUST remain unchanged

#### Scenario: Reorder providers

- GIVEN the chain has providers [GitHub Models, OpenAI]
- WHEN the user moves OpenAI up (via up arrow button)
- THEN the chain MUST become [OpenAI, GitHub Models]
- AND OpenAI MUST now be labeled as primary (#1)

### 4.4 API Key Validation Flow

Each provider entry MUST have a "Validate" button that tests the API key and, on success, populates the model dropdown.

#### Scenario: Validate OpenAI key successfully

- GIVEN the user selected provider "OpenAI" and entered API key "sk-live-valid"
- WHEN the user clicks "Validate"
- THEN a loading indicator MUST appear on the button
- AND on success, the model dropdown MUST become enabled
- AND the dropdown MUST be populated with the models returned by the server
- AND a green checkmark or "Valid" indicator MUST appear

#### Scenario: Validate with invalid key

- GIVEN the user entered an invalid API key
- WHEN the user clicks "Validate"
- THEN a red error message MUST appear (e.g., "Invalid API key")
- AND the model dropdown MUST remain disabled
- AND the previously selected model (if any) MUST be cleared

#### Scenario: GitHub Models validation (no API key needed)

- GIVEN the user selected provider "GitHub Models"
- WHEN the provider is selected
- THEN the API key input MUST NOT be shown (or MUST be disabled with help text: "Uses your GitHub session token")
- AND a "Validate" button MUST still be shown
- AND clicking validate MUST test the session token against GitHub Models
- AND on success, the model dropdown MUST populate with available models

#### Scenario: Re-validate after changing API key

- GIVEN the user previously validated a key and selected a model
- WHEN the user changes the API key text
- THEN the model dropdown MUST become disabled again
- AND the validation status MUST reset to "unvalidated"
- AND the user MUST click "Validate" again

### 4.5 Model Selection Dropdown

After successful validation, the model dropdown MUST show available models for that provider.

#### Scenario: Model dropdown shows provider-specific models

- GIVEN the OpenAI key was validated successfully
- WHEN the model dropdown is opened
- THEN it MUST show models returned by the validation endpoint (e.g., gpt-4o, gpt-4o-mini, gpt-4-turbo)
- AND the dropdown MUST be searchable or filterable if the list is long

#### Scenario: Previously saved model is pre-selected

- GIVEN a repo with a saved provider chain entry `{ provider: 'openai', model: 'gpt-4o' }`
- WHEN the Settings page loads
- THEN the model dropdown MUST show "gpt-4o" as selected
- AND the validation status MUST show as "validated" (assume saved keys are valid)

### 4.6 Review Mode Selector

The review mode (simple/workflow/consensus) MUST only be visible when AI Review is enabled.

#### Scenario: Select review mode

- GIVEN AI Review is enabled
- WHEN the user selects "workflow" mode
- THEN the radio button for "workflow" MUST be checked
- AND saving settings MUST persist `reviewMode: 'workflow'`

### 4.7 Settings Save Behavior

The Save button MUST send all settings in a single `PUT /api/settings` request.

#### Scenario: Save complete settings

- GIVEN the user configured: AI enabled, chain [GitHub gpt-4o-mini, OpenAI gpt-4o], Semgrep on, Trivy on, CPD off, workflow mode
- WHEN the user clicks "Save Settings"
- THEN a single `PUT /api/settings` request MUST be sent
- AND the request body MUST include all fields
- AND API keys for new/changed providers MUST be sent in plaintext (server encrypts)
- AND API keys for unchanged providers MUST NOT be sent (server preserves existing)
- AND on success, a "Settings saved!" message MUST appear

#### Scenario: Save with no changes

- GIVEN the user opened settings and made no changes
- WHEN the user clicks "Save Settings"
- THEN the request MUST still be sent (idempotent)
- AND the success message MUST appear

### 4.8 Loading and Error States

#### Scenario: Settings loading

- GIVEN the user selected a repo
- WHEN settings are being fetched
- THEN a loading spinner MUST be shown

#### Scenario: Save fails

- GIVEN the server returns a 500 error on save
- WHEN the save request fails
- THEN a red error message MUST appear (e.g., "Failed to save settings")
- AND the form MUST retain the user's unsaved changes (not reset)

#### Scenario: Validation endpoint unavailable

- GIVEN the server is unreachable
- WHEN the user clicks "Validate"
- THEN an error message MUST appear indicating the server cannot be reached

### 4.9 Global Settings Page

The dashboard MUST have a new page accessible from the sidebar for configuring installation-level settings.

#### Scenario: Navigation

- Given the user is logged in
- When they click "Global Settings" in the sidebar
- Then the Global Settings page loads

#### Scenario: Installation selector

- Given the user has access to multiple installations
- When they open the Global Settings page
- Then they can select which installation to configure (dropdown or similar)

#### Scenario: Single installation

- Given the user has access to only one installation
- When they open the Global Settings page
- Then the installation is auto-selected (no dropdown needed)

#### Scenario: Page content

- Given the Global Settings page is loaded for an installation
- Then it MUST show:
  - AI Review toggle (enable/disable)
  - Provider Chain Editor (reused component)
  - Review Mode selector (simple/workflow/consensus)
  - Static Analysis toggles (Semgrep, Trivy, CPD)
  - Memory toggle
  - Custom Rules and Ignore Patterns
  - Save button

#### Scenario: First-time setup

- Given no installation settings exist yet
- When the page loads
- Then it shows defaults (AI enabled, empty chain, simple mode, all static analysis on)
- And a helpful message: "Configure your default settings. All repositories will inherit these unless overridden."

#### Scenario: Save

- Given the user modifies settings and clicks Save
- When the save completes
- Then a success toast appears
- And the settings persist on page reload

### 4.10 Per-Repo Settings Toggle

The existing Settings page MUST show a toggle for global vs custom settings.

#### Scenario: Default state — using global

- Given a repo with `useGlobalSettings: true`
- When the Settings page loads
- Then it shows a toggle/switch: "Use global settings" (ON)
- And below it, the inherited settings are shown in a read-only view
- And a link/badge: "Edit in Global Settings →"

#### Scenario: Switch to custom

- Given the toggle is ON (use global)
- When the user switches it OFF
- Then the form becomes editable
- And it pre-fills with the current global values as a starting point
- And a note: "This repo will use its own settings instead of inheriting from global."

#### Scenario: Custom settings active

- Given a repo with `useGlobalSettings: false`
- When the Settings page loads
- Then the toggle shows "Use global settings" (OFF)
- And the full settings form is editable (same as current behavior)

#### Scenario: Switch back to global

- Given the toggle is OFF (custom)
- When the user switches it ON
- Then the form becomes read-only showing inherited global values
- And the custom settings are NOT deleted (preserved for later)

### 4.11 Sidebar Navigation Update

#### Scenario: New nav item

- Given the dashboard sidebar
- Then it MUST include a "Global Settings" link with a distinct icon
- And it SHOULD appear above the repo-specific "Settings" link (logically: global first, then per-repo)

#### Scenario: Active state

- Given the user is on the Global Settings page
- Then the "Global Settings" sidebar item is highlighted as active

### 4.12 Visual Clarity

#### Scenario: Inherited badge

- Given a repo using global settings
- When viewing the per-repo Settings page
- Then each section shows an "Inherited" badge or indicator

#### Scenario: Override indicator in repo list

- Given the Dashboard or Settings page
- When a repo has custom settings (useGlobalSettings=false)
- Then it MAY show a small "Custom" badge to differentiate from global-inherited repos

---

## Section 5: Tool Configuration (Added by `extensible-static-analysis`, 2026-03-08)

### 5.1 enabled_tools JSONB Field

The `repositories` table's `settings` JSONB column MUST support an `enabledTools` field storing the list of explicitly enabled tool names as `string[]`.

Default value MUST be `null`/`undefined` (meaning: use tier defaults — all always-on tools activate, auto-detect tools activate based on file presence).

#### Scenario: New repo gets null enabledTools

- GIVEN a new repository is created via installation webhook
- WHEN the row is inserted
- THEN `enabledTools` MUST be `null`/`undefined` in the settings JSONB
- AND the runner MUST interpret this as "use tier defaults"

#### Scenario: User explicitly sets enabledTools

- GIVEN a repository with `enabledTools = null`
- WHEN the user saves `enabledTools: ['semgrep', 'trivy', 'gitleaks']`
- THEN only those 3 tools MUST be eligible for activation
- AND all other tools (including other always-on tools) MUST be skipped unless auto-detected

### 5.2 disabledTools JSONB Field

The `repositories` table's `settings` JSONB column MUST support a `disabledTools` field storing the list of explicitly disabled tool names as `string[]`.

Default value MUST be `[]` (empty array — no tools force-disabled).

#### Scenario: New repo gets empty disabledTools

- GIVEN a new repository is created
- WHEN the row is inserted
- THEN `disabledTools` MUST be `[]` (empty array)
- AND all tier-appropriate tools MUST be eligible for activation

#### Scenario: User disables a tool

- GIVEN a repository with `disabledTools = []`
- WHEN the user saves `disabledTools: ['cpd', 'markdownlint']`
- THEN CPD and markdownlint MUST NOT run for this repository
- AND all other tools MUST run as normal

### 5.3 Installation Settings Tool Extension

The `installation_settings` table's `settings` JSONB column MUST also support `enabledTools` and `disabledTools` fields within the `RepoSettings` shape.

#### Scenario: Global disabledTools inherited by repos

- GIVEN installation settings have `disabledTools: ['cpd']`
- AND a repository uses global settings (`use_global_settings = true`)
- WHEN the runner resolves tools for this repo
- THEN CPD MUST NOT run

#### Scenario: Per-repo override of global tools

- GIVEN installation settings have `disabledTools: ['cpd']`
- AND a repository uses custom settings (`use_global_settings = false`) with `disabledTools: []`
- WHEN the runner resolves tools for this repo
- THEN CPD MUST run (repo overrides global)

### 5.4 DB Migration for Tool Fields

The system MUST provide a migration that backfills the new tool list fields from existing boolean flags.

#### Scenario: Migration backfills from boolean flags

- GIVEN a repository with `enableSemgrep: false` in its `settings` JSONB
- WHEN the migration runs
- THEN `disabledTools` SHOULD be backfilled with `['semgrep']`
- AND the old `enableSemgrep` field MUST be preserved in the JSONB (backward compat)

#### Scenario: Migration is non-destructive

- GIVEN existing data in the `repositories` table
- WHEN the migration runs
- THEN no existing fields MUST be removed
- AND no existing data MUST be modified (except adding new fields with defaults)

### 5.5 RepoSettings Interface Extension (Modified)

The `RepoSettings` interface MUST include:
- `enabledTools?: string[]` — explicit tool enable list (optional, null = use defaults)
- `disabledTools?: string[]` — explicit tool disable list (optional, default `[]`)

The old boolean fields (`enableSemgrep`, `enableTrivy`, `enableCpd`) MUST remain for backward compatibility.

> **Previously**: `RepoSettings` had only `enableSemgrep: boolean`, `enableTrivy: boolean`, `enableCpd: boolean` for tool control.

#### Scenario: Old interface consumers unaffected

- GIVEN code that reads `settings.enableSemgrep`
- WHEN compiled against the new `RepoSettings` interface
- THEN it MUST compile without errors
- AND the value MUST still be a boolean

#### Scenario: New fields coexist with old

- GIVEN a `RepoSettings` object with both `enableSemgrep: true` and `disabledTools: ['semgrep']`
- WHEN serialized to JSONB and read back
- THEN both fields MUST be present
- AND the runner MUST resolve the conflict (new fields take precedence)

### 5.6 Settings API Tool Configuration (Modified)

The `GET /api/settings` and `PUT /api/settings` endpoints MUST support the new tool list fields alongside the old boolean fields.

> **Previously**: API accepted/returned `enableSemgrep`, `enableTrivy`, `enableCpd` only.

#### Scenario: GET returns both old and new fields

- GIVEN a repository with `disabledTools: ['cpd']` and `enableCpd: false`
- WHEN `GET /api/settings?repo=owner/repo` is called
- THEN the response MUST include both `enableCpd: false` AND `disabledTools: ['cpd']`
- AND the response MUST include a new `registeredTools` array listing all known tool names with their tier and category

#### Scenario: PUT accepts old boolean fields (backward compat)

- GIVEN an older dashboard version sending `{ enableSemgrep: false }`
- WHEN `PUT /api/settings` is called
- THEN the server MUST accept the request
- AND MUST translate `enableSemgrep: false` to `disabledTools` containing `'semgrep'` (if not already present)

#### Scenario: PUT accepts new tool list fields

- GIVEN a new dashboard sending `{ disabledTools: ['cpd', 'markdownlint'] }`
- WHEN `PUT /api/settings` is called
- THEN the server MUST save `disabledTools: ['cpd', 'markdownlint']` in the database
- AND MUST also update `enableCpd: false` in the settings JSONB for backward compat

#### Scenario: PUT validates tool names

- GIVEN a request with `disabledTools: ['nonexistent-tool']`
- WHEN `PUT /api/settings` is called
- THEN the server MUST return 400 with `error: 'VALIDATION_ERROR'` and identify the invalid tool name

#### Scenario: GET includes registered tools list

- GIVEN the tool registry has 15 registered tools
- WHEN `GET /api/settings?repo=owner/repo` is called
- THEN the response MUST include `registeredTools` with entries like:
  ```json
  [
    { "name": "semgrep", "displayName": "Semgrep", "category": "security", "tier": "always-on" },
    { "name": "ruff", "displayName": "Ruff", "category": "linting", "tier": "auto-detect" }
  ]
  ```
- AND the dashboard MUST use this list to render the tool grid dynamically

### 5.7 Settings Zod Validation Extension (Modified)

The `RepoSettingsSchema` Zod schema MUST accept `enabledTools` and `disabledTools` fields.

> **Previously**: Schema validated only `enableSemgrep`, `enableTrivy`, `enableCpd` as `z.boolean().optional()`

#### Scenario: Zod validates new fields

- GIVEN a PUT request body with `disabledTools: ['semgrep', 'cpd']`
- WHEN Zod validation runs
- THEN it MUST accept `disabledTools` as `z.array(z.string()).optional()`
- AND it MUST accept `enabledTools` as `z.array(z.string()).optional()`

#### Scenario: Zod rejects invalid types

- GIVEN a PUT request body with `disabledTools: "semgrep"` (string instead of array)
- WHEN Zod validation runs
- THEN it MUST return a validation error

### 5.8 Inngest Event Data Extension (Modified)

The Inngest review event data MUST include the resolved `enabledTools` and `disabledTools` arrays.

> **Previously**: Event data included `enableSemgrep`, `enableTrivy`, `enableCpd` booleans only.

#### Scenario: Inngest event includes tool lists

- GIVEN a PR webhook triggers a review
- WHEN the webhook handler resolves effective settings
- THEN the Inngest event data MUST include `enabledTools` and `disabledTools`
- AND the old boolean fields MUST remain for backward compat during migration

### 5.9 Tool Grid in Settings Page (Dashboard)

The Settings page MUST display a tool grid showing all registered tools with enable/disable toggles, replacing the current 3 individual checkboxes.

#### Scenario: Tool grid renders all registered tools

- GIVEN the dashboard loads settings for a repository
- WHEN the Static Analysis section renders
- THEN it MUST display a grid of all registered tools (from `registeredTools` API response)
- AND each tool MUST show: display name, category badge, tier badge (always-on / auto-detect), and a toggle switch

#### Scenario: Tool grid reflects current state

- GIVEN a repository with `disabledTools: ['cpd', 'markdownlint']`
- WHEN the tool grid renders
- THEN CPD and markdownlint toggles MUST be OFF
- AND all other tools MUST be ON (or "auto" for auto-detect tools)

#### Scenario: Tool grid saves changes

- GIVEN the user toggles Gitleaks OFF and saves
- WHEN the PUT request is sent
- THEN `disabledTools` MUST include `'gitleaks'`
- AND the save MUST succeed with the existing save flow

#### Scenario: Tool grid grouped by category

- GIVEN 15 registered tools across multiple categories
- WHEN the tool grid renders
- THEN tools SHOULD be grouped by category (Security, Linting, Quality, etc.)
- AND each group SHOULD have a collapsible header

#### Scenario: Global settings tool grid

- GIVEN the Global Settings page
- WHEN the tool grid renders
- THEN it MUST show the same tool grid as per-repo settings
- AND changes MUST apply to all repos using global settings

#### Scenario: Inherited tool grid read-only

- GIVEN a repository using global settings (`useGlobalSettings: true`)
- WHEN the Settings page renders
- THEN the tool grid MUST be read-only (non-interactive toggles)
- AND each tool MUST show an "Inherited" badge
- AND the state MUST reflect the global settings


## Section 6: CLI Bridge Credentials and Model Selection

### 6.1 Tool and Model Contract

A CLI Bridge provider-chain entry MUST support a CLI tool selection and an
optional `cliModel`. OpenCode entries MUST provide a model in `provider/model`
format; tools that do not support explicit model selection MUST ignore or strip
`cliModel`. The legacy `claude` tool value MUST remain readable through its
OpenCode-compatible migration path.

#### Scenario: OpenCode model is saved

- GIVEN a CLI Bridge entry selects OpenCode
- WHEN the user saves `anthropic/claude-sonnet-4-5`
- THEN the API validates the provider/model shape
- AND the model is persisted and returned with that entry

### 6.2 Credential Isolation

CLI Bridge credentials MUST remain encrypted at rest and MUST be injected only
into the subprocess environment variable required by the selected tool/model.
The subprocess environment MUST be built from an allowlist so unrelated server
credentials are not inherited. A stored credential MAY fall back to the server
environment only when the selected tool's documented fallback permits it.

#### Scenario: OpenCode receives one credential

- GIVEN an OpenCode model whose provider prefix maps to one API-key variable
- WHEN the review process launches OpenCode
- THEN only that resolved credential is injected
- AND unrelated API keys and service secrets are absent from the subprocess environment

#### Scenario: Tool selection changes

- GIVEN a CLI Bridge entry has a model and credential for one tool
- WHEN the selected tool changes
- THEN incompatible model and credential state is reset before save
