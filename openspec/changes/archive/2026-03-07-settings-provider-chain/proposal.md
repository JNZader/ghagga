# Proposal: Settings Redesign — Provider Chain & Static-Only Mode

## Intent

The current Settings page has poor UX: the LLM provider, API key, and model are disconnected fields. The user picks a provider, types a model name from memory, and saves the API key separately — with no validation that the key works or that the model exists. There's no way to configure fallback providers, and no option to run reviews with **only** static analysis (zero LLM cost).

This change redesigns Settings around a **validated provider chain** and a clear **static analysis toggle**, making the configuration flow guided and error-proof.

## Scope

### In Scope

- **Provider chain with priority ordering**: Users configure 1+ LLM providers in order. Each has its own API key + model. If #1 fails (rate limit, 5xx, timeout), it falls back to #2, etc.
- **Validate API key flow**: When the user enters a key for a provider, a "Validate" button tests it against the provider API. Only on success does the model dropdown populate with available models.
- **Dynamic model listing**: After validating a key, fetch available models from the provider's API (or use a curated list for providers without a models endpoint).
- **Static-only mode**: An "AI Review" master toggle. When OFF, only Semgrep/Trivy/CPD run — no LLM calls, no API key needed, no provider chain shown.
- **GitHub Models special case**: Uses the user's session token (no separate API key). Validate = test the session token against GitHub Models API.
- **Ollama excluded from SaaS dashboard**: Only available in CLI/Action. The dashboard doesn't show it as an option.
- **Review mode** (simple/workflow/consensus) stays as-is but is only visible when AI Review is enabled.
- **DB schema change**: Replace single `llm_provider` + `llm_model` + `encrypted_api_key` columns with a `provider_chain` JSONB column on `repositories`.
- **API routes**: New `GET/PUT /api/settings` routes (currently missing, dashboard 404s). Plus `POST /api/providers/validate` and `GET /api/providers/:provider/models`.
- **Core pipeline adaptation**: `reviewPipeline` and `inngest/review.ts` use the provider chain via `generateWithFallback`.

### Out of Scope

- **Drag & drop reordering** — v1 uses simple up/down arrows or numbered list. Drag & drop is a future polish.
- **Per-file or per-language provider overrides** — future feature.
- **Ollama in SaaS** — explicitly excluded per user decision.
- **Provider-specific rate limit display** — future feature.

## Approach

### Data Model

Replace the flat columns with a JSONB provider chain:

```typescript
// New JSONB shape for repositories.provider_chain
interface ProviderChainEntry {
  provider: LLMProvider; // 'github' | 'anthropic' | 'openai' | 'google'
  model: string; // 'gpt-4o-mini', 'claude-sonnet-4-20250514', etc.
  // API key stored encrypted in a separate column per provider,
  // or we can store encrypted keys per-entry in the JSONB.
  // Decision: store per-entry in JSONB for simplicity (already encrypted).
  encryptedApiKey: string | null; // null for GitHub Models (uses session token)
}

// repositories table changes:
// REMOVE: llm_provider, llm_model, encrypted_api_key
// ADD:    provider_chain jsonb DEFAULT '[]'
//         ai_review_enabled boolean DEFAULT true
```

### Validation Endpoint

`POST /api/providers/validate`
```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  // For github: no apiKey needed, uses session token
}
```
Returns: `{ valid: true, models: ["gpt-4o", "gpt-4o-mini", ...] }`

For providers without a models endpoint (Anthropic), return a curated static list.

### Pipeline Changes

`webhook.ts` reads `provider_chain` instead of flat fields. `inngest/review.ts` builds a `FallbackProvider[]` array from the chain and uses the existing `generateWithFallback()`. If `ai_review_enabled` is false, the pipeline skips agent execution entirely and returns only static analysis results.

### UI Flow

1. User opens Settings, selects a repo
2. Sees **Static Analysis** toggles (Semgrep, Trivy, CPD) — always visible
3. Sees **AI Review** toggle (on/off)
4. When AI Review is ON:
   - Shows provider chain list
   - Each entry: Provider dropdown → API Key input → [Validate] → Model dropdown (populated after validation)
   - "Add fallback provider" button at the bottom
   - Up/down arrows to reorder
   - Review Mode radio (simple/workflow/consensus)
5. When AI Review is OFF: provider chain and review mode are hidden

## Affected Areas

| Area                                    | Impact   | Description                                                                                                                            |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema.ts`             | Modified | Add `provider_chain` JSONB + `ai_review_enabled` boolean. Remove `llm_provider`, `llm_model`, `encrypted_api_key` columns.             |
| `packages/db/src/queries.ts`            | Modified | Update `updateRepoSettings` to handle new columns. Add migration helpers.                                                              |
| `packages/db/drizzle/`                  | New      | Migration to alter `repositories` table.                                                                                               |
| `packages/core/src/types.ts`            | Modified | Add `ProviderChainEntry` type. Update `ReviewInput` to accept chain. Remove `LLMProvider` from SaaS-only types (keep for CLI/Action).  |
| `packages/core/src/pipeline.ts`         | Modified | Support `ai_review_enabled=false` (skip agent, return static-only result). Accept provider chain for fallback.                         |
| `apps/server/src/routes/api.ts`         | Modified | Add `GET/PUT /api/settings`, `POST /api/providers/validate`, `GET /api/providers/:provider/models`. Refactor existing settings routes. |
| `apps/server/src/routes/webhook.ts`     | Modified | Read `provider_chain` instead of flat fields when dispatching to Inngest.                                                              |
| `apps/server/src/inngest/review.ts`     | Modified | Build `FallbackProvider[]` from chain. Handle `ai_review_enabled=false`.                                                               |
| `apps/dashboard/src/pages/Settings.tsx` | Modified | Complete rewrite — provider chain UI, validate flow, model dropdown, AI toggle.                                                        |
| `apps/dashboard/src/lib/types.ts`       | Modified | New types for provider chain, validation response.                                                                                     |
| `apps/dashboard/src/lib/api.ts`         | Modified | New hooks: `useValidateProvider`, `useProviderModels`. Update settings hooks for new shape.                                            |

## Risks

| Risk                                           | Likelihood | Mitigation                                                                                                                                       |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| DB migration breaks existing repos             | Medium     | Migration must set `provider_chain` from existing `llm_provider` + `llm_model` + `encrypted_api_key` values. Default `ai_review_enabled = true`. |
| Provider model listing APIs differ widely      | Medium     | Curated static lists as fallback for providers without `/models` endpoint (Anthropic, Google). Dynamic for OpenAI and GitHub Models.             |
| Encrypted API keys in JSONB vs separate column | Low        | Keys are already encrypted with AES-256-GCM. Storing in JSONB means multiple keys per repo. Encryption/decryption logic already exists.          |
| Settings page complexity increases             | Medium     | Clean component extraction: `ProviderChainEditor`, `ProviderEntry`, `ModelSelector` as separate components.                                      |
| Backward compatibility with CLI/Action         | Low        | CLI/Action still accept flat `--provider`/`--model`/`--api-key` flags. They don't use the DB provider chain. No change needed.                   |

## Rollback Plan

1. The DB migration adds NEW columns (`provider_chain`, `ai_review_enabled`) and keeps OLD columns (`llm_provider`, `llm_model`, `encrypted_api_key`) during a transition period.
2. If rollback is needed: revert the code, old columns are still populated by the migration's data copy step.
3. A second migration (run manually after confirming stability) drops the old columns.

## Dependencies

- Existing `generateWithFallback()` in `packages/core/src/providers/fallback.ts` — already implemented, just needs wiring.
- Provider model list APIs: OpenAI (`GET /v1/models`), GitHub Models (OpenAI-compatible), Anthropic (static list), Google (static list).

## Success Criteria

- [ ] User can configure 0-N LLM providers in priority order per repo
- [ ] Validating an API key returns available models for that provider
- [ ] GitHub Models works without a separate API key (uses session token)
- [ ] AI Review can be toggled off — reviews run static analysis only
- [ ] Ollama does NOT appear as an option in the SaaS dashboard
- [ ] Existing repos are auto-migrated (old settings preserved in new format)
- [ ] `generateWithFallback()` is used by the review pipeline when AI is enabled
- [ ] Pipeline produces valid results with `ai_review_enabled = false` (static-only)
- [ ] Settings page loads, saves, and round-trips without data loss
