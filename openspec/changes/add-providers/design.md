# Design: Add 4 New OpenAI-Compatible LLM Providers

**Status**: draft  
**Spec**: [spec.md](./spec.md)  
**Date**: 2026-03-16  

## Architecture Decision

### AD1: Pure Pattern Replication

**Decision**: Replicate the existing Qwen provider pattern for all 4 new providers, with no abstraction layer.

**Rationale**: All 4 providers use OpenAI-compatible APIs. The existing codebase handles this via `createOpenAI({ apiKey, baseURL, name })`. Introducing a "generic OpenAI-compatible provider" abstraction would:
- Add complexity with no benefit (each still needs its own type union entry, curated models, and validation)
- Break the exhaustive `never` check pattern
- Make the code less explicit about which providers are supported

**Alternatives Considered**:
1. **Generic "openai-compatible" provider with config**: Rejected — would require a provider registry/config system, loses type safety, makes the dashboard UI harder (dynamic labels vs static list).
2. **Provider metadata object**: Considered for future (>15 providers) but premature now. 10 explicit providers in a switch is still clear.

### AD2: Validation via `validateOpenAI()` Reuse

**Decision**: All 4 new providers use the existing `validateOpenAI(apiKey, baseURL)` function for key validation, since they all expose the standard `/models` endpoint.

**Rationale**: Unlike Qwen (which needed a fallback to `/chat/completions`), these 4 providers have reliable `/models` endpoints. No provider-specific validation functions are needed.

**Special case — OpenRouter**: The `/models` endpoint returns models from multiple underlying providers. The existing filter logic (excluding embedding, tts, etc.) works correctly since OpenRouter only lists chat-capable models.

### AD3: Frontend Provider Limit Increase

**Decision**: Increase the chain editor's max providers from 5 to 8.

**Rationale**: With 10 available providers (9 SaaS-eligible), the current limit of 5 was set when only 5 SaaS providers existed. Increasing to 8 allows users to configure meaningful fallback chains without going to an extreme.

## Implementation Map

### Layer 1: Core Types (packages/core, packages/types, packages/db)

```
packages/core/src/types.ts
├── LLMProvider: add 'groq' | 'cerebras' | 'deepseek' | 'openrouter'
├── SaaSProvider: add 'groq' | 'cerebras' | 'deepseek' | 'openrouter'
└── DEFAULT_MODELS: add 4 new entries

packages/types/src/api.ts
├── LLMProvider: mirror core
└── SaaSProvider: mirror core

packages/db/src/schema.ts
└── DbProviderChainEntry.provider: add 4 new strings
```

### Layer 2: Provider Factory (packages/core)

```
packages/core/src/providers/index.ts
├── GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
├── CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1'
├── DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
├── OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
└── createProvider(): 4 new cases (identical pattern to qwen)
```

### Layer 3: Server Validation (apps/server)

```
apps/server/src/lib/provider-models.ts
├── CURATED_MODELS: 4 new entries
└── validateProviderKey(): 4 new cases → validateOpenAI(apiKey, baseURL)

apps/server/src/routes/api/settings.ts
├── VALID_SAAS_PROVIDERS (PUT): add 4 providers
└── validProviders (POST validate): add 4 providers

apps/server/src/routes/api/installations.ts
└── VALID_SAAS_PROVIDERS (PUT): add 4 providers
```

### Layer 4: Frontend (apps/dashboard)

```
apps/dashboard/src/components/settings/ProviderEntry.tsx
└── PROVIDER_OPTIONS: 4 new entries with labels

apps/dashboard/src/components/settings/ProviderChainEditor.tsx
├── available providers array: add 4 new providers
└── chain.length < 5 → chain.length < 8
```

### Layer 5: Tests

```
packages/core/src/providers/index.test.ts
└── 4 new test cases (groq, cerebras, deepseek, openrouter)

packages/core/src/types.test.ts
└── Update provider count: 6 → 10

apps/server/src/lib/provider-models.test.ts
└── Update CURATED_MODELS count: 5 → 9
└── Add validation tests for new providers

apps/cli/src/commands/review.test.ts
└── Update validProviders array
```

## Sequence Diagram: New Provider Validation

```
User → Dashboard → Server → Provider API
  |                  |            |
  |-- Select Groq -->|            |
  |-- Enter Key ---->|            |
  |-- Click Validate>|            |
  |                  |-- GET /models -->|
  |                  |<-- 200 + models -|
  |                  |-- filter chat ---|
  |<-- models list --|            |
  |-- Select model ->|            |
  |-- Save --------->|            |
  |                  |-- encrypt key -->|
  |                  |-- store JSONB -->|
  |<-- success ------|            |
```

## Curated Model Lists

```typescript
groq: [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'mixtral-8x7b-32768',
],
cerebras: [
  'gpt-oss-120b',
  'llama-4-scout-17b-16e-instruct',
  'llama3.1-8b',
  'qwen-3-32b',
],
deepseek: [
  'deepseek-chat',
  'deepseek-reasoner',
],
openrouter: [
  'deepseek/deepseek-r1:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemini-2.5-pro-exp-03-25:free',
  'meta-llama/llama-4-maverick:free',
],
```

## No Architectural Changes

This is a purely additive change. No new modules, patterns, or abstractions are introduced. The change follows the established provider integration pattern exactly.
