# Spec: Global Settings — Database Layer

## REQ-GS-DB-1: Installation Settings Table

The system MUST provide an `installation_settings` table with a 1:1 relationship to `installations`.

### Fields

- `id` (serial PK)
- `installation_id` (FK → installations.id, UNIQUE, NOT NULL)
- `provider_chain` (JSONB, default `[]`) — same shape as `DbProviderChainEntry[]`
- `ai_review_enabled` (boolean, default `true`)
- `review_mode` (varchar(20), default `'simple'`)
- `settings` (JSONB, default `DEFAULT_REPO_SETTINGS`) — static analysis toggles, custom rules, ignore patterns
- `created_at`, `updated_at` (timestamps)

### Scenario GS-DB-1a: Table creation

- **Given** the migration is applied
- **When** I query `installation_settings`
- **Then** the table exists with all specified columns and constraints

### Scenario GS-DB-1b: Unique constraint on installation_id

- **Given** an `installation_settings` row exists for installation 1
- **When** I attempt to insert another row for installation 1
- **Then** the insert MUST fail with a unique constraint violation

## REQ-GS-DB-2: Use Global Settings Flag on Repositories

The `repositories` table MUST have a `use_global_settings` boolean column (default `true`).

### Scenario GS-DB-2a: New repos default to global

- **Given** a new repository is created via `upsertRepository`
- **When** no explicit `use_global_settings` value is provided
- **Then** the column MUST default to `true`

### Scenario GS-DB-2b: Existing repos with provider_chain get override

- **Given** the migration runs
- **When** a repository has a non-empty `provider_chain` (length > 0)
- **Then** `use_global_settings` MUST be set to `false`

### Scenario GS-DB-2c: Existing repos with empty chain get global

- **Given** the migration runs
- **When** a repository has an empty `provider_chain` (`[]`)
- **Then** `use_global_settings` MUST remain `true` (the default)

## REQ-GS-DB-3: Query Functions

### Scenario GS-DB-3a: Get installation settings

- **Given** an installation with id=5 has a settings row
- **When** I call `getInstallationSettings(db, 5)`
- **Then** it returns the settings row

### Scenario GS-DB-3b: Get installation settings — not found

- **Given** no settings row exists for installation id=99
- **When** I call `getInstallationSettings(db, 99)`
- **Then** it returns `null`

### Scenario GS-DB-3c: Upsert installation settings — create

- **Given** no settings row exists for installation id=5
- **When** I call `upsertInstallationSettings(db, 5, { providerChain: [...], ... })`
- **Then** a new row is created and returned

### Scenario GS-DB-3d: Upsert installation settings — update

- **Given** a settings row exists for installation id=5
- **When** I call `upsertInstallationSettings(db, 5, { aiReviewEnabled: false })`
- **Then** the existing row is updated (not duplicated)

## REQ-GS-DB-4: Effective Settings Resolution

The system MUST provide a function to resolve the effective settings for a repository.

### Scenario GS-DB-4a: Repo uses global settings

- **Given** repo has `use_global_settings = true`
- **And** installation has settings with provider_chain `[{provider: 'anthropic', ...}]`
- **When** I call `getEffectiveSettings(db, repoId)`
- **Then** it returns the installation-level settings

### Scenario GS-DB-4b: Repo uses custom settings

- **Given** repo has `use_global_settings = false`
- **And** repo has its own provider_chain
- **When** I call `getEffectiveSettings(db, repoId)`
- **Then** it returns the repo-level settings

### Scenario GS-DB-4c: Repo uses global but no installation settings exist

- **Given** repo has `use_global_settings = true`
- **And** no `installation_settings` row exists for its installation
- **When** I call `getEffectiveSettings(db, repoId)`
- **Then** it returns sensible defaults (empty chain, aiReviewEnabled=true, DEFAULT_REPO_SETTINGS)
