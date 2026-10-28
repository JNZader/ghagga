# Design: Global Settings with Per-Repo Override

## Architecture Decision 1: Separate Table vs. Columns on Installations

**Decision**: New `installation_settings` table (1:1 with `installations`).

**Rationale**: The `installations` table is a lightweight identity table (github_id, login, type, is_active). Settings are a rich, evolving blob (JSONB chains, booleans, modes). Mixing them violates SRP and makes the installation upsert path more complex (would need to handle settings defaults on every webhook-created installation). A separate table with lazy-create is cleaner.

**Alternative rejected**: Adding columns directly to `installations` — simpler but couples identity with config, forces defaults on webhook upserts.

## Architecture Decision 2: Resolution at Webhook Time (not Pipeline Time)

**Decision**: Resolve effective settings in `webhook.ts` before dispatching to Inngest. The Inngest event always contains the fully-resolved settings.

**Rationale**:
- The pipeline (`packages/core`) is distribution-agnostic. It shouldn't know about installations or global settings — it just receives a `ReviewInput` with a resolved `providerChain`.
- Keeps core clean: no DB dependency in core.
- The webhook already has the DB handle and the repo data. Adding one more query (installation settings) is trivial.
- Inngest events become self-contained — if replayed, they use the settings captured at dispatch time.

**Alternative rejected**: Resolve in Inngest function — would work but adds DB call inside the durable function, couples Inngest to the installation concept.

## Architecture Decision 3: Preserve Per-Repo Settings on Global Toggle

**Decision**: When a user switches from custom to global, the repo's `provider_chain` is NOT deleted. Only the `use_global_settings` boolean flips.

**Rationale**: Users might want to experiment with global, then switch back. Deleting their custom chain would be destructive and frustrating. The chain just becomes "inactive" when global is enabled.

## Architecture Decision 4: Dashboard Reuses ProviderChainEditor

**Decision**: The Global Settings page uses the exact same `ProviderChainEditor` component as the per-repo Settings page.

**Rationale**: Same UI, same validation flow, same provider/validate/model-select workflow. Zero new components needed for the chain itself. Only the save target changes (installation vs repo).

## Architecture Decision 5: Installation Selector in Dashboard

**Decision**: For users with multiple installations, the Global Settings page shows a dropdown to pick the installation. For single-installation users, it's auto-selected.

**Rationale**: Most individual users have 1 installation. Orgs might have 1. The edge case of multiple installations (personal + org) is handled by a simple dropdown, not a complex routing scheme.

**Implementation**: Use `user.installationIds` from auth context. Fetch installation details (account_login) from a new lightweight endpoint or extend the existing repo endpoint.

## Data Flow: Settings Resolution

```
PR Webhook arrives
       │
       ▼
  Look up repo by github_repo_id
       │
       ▼
  repo.use_global_settings?
       │
  ┌────┴────┐
  │ true    │ false
  │         │
  ▼         ▼
  Query     Use repo's own
  installation_settings    provider_chain,
  for repo.installationId  ai_review_enabled,
       │                   review_mode, settings
       ▼                        │
  Found?                        │
  ├─ yes: use installation      │
  │       settings              │
  ├─ no: use defaults           │
  │      (empty chain,          │
  │       ai=true, simple)      │
  │                             │
  └─────────┬───────────────────┘
            ▼
    Dispatch to Inngest with
    resolved providerChain,
    aiReviewEnabled, reviewMode,
    settings
```

## Data Flow: Dashboard Global Settings

```
User opens Global Settings
       │
       ▼
  GET /api/installation-settings?installation_id=X
       │
       ▼
  Server returns settings (masked keys) or defaults
       │
       ▼
  User edits provider chain, toggles, etc.
       │
       ▼
  PUT /api/installation-settings
  { installationId, providerChain, ... }
       │
       ▼
  Server: validate, merge keys, upsert row
       │
       ▼
  200 OK → toast "Global settings saved"
```

## Data Flow: Per-Repo Settings with Global Toggle

```
User opens repo Settings
       │
       ▼
  GET /api/settings?repo=owner/repo
       │
       ▼
  Response includes:
  - useGlobalSettings: true/false
  - repo's own settings (providerChain, etc.)
  - globalSettings: { ... } (installation-level, for display)
       │
       ▼
  useGlobalSettings === true?
  ├─ yes: show read-only inherited view + "Edit Global →" link
  └─ no: show editable form (same as today)
       │
       ▼
  Toggle switch flips:
  PUT /api/settings { repoFullName, useGlobalSettings: true/false, ... }
```

## Schema: installation_settings

```sql
CREATE TABLE installation_settings (
  id SERIAL PRIMARY KEY,
  installation_id INTEGER NOT NULL UNIQUE REFERENCES installations(id),
  provider_chain JSONB NOT NULL DEFAULT '[]',
  ai_review_enabled BOOLEAN NOT NULL DEFAULT true,
  review_mode VARCHAR(20) NOT NULL DEFAULT 'simple',
  settings JSONB NOT NULL DEFAULT '{...}',  -- DEFAULT_REPO_SETTINGS equivalent
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

## API Shape: Installation Settings Response

```typescript
interface InstallationSettingsResponse {
  installationId: number;
  accountLogin: string;
  providerChain: ProviderChainView[]; // masked keys
  aiReviewEnabled: boolean;
  reviewMode: string;
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  customRules: string;
  ignorePatterns: string[];
}
```

## API Shape: Extended Repo Settings Response

```typescript
// Extends existing SettingsResponse
interface SettingsResponse {
  // ... existing fields ...
  useGlobalSettings: boolean;
  globalSettings?: InstallationSettingsResponse; // present when installation settings exist
}
```
