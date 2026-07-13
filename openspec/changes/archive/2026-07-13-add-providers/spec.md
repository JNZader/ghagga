# Spec: Add 4 New OpenAI-Compatible LLM Providers

**Status**: draft  
**Proposal**: [proposal.md](./proposal.md)  
**Date**: 2026-03-16  

## Requirements

### R1: Type System Updates

The system MUST extend the `LLMProvider` union type to include `'groq' | 'cerebras' | 'deepseek' | 'openrouter'`, bringing the total from 6 to 10 providers.

The system MUST extend the `SaaSProvider` union type to include all 4 new providers (all are SaaS-compatible, unlike Ollama).

The `LLMProvider` and `SaaSProvider` types MUST be updated in both:
- `packages/core/src/types.ts` (source of truth)
- `packages/types/src/api.ts` (API contract mirror)

### R2: Provider Factory

The `createProvider()` function MUST handle all 4 new providers using `createOpenAI()` from `@ai-sdk/openai` with provider-specific `baseURL` and `name`.

Base URLs:
- Groq: `https://api.groq.com/openai/v1`
- Cerebras: `https://api.cerebras.ai/v1`
- DeepSeek: `https://api.deepseek.com/v1`
- OpenRouter: `https://openrouter.ai/api/v1`

The exhaustive `never` check at the end of the switch MUST continue to compile without errors.

### R3: Default Models

`DEFAULT_MODELS` MUST include entries for all 10 providers:
- `groq`: `'llama-3.3-70b-versatile'`
- `cerebras`: `'gpt-oss-120b'`
- `deepseek`: `'deepseek-chat'`
- `openrouter`: `'deepseek/deepseek-r1:free'`

### R4: Database Schema

`DbProviderChainEntry.provider` union in `packages/db/src/schema.ts` MUST include all 4 new provider strings.

No database migration is required — the column is JSONB and accepts any string value.

### R5: Server Validation

`CURATED_MODELS` MUST include entries for all 4 new providers with at least 3 models each.

`validateProviderKey()` MUST handle all 4 new providers. All 4 SHOULD use the existing `validateOpenAI()` function with the provider's base URL (since they all expose an OpenAI-compatible `/models` endpoint).

### R6: Route Guards

All `VALID_SAAS_PROVIDERS` arrays and `validProviders` arrays in server routes MUST include the 4 new providers:
- `apps/server/src/routes/api/settings.ts` — two arrays (PUT handler + POST validate)
- `apps/server/src/routes/api/installations.ts` — one array (PUT handler)

### R7: Frontend UI

`PROVIDER_OPTIONS` in `ProviderEntry.tsx` MUST include entries for all 4 new providers with descriptive labels:
- `{ value: 'groq', label: 'Groq' }`
- `{ value: 'cerebras', label: 'Cerebras' }`
- `{ value: 'deepseek', label: 'DeepSeek' }`
- `{ value: 'openrouter', label: 'OpenRouter' }`

The `available` providers list in `ProviderChainEditor.tsx` MUST include all 4 new providers so they appear as options when adding a fallback.

The chain editor's max provider limit (currently `chain.length < 5`) SHOULD be increased to accommodate the expanded provider set (10 providers available).

### R8: Backward Compatibility

Existing provider configurations MUST NOT be affected. All existing tests MUST pass without modification to their logic (only count assertions may change).

API keys for new providers MUST be handled identically to existing ones (AES-256-GCM encryption at rest, same encrypt/decrypt flow).

## Scenarios

### S1: User adds Groq as primary provider

**Given** a user with a valid Groq API key  
**When** they select "Groq" from the provider dropdown in the dashboard  
**And** enter their API key and click "Validate"  
**Then** the system calls `GET https://api.groq.com/openai/v1/models` with Bearer auth  
**And** returns a filtered list of chat-capable models  
**And** the user can select a model and save the configuration  

### S2: Provider chain fallback with new providers

**Given** a repo configured with chain: [DeepSeek (primary), Groq (fallback)]  
**When** a PR is opened and DeepSeek returns a retryable error  
**Then** the pipeline falls back to Groq  
**And** the review completes using the Groq provider  

### S3: CLI usage with new providers

**Given** a user running `ghagga review --provider cerebras --model gpt-oss-120b`  
**When** the review executes  
**Then** `createModel('cerebras', 'gpt-oss-120b', apiKey)` produces a valid LanguageModel  
**And** the review completes normally  

### S4: OpenRouter with free model

**Given** a user configuring OpenRouter with model `deepseek/deepseek-r1:free`  
**When** validation runs  
**Then** the system validates against `https://openrouter.ai/api/v1/models`  
**And** the free model is available in the model list  

### S5: TypeScript exhaustive check

**Given** a developer adds a new provider string to `LLMProvider`  
**But** forgets to add the corresponding case in `createProvider()`  
**Then** TypeScript reports a compile error on the `never` exhaustive check  

### S6: Invalid API key for new provider

**Given** a user enters an invalid API key for Cerebras  
**When** they click "Validate"  
**Then** the system calls the Cerebras models endpoint  
**And** receives a 401 response  
**And** returns `{ valid: false, error: 'Invalid API key' }`  

### S7: Existing providers unaffected

**Given** an existing repo with Anthropic + OpenAI configured  
**When** the code changes are deployed  
**Then** the existing configuration continues to work identically  
**And** no migration or reconfiguration is needed  

## Edge Cases

- **OpenRouter model IDs contain slashes** (e.g., `deepseek/deepseek-r1:free`): The system MUST handle model IDs with special characters in both the frontend dropdown and backend processing.
- **Groq rate limits** (tokens per minute): The provider pipeline's existing retry logic handles 429 responses, no special handling needed.
- **DeepSeek's minimal cost** ($0.004/day): No billing integration needed — users manage their own API keys.
- **Cerebras model naming**: The `gpt-oss-120b` model name MAY change; curated list can be updated.

## Non-Functional Requirements

- **No new dependencies**: All 4 providers use the existing `@ai-sdk/openai` package.
- **No database migration**: JSONB columns accept any provider string.
- **Performance**: No impact — same code path as existing OpenAI-compatible providers.
