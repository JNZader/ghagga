# Delta for Settings

> **Change**: `nightly-health-digest`
> **Existing spec**: `openspec/specs/settings/spec.md` (Section 5.5, RepoSettings Interface Extension)

## MODIFIED Requirements

### Requirement: RepoSettings Interface Extension

The `RepoSettings` interface MUST include:

- `enabledTools?: string[]` — explicit tool enable list (optional, null = use defaults)
- `disabledTools?: string[]` — explicit tool disable list (optional, default `[]`)
- `digestsEnabled?: boolean` — nightly health digest opt-in (optional, absent = off)

The old boolean fields (`enableSemgrep`, `enableTrivy`, `enableCpd`) MUST remain for backward compatibility.

`digestsEnabled` MUST resolve through the existing effective-settings flow: installation-level values apply to repositories using global settings (`use_global_settings = true`); per-repo values override when `use_global_settings = false`; an absent field at every level resolves to off. This follows the optional-boolean-off precedent of `explanationsEnabled`.

> **Previously**: `RepoSettings` carried the tool list fields (`enabledTools`, `disabledTools`) alongside the legacy booleans — no digest flag existed.

#### Scenario: digestsEnabled defaults to off

- GIVEN a repository (newly created or pre-existing) whose settings JSONB carries no `digestsEnabled` field at either the repo or installation level
- WHEN effective settings are resolved for digest scheduling
- THEN `digestsEnabled` MUST resolve to `false`
- AND no digest repeatable job MUST be registered for that repository

#### Scenario: Global enable with per-repo override

- GIVEN installation settings have `digestsEnabled: true`
- AND repository A uses global settings (`use_global_settings = true`) while repository B has `use_global_settings = false` with `digestsEnabled: false`
- WHEN effective settings are resolved for both repositories
- THEN repository A MUST resolve `digestsEnabled: true`
- AND repository B MUST resolve `digestsEnabled: false` (per-repo value overrides global)
