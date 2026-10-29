# Design: Settings Redesign — Provider Chain & Static-Only Mode

## Technical Approach

Migrate from flat per-repo LLM columns (`llm_provider`, `llm_model`, `encrypted_api_key`) to a JSONB `provider_chain` array + `ai_review_enabled` boolean. Add Settings API routes (`GET/PUT /api/settings` + `POST /api/providers/validate`). Wire the existing `generateWithFallback()` into the review pipeline. Rewrite the dashboard Settings page with a `ProviderChainEditor` component that follows a validate-then-select-model flow.

## Architecture Decisions

### Decision: JSONB Array vs Separate `provider_keys` Table

**Choice**: Single JSONB column `provider_chain` on `repositories` table
**Alternatives considered**: Separate `provider_keys` table with FK to `repositories`
**Rationale**: The chain is always read/written as a whole unit — never queried independently. A JSONB array avoids joins, simplifies the update (single SET), and keeps the schema flat. The chain has at most ~4 entries per repo, so no indexing concerns. Encrypted API keys are already opaque strings — storing them in JSONB is equivalent to storing in a column.

### Decision: Server-Side Validation via Lightweight API Call

**Choice**: Validate keys by calling the provider's models endpoint (or a minimal generation for providers without one)
**Alternatives considered**:
1. Client-side validation (browser calls provider API directly) — CORS issues, exposes keys in browser network tab
2. Just trust the user-provided key — bad UX, errors only surface at review time

**Rationale**: Server-side keeps keys secure (only transit to our server, never to browser). OpenAI and GitHub Models have `GET /v1/models` endpoints. Anthropic and Google don't have a public models list endpoint, so we use a minimal `generateText()` call with a 1-token max to validate the key, then return a curated static model list.

### Decision: Curated Static Model Lists for Anthropic & Google

**Choice**: Hardcoded model lists updated with the codebase
**Alternatives considered**: Scrape documentation, use undocumented endpoints
**Rationale**: Anthropic has no public models list API. Google's is complex (requires project-level auth). A curated list of production models is sufficient — these change infrequently, and we can update the list with new releases. The list lives in a single `PROVIDER_MODELS` constant in the server, easy to maintain.

### Decision: API Key Preservation on Update (Merge Strategy)

**Choice**: If a chain entry in the PUT body has no `apiKey` field, preserve the existing encrypted key from DB
**Alternatives considered**: Require the full key on every save (forces user to re-enter keys)
**Rationale**: The dashboard never receives decrypted keys (only `maskedApiKey`). The user shouldn't need to re-enter keys just because they changed the model or reordered providers. The server merges by matching `provider` field between incoming chain and existing DB chain.

### Decision: Pipeline Graceful Degradation When All Providers Fail

**Choice**: Return static-only results with `NEEDS_HUMAN_REVIEW` status when all LLM providers fail
**Alternatives considered**: Fail the entire review, retry indefinitely
**Rationale**: Static analysis results are still valuable. The user gets partial feedback immediately. Inngest retries handle transient failures at the function level already (3 retries). If all retries exhaust, the review should still post what it has.

### Decision: SaaS Provider Type Subset

**Choice**: New type `SaaSProvider = 'anthropic' | 'openai' | 'google' | 'github'` — excludes `'ollama'`
**Alternatives considered**: Reuse `LLMProvider` everywhere and filter in UI only
**Rationale**: Type-level enforcement prevents Ollama from entering the DB via API. The validation endpoint and settings PUT both reject `'ollama'` at the type/validation layer. The core `LLMProvider` type remains unchanged for CLI/Action compatibility.

## Data Flow

### Settings Save Flow

```
Dashboard                    Server                         Database
   │                           │                               │
   │  PUT /api/settings        │                               │
   │  {repoFullName,           │                               │
   │   aiReviewEnabled,        │                               │
   │   providerChain: [        │                               │
   │     {provider, model},    │                               │
   │     {provider, model,     │                               │
   │      apiKey: "sk-..."}    │                               │
   │   ],                      │                               │
   │   reviewMode, ...}        │                               │
   │ ────────────────────────► │                               │
   │                           │  1. Find repo by fullName     │
   │                           │  2. Auth check                │
   │                           │  3. Read existing chain       │
   │                           │     from DB                   │
   │                           │ ◄──────────────────────────── │
   │                           │                               │
   │                           │  4. Merge: for each entry     │
   │                           │     - if apiKey provided:     │
   │                           │       encrypt(apiKey)         │
   │                           │     - if no apiKey but same   │
   │                           │       provider exists in DB:  │
   │                           │       preserve encryptedApiKey│
   │                           │     - if github provider:     │
   │                           │       encryptedApiKey = null  │
   │                           │                               │
   │                           │  5. Write merged chain + all  │
   │                           │     settings to DB            │
   │                           │ ─────────────────────────────►│
   │                           │                               │
   │  ◄──────────── 200 OK ── │                               │
```

### Provider Validation Flow

```
Dashboard                    Server                     Provider API
   │                           │                             │
   │ POST /api/providers/      │                             │
   │   validate                │                             │
   │ {provider, apiKey}        │                             │
   │ ────────────────────────► │                             │
   │                           │                             │
   │                           │  (OpenAI/GitHub Models)     │
   │                           │  GET /v1/models             │
   │                           │ ───────────────────────────►│
   │                           │  ◄─ 200 {data: [models]}── │
   │                           │                             │
   │                           │  (Anthropic/Google)         │
   │                           │  generateText({maxTokens:1})│
   │                           │ ───────────────────────────►│
   │                           │  ◄─ 200 (success = valid)── │
   │                           │  Return curated model list  │
   │                           │                             │
   │  ◄─ {valid, models} ──── │                             │
```

### Review Pipeline Flow (Updated)

```
Webhook ──► Inngest                    Core Pipeline
               │                            │
               │  Read repo from DB         │
               │  - provider_chain          │
               │  - ai_review_enabled       │
               │  - settings (tools, etc)   │
               │                            │
               │  If ai_review_enabled:     │
               │    Decrypt each entry's    │
               │    encryptedApiKey          │
               │    Build FallbackProvider[] │
               │                            │
               │  reviewPipeline({          │
               │    aiReviewEnabled,         │
               │    providerChain?,          │
               │    provider?, model?,       │  ◄── backward compat
               │    apiKey?,                 │
               │    settings                 │
               │  }) ─────────────────────► │
               │                            │  1. Parse diff
               │                            │  2. Static analysis
               │                            │  3. If !aiReviewEnabled:
               │                            │     → return static results
               │                            │  4. If aiReviewEnabled:
               │                            │     → generateWithFallback()
               │                            │     → agents (simple/workflow/consensus)
               │                            │  5. Merge static + AI
               │                            │  6. Persist memory
               │  ◄──── ReviewResult ────── │
```

## File Changes

| File                                                             | Action | Description                                                                                                                                      |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/src/schema.ts`                                      | Modify | Add `providerChain` JSONB + `aiReviewEnabled` boolean to `repositories`. Add `ProviderChainEntry` interface. Keep old columns during transition. |
| `packages/db/src/queries.ts`                                     | Modify | Update `updateRepoSettings` to accept `providerChain` + `aiReviewEnabled`.                                                                       |
| `packages/db/drizzle/XXXX_add_provider_chain.sql`                | Create | Migration: add columns, copy data from old to new, set defaults.                                                                                 |
| `packages/core/src/types.ts`                                     | Modify | Add `ProviderChainEntry`, `SaaSProvider` types. Add `aiReviewEnabled` + `providerChain` to `ReviewInput` as optional (backward compat).          |
| `packages/core/src/pipeline.ts`                                  | Modify | Add static-only path. Build fallback chain from `providerChain` or single `provider`/`model`/`apiKey`.                                           |
| `packages/core/src/providers/fallback.ts`                        | Modify | Minor: export types for reuse.                                                                                                                   |
| `apps/server/src/routes/api.ts`                                  | Modify | Add `GET /api/settings`, `PUT /api/settings`, `POST /api/providers/validate`. Merge logic for API keys.                                          |
| `apps/server/src/routes/webhook.ts`                              | Modify | Read `provider_chain` + `ai_review_enabled` instead of flat fields when dispatching to Inngest.                                                  |
| `apps/server/src/inngest/review.ts`                              | Modify | Build `FallbackProvider[]` from chain. Handle AI disabled.                                                                                       |
| `apps/server/src/lib/provider-models.ts`                         | Create | Curated static model lists + dynamic model fetching logic.                                                                                       |
| `apps/dashboard/src/pages/Settings.tsx`                          | Modify | Complete rewrite with new component structure.                                                                                                   |
| `apps/dashboard/src/components/settings/ProviderChainEditor.tsx` | Create | Main chain editor: list of entries, add/remove/reorder.                                                                                          |
| `apps/dashboard/src/components/settings/ProviderEntry.tsx`       | Create | Single provider row: dropdown, API key, validate, model select.                                                                                  |
| `apps/dashboard/src/lib/types.ts`                                | Modify | Add `ProviderChainEntry`, `SaaSProvider`, `ValidationResponse`. Update `RepositorySettings`.                                                     |
| `apps/dashboard/src/lib/api.ts`                                  | Modify | Add `useValidateProvider` mutation hook. Update `useSettings`/`useUpdateSettings` for new shape.                                                 |

## Interfaces / Contracts

### Database: `ProviderChainEntry` (JSONB shape)

```typescript
// Stored in repositories.provider_chain as JSONB array
interface ProviderChainEntry {
  provider: 'anthropic' | 'openai' | 'google' | 'github';
  model: string;
  encryptedApiKey: string | null; // null for GitHub Models
}
```

### Core: Updated `ReviewInput`

```typescript
interface ReviewInput {
  diff: string;
  mode: ReviewMode;
  settings: ReviewSettings;

  // Option A: Single provider (CLI/Action backward compat)
  provider?: LLMProvider;
  model?: string;
  apiKey?: string;

  // Option B: Provider chain (SaaS)
  providerChain?: FallbackProvider[];

  // NEW: AI review toggle
  aiReviewEnabled?: boolean; // defaults to true for backward compat

  context?: ReviewContext;
  db?: unknown;
  onProgress?: ProgressCallback;
}
```

### API: `POST /api/providers/validate` Request/Response

```typescript
// Request
interface ValidateProviderRequest {
  provider: 'anthropic' | 'openai' | 'google' | 'github';
  apiKey?: string; // required for all except 'github'
}

// Response
interface ValidateProviderResponse {
  valid: boolean;
  models: string[]; // populated on success, empty on failure
  error?: string; // human-readable error on failure
}
```

### API: `GET /api/settings` Response

```typescript
interface SettingsResponse {
  repoId: number;
  repoFullName: string;
  aiReviewEnabled: boolean;
  providerChain: ProviderChainView[]; // never includes encrypted keys
  reviewMode: ReviewMode;
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  customRules: string;
  ignorePatterns: string[];
}

interface ProviderChainView {
  provider: 'anthropic' | 'openai' | 'google' | 'github';
  model: string;
  hasApiKey: boolean;
  maskedApiKey?: string; // e.g., "sk-...xxxx"
}
```

### API: `PUT /api/settings` Request

```typescript
interface UpdateSettingsRequest {
  repoFullName: string;
  aiReviewEnabled: boolean;
  providerChain: ProviderChainUpdate[];
  reviewMode: ReviewMode;
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  customRules: string;
  ignorePatterns: string[];
}

interface ProviderChainUpdate {
  provider: 'anthropic' | 'openai' | 'google' | 'github';
  model: string;
  apiKey?: string; // only sent if new/changed — omitted to preserve existing
}
```

### Server: Curated Model Lists

```typescript
// apps/server/src/lib/provider-models.ts

const CURATED_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-4-20250414',
    'claude-3-5-haiku-20241022',
  ],
  google: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
};

// OpenAI and GitHub Models: fetch dynamically from GET /v1/models
// Filter to chat-capable models only (exclude embedding, tts, dall-e)
```

## Testing Strategy

| Layer       | What to Test                                    | Approach                                                                      |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Unit        | `mergeProviderChain()` — key preservation logic | Vitest: given old chain + update, assert correct merge                        |
| Unit        | `validateProviderKey()` — each provider branch  | Vitest: mock HTTP calls, test success/failure/timeout paths                   |
| Unit        | Pipeline static-only path                       | Vitest: `reviewPipeline()` with `aiReviewEnabled: false`, assert no LLM calls |
| Unit        | Pipeline fallback path                          | Vitest: mock primary fail, assert fallback called                             |
| Integration | `POST /api/providers/validate`                  | Vitest + Hono test client: mock provider APIs, test full endpoint             |
| Integration | `PUT /api/settings` merge logic                 | Vitest + test DB: save chain, update partially, verify keys preserved         |
| Integration | DB migration                                    | Run migration on test DB, verify data transformation                          |
| E2E         | Settings page flow                              | Playwright: select repo → add provider → validate → select model → save       |

## Migration / Rollout

### Phase 1: Add New Columns (Non-Breaking)

```sql
-- Migration: add_provider_chain
ALTER TABLE repositories
  ADD COLUMN provider_chain JSONB DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN ai_review_enabled BOOLEAN DEFAULT true NOT NULL;

-- Migrate existing data
UPDATE repositories
SET provider_chain = jsonb_build_array(
  jsonb_build_object(
    'provider', llm_provider,
    'model', COALESCE(llm_model, CASE
      WHEN llm_provider = 'github' THEN 'gpt-4o-mini'
      WHEN llm_provider = 'anthropic' THEN 'claude-sonnet-4-20250514'
      WHEN llm_provider = 'openai' THEN 'gpt-4o'
      WHEN llm_provider = 'google' THEN 'gemini-2.0-flash'
      ELSE 'gpt-4o-mini'
    END),
    'encryptedApiKey', encrypted_api_key
  )
)
WHERE llm_provider IS NOT NULL;
```

- Old columns remain. Code reads from NEW columns.
- If rollback needed: revert code, old columns still valid.

### Phase 2: Drop Old Columns (Future, Manual)

After confirming stability for 1+ weeks:

```sql
ALTER TABLE repositories
  DROP COLUMN llm_provider,
  DROP COLUMN llm_model,
  DROP COLUMN encrypted_api_key;
```

## Open Questions

- None — all decisions resolved based on user input and codebase analysis.
