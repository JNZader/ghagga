# Proposal: Global Settings with Per-Repo Override

## Intent

Users who install the GHAGGA GitHub App across multiple repositories must currently configure the provider chain (API keys, models, fallback order) on every single repo individually. This is tedious and error-prone — if someone has 10 repos, they'd enter the same Anthropic key 10 times. We need a global settings layer at the **installation** (org/user) level that all repos inherit by default, with the option to override for specific repos when needed.

## Scope

### In Scope

- New `installation_settings` table with its own `provider_chain`, `ai_review_enabled`, `review_mode`, and shared `settings` (static analysis toggles, ignore patterns, custom rules)
- New server API routes: `GET/PUT /api/installation-settings`
- New dashboard page: **Global Settings** — accessible from the sidebar, configures the installation-level defaults
- Per-repo Settings page gets a toggle: "Use global settings" (default: `true`) vs. "Use custom settings for this repo"
- Webhook/Inngest resolution: when dispatching a review, resolve the effective settings by checking repo first, falling back to installation
- Migration: existing per-repo provider chains stay as-is (repos that already have a chain configured will be treated as having custom overrides)

### Out of Scope

- Multi-installation support in the Global Settings page (one page per installation; users with multiple installations pick which one to configure)
- CLI/Action global settings (they configure per-invocation via flags/env vars)
- Settings templates or presets
- Audit log for settings changes

## Approach

**Opción A (chosen): `installation_settings` table + `use_global_settings` boolean on `repositories`.**

The `installations` table gets a companion `installation_settings` table (1:1 relationship) with the same fields that repos have: `provider_chain` JSONB, `ai_review_enabled`, `review_mode`, and `settings` JSONB.

The `repositories` table gets a new `use_global_settings` boolean (default `true`).

**Resolution logic** (in webhook.ts before dispatching to Inngest):
```
if repo.use_global_settings:
  settings = installation_settings[repo.installationId]
else:
  settings = repo's own settings
```

This is explicit, easy to reason about, and doesn't change any existing per-repo behavior.

**Dashboard flow:**
1. Sidebar gets a new "Global Settings" link (above the per-repo Settings)
2. Global Settings page reuses the same ProviderChainEditor and settings form, but saves to the installation level
3. Per-repo Settings page shows a toggle at the top: "Use global settings (recommended)" / "Override with custom settings for this repo". When global is selected, the form is read-only showing inherited values. When custom is selected, the full form becomes editable.

## Affected Areas

| Area                                          | Impact   | Description                                                                                                                          |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/src/schema.ts`                   | New      | Add `installationSettings` table definition                                                                                          |
| `packages/db/src/queries.ts`                  | Modified | Add `getInstallationSettings`, `upsertInstallationSettings` queries. Modify repo queries to include `useGlobalSettings`.             |
| `packages/db/drizzle/0003_*.sql`              | New      | Migration to create `installation_settings` table + add `use_global_settings` column to `repositories`                               |
| `apps/server/src/routes/api.ts`               | Modified | Add `GET/PUT /api/installation-settings` routes. Modify `GET /api/settings` to include `useGlobalSettings` + resolved global values. |
| `apps/server/src/routes/webhook.ts`           | Modified | Resolve effective settings (repo vs installation) before dispatching Inngest event                                                   |
| `apps/dashboard/src/lib/types.ts`             | Modified | Add `InstallationSettings` type, update `RepositorySettings` with `useGlobalSettings`                                                |
| `apps/dashboard/src/lib/api.ts`               | Modified | Add `useInstallationSettings`, `useUpdateInstallationSettings` hooks                                                                 |
| `apps/dashboard/src/pages/GlobalSettings.tsx` | New      | Installation-level settings page                                                                                                     |
| `apps/dashboard/src/pages/Settings.tsx`       | Modified | Add "Use global settings" toggle, read-only inherited view                                                                           |
| `apps/dashboard/src/components/Layout.tsx`    | Modified | Add "Global Settings" to sidebar nav                                                                                                 |

## Risks

| Risk                                                 | Likelihood | Mitigation                                                                                                                                       |
| ---------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing repos with provider_chain lose their config | Low        | Migration sets `use_global_settings = false` for repos that already have a non-empty `provider_chain`. Empty-chain repos get `true`.             |
| Confusion about which settings are active            | Medium     | Dashboard clearly shows "Inherited from Global" badge with current values. Toggle makes it explicit.                                             |
| Installation settings not found (new installations)  | Low        | Lazy-create: if no `installation_settings` row exists, use sensible defaults (same as current repo defaults). API creates the row on first save. |
| User has multiple installations                      | Low        | Dashboard installation selector (already scoped by `user.installationIds`). Global Settings operates on the selected installation.               |

## Rollback Plan

1. Set `use_global_settings = false` on all repositories (one SQL UPDATE)
2. This makes every repo use its own settings, effectively disabling the global layer
3. The `installation_settings` table can be left in place (harmless) or dropped
4. No data loss — per-repo settings remain intact throughout

## Dependencies

- Settings Provider Chain feature (completed ✅) — this builds directly on top of it
- The dashboard's `ProviderChainEditor` component is reused as-is for the Global Settings page

## Success Criteria

- [ ] User can configure provider chain + settings once at the installation level
- [ ] New repos automatically inherit global settings without any manual configuration
- [ ] User can override global settings for a specific repo by toggling "Use custom settings"
- [ ] Webhook correctly resolves effective settings (global vs repo-specific) before dispatching review
- [ ] Existing repos with custom provider chains are NOT affected (migrated as overrides)
- [ ] Dashboard clearly indicates whether a repo uses global or custom settings
