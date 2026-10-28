# Delta for Settings

> **Change**: extensible-static-analysis
> **Existing spec**: `openspec/specs/settings/spec.md`

## ADDED Requirements

### Requirement: enabled_tools JSONB Column

The `repositories` table MUST have an `enabled_tools` column of type JSONB, storing the list of explicitly enabled tool names as `string[]`.

Default value MUST be `null` (meaning: use tier defaults — all always-on tools activate, auto-detect tools activate based on file presence).

#### Scenario: New repo gets null enabled_tools

- GIVEN a new repository is created via installation webhook
- WHEN the row is inserted
- THEN `enabled_tools` MUST be `null`
- AND the runner MUST interpret `null` as "use tier defaults"

#### Scenario: User explicitly sets enabled_tools

- GIVEN a repository with `enabled_tools = null`
- WHEN the user saves `enabled_tools: ['semgrep', 'trivy', 'gitleaks']`
- THEN only those 3 tools MUST be eligible for activation
- AND all other tools (including other always-on tools) MUST be skipped unless auto-detected

### Requirement: disabled_tools JSONB Column

The `repositories` table MUST have a `disabled_tools` column of type JSONB, storing the list of explicitly disabled tool names as `string[]`.

Default value MUST be `[]` (empty array — no tools force-disabled).

#### Scenario: New repo gets empty disabled_tools

- GIVEN a new repository is created
- WHEN the row is inserted
- THEN `disabled_tools` MUST be `[]` (empty array)
- AND all tier-appropriate tools MUST be eligible for activation

#### Scenario: User disables a tool

- GIVEN a repository with `disabled_tools = []`
- WHEN the user saves `disabled_tools: ['cpd', 'markdownlint']`
- THEN CPD and markdownlint MUST NOT run for this repository
- AND all other tools MUST run as normal

### Requirement: Installation Settings Extension

The `installation_settings` table's `settings` JSONB column MUST also support `enabled_tools` and `disabled_tools` fields within the `RepoSettings` shape.

#### Scenario: Global disabled_tools inherited by repos

- GIVEN installation settings have `disabled_tools: ['cpd']`
- AND a repository uses global settings (`use_global_settings = true`)
- WHEN the runner resolves tools for this repo
- THEN CPD MUST NOT run

#### Scenario: Per-repo override of global tools

- GIVEN installation settings have `disabled_tools: ['cpd']`
- AND a repository uses custom settings (`use_global_settings = false`) with `disabled_tools: []`
- WHEN the runner resolves tools for this repo
- THEN CPD MUST run (repo overrides global)

### Requirement: DB Migration for Tool Columns

The system MUST provide a database migration that adds the new columns.

#### Scenario: Migration adds columns

- GIVEN the database is at the current schema version
- WHEN the migration runs
- THEN `enabled_tools` (JSONB, nullable) MUST be added to `repositories`
- AND `disabled_tools` (JSONB, default `[]`) MUST be added to `repositories`
- AND existing rows MUST receive default values

#### Scenario: Migration backfills from boolean flags

- GIVEN a repository with `enableSemgrep: false` in its `settings` JSONB
- WHEN the migration runs
- THEN `disabled_tools` SHOULD be backfilled with `['semgrep']`
- AND the old `enableSemgrep` field MUST be preserved in the JSONB (backward compat)

#### Scenario: Migration is non-destructive

- GIVEN existing data in the `repositories` table
- WHEN the migration runs
- THEN no existing columns MUST be dropped
- AND no existing data MUST be modified (except adding new column defaults)
- AND the migration MUST be reversible (drop new columns to rollback)

## MODIFIED Requirements

### Requirement: RepoSettings Interface Extension

The `RepoSettings` interface in the database schema MUST be extended with tool list fields.

(Previously: `RepoSettings` had `enableSemgrep: boolean`, `enableTrivy: boolean`, `enableCpd: boolean`)

The interface MUST add:
- `enabledTools?: string[]` — explicit tool enable list (optional, null = use defaults)
- `disabledTools?: string[]` — explicit tool disable list (optional, default `[]`)

The old boolean fields (`enableSemgrep`, `enableTrivy`, `enableCpd`) MUST remain for backward compatibility.

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

### Requirement: Settings API Tool Configuration

The `GET /api/settings` and `PUT /api/settings` endpoints MUST support the new tool list fields alongside the old boolean fields.

(Previously: API accepted/returned `enableSemgrep`, `enableTrivy`, `enableCpd`)

#### Scenario: GET returns both old and new fields

- GIVEN a repository with `disabled_tools: ['cpd']` and `enableCpd: false`
- WHEN `GET /api/settings?repo=owner/repo` is called
- THEN the response MUST include both `enableCpd: false` AND `disabledTools: ['cpd']`
- AND the response MUST include a new `registeredTools` array listing all known tool names with their tier and category

#### Scenario: PUT accepts old boolean fields (backward compat)

- GIVEN an older dashboard version sending `{ enableSemgrep: false }`
- WHEN `PUT /api/settings` is called
- THEN the server MUST accept the request
- AND MUST translate `enableSemgrep: false` to `disabled_tools` containing `'semgrep'` (if not already present)

#### Scenario: PUT accepts new tool list fields

- GIVEN a new dashboard sending `{ disabledTools: ['cpd', 'markdownlint'] }`
- WHEN `PUT /api/settings` is called
- THEN the server MUST save `disabled_tools: ['cpd', 'markdownlint']` in the database
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

### Requirement: Settings Zod Validation Extension

The `RepoSettingsSchema` Zod schema MUST be extended to accept the new fields.

(Previously: Schema validated `enableSemgrep`, `enableTrivy`, `enableCpd` as `z.boolean().optional()`)

#### Scenario: Zod validates new fields

- GIVEN a PUT request body with `disabledTools: ['semgrep', 'cpd']`
- WHEN Zod validation runs
- THEN it MUST accept `disabledTools` as `z.array(z.string()).optional()`
- AND it MUST accept `enabledTools` as `z.array(z.string()).optional()`

#### Scenario: Zod rejects invalid types

- GIVEN a PUT request body with `disabledTools: "semgrep"` (string instead of array)
- WHEN Zod validation runs
- THEN it MUST return a validation error

### Requirement: Inngest Event Data Extension

The Inngest review event data MUST include the resolved `enabledTools` and `disabledTools` arrays.

(Previously: Event data included `enableSemgrep`, `enableTrivy`, `enableCpd` booleans)

#### Scenario: Inngest event includes tool lists

- GIVEN a PR webhook triggers a review
- WHEN the webhook handler resolves effective settings
- THEN the Inngest event data MUST include `enabledTools` and `disabledTools`
- AND the old boolean fields MUST remain for backward compat during migration

## ADDED Requirements (Dashboard UI)

### Requirement: Tool Grid in Settings Page

The Settings page MUST display a tool grid showing all registered tools with enable/disable toggles, replacing the current 3 individual checkboxes.

#### Scenario: Tool grid renders all registered tools

- GIVEN the dashboard loads settings for a repository
- WHEN the Static Analysis section renders
- THEN it MUST display a grid of all registered tools (from `registeredTools` API response)
- AND each tool MUST show: display name, category badge, tier badge (always-on / auto-detect), and a toggle switch

#### Scenario: Tool grid reflects current state

- GIVEN a repository with `disabled_tools: ['cpd', 'markdownlint']`
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

## REMOVED Requirements

(None — old boolean fields are preserved as deprecated aliases, not removed)
