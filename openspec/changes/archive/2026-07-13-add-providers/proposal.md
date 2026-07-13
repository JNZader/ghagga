# Proposal: Add 4 New OpenAI-Compatible LLM Providers

**Status**: draft  
**Author**: javier  
**Date**: 2026-03-16  

## Intent

Add four new LLM providers to GHAGGA: **Groq**, **Cerebras**, **DeepSeek**, and **OpenRouter**. All four expose OpenAI-compatible APIs and follow the exact same integration pattern as the existing Qwen provider (i.e., `createOpenAI()` from `@ai-sdk/openai` with a custom `baseURL` and `name`).

## Motivation

The current Gemini free tier (Google) has extremely low rate limits (20 RPM), making it impractical as a primary or even fallback provider for active repositories. Users need alternatives that offer:

| Provider | Tier | Limits | Speed | Default Model |
|----------|------|--------|-------|---------------|
| **Groq** | Free | 1K–14.4K req/day | Ultra-fast inference | `llama-3.3-70b-versatile` |
| **Cerebras** | Free | 14.4K req/day | 3000 tok/s | `gpt-oss-120b` |
| **DeepSeek** | Near-free ($0.004/day) | No rate limit | Fast | `deepseek-chat` |
| **OpenRouter** | Gateway (pay-per-use) | Varies by model | Varies | `deepseek/deepseek-r1:free` |

This diversifies the provider chain and gives users cost-effective options for high-volume code review.

## Scope

### In Scope

- Add `'groq' | 'cerebras' | 'deepseek' | 'openrouter'` to `LLMProvider` and `SaaSProvider` type unions
- Add base URLs and `createProvider()` switch cases
- Add curated model lists and `validateProviderKey()` cases
- Update all validation arrays (settings, installations routes)
- Add frontend dropdown options (ProviderEntry, ProviderChainEditor)
- Update `DEFAULT_MODELS` with sensible defaults
- Update `DbProviderChainEntry.provider` union in schema
- Update all test files (provider counts, validation tests, new test cases)
- Update documentation (README provider list, .env.example)

### Out of Scope

- Provider-specific features (e.g., OpenRouter's model routing, Groq's guardrails)
- Custom authentication flows (all 4 use standard Bearer token auth)
- Rate limiting middleware (handled externally by providers)
- Database migrations (JSONB columns accept any string — no schema migration needed)

## Approach

**Pattern replication**: All 4 providers follow the identical pattern established by Qwen:

```typescript
// In packages/core/src/providers/index.ts
case 'groq':
  return createOpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
    name: 'groq',
  });
```

This is a purely additive change — 13 code files + docs, no architectural decisions, no new dependencies.

### Base URLs

| Provider | Base URL |
|----------|----------|
| Groq | `https://api.groq.com/openai/v1` |
| Cerebras | `https://api.cerebras.ai/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

### Validation Strategy

All 4 providers support the OpenAI-compatible `/models` endpoint, so validation uses the existing `validateOpenAI()` function with the provider-specific base URL. This is the same approach used for Qwen but even simpler (no fallback to `/chat/completions` needed — these providers reliably expose `/models`).

## Affected Modules

| Package | Files | Change Type |
|---------|-------|-------------|
| `packages/core` | `types.ts`, `providers/index.ts` | Type unions, factory switch |
| `packages/types` | `api.ts` | Type unions (mirror of core) |
| `packages/db` | `schema.ts` | `DbProviderChainEntry.provider` union |
| `apps/server` | `provider-models.ts`, `settings.ts`, `installations.ts` | Validation, curated models, route guards |
| `apps/dashboard` | `ProviderEntry.tsx`, `ProviderChainEditor.tsx` | UI dropdown options |
| `apps/cli` | `review.test.ts` | Test validation |
| Tests | `index.test.ts`, `types.test.ts`, `provider-models.test.ts` | New test cases, updated counts |

## Distribution Mode Impact

| Mode | Impact |
|------|--------|
| **SaaS** | Full support — dashboard shows new providers, server validates keys |
| **CLI** | Full support — `--provider groq` etc. works via core types |
| **GitHub Action** | Full support — uses core provider factory |
| **1-click deploy** | Full support — environment variables follow existing pattern |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Provider API changes | Low | Low | OpenAI-compatible APIs are stable; fallback to curated models |
| Type union grows large | Low | Low | 10 providers is manageable; consider enum if >15 |
| OpenRouter free models deprecated | Medium | Low | Free tier is bonus; paid models always available |
| Test count hardcoding breaks | High | Low | Update all count assertions in tasks |

## Rollback Plan

Fully reversible — revert the commit. No database migration involved (JSONB columns accept any provider string). Existing provider configurations are untouched.

## Acceptance Criteria

1. All 4 providers appear in the SaaS dashboard provider dropdown
2. `createProvider()` and `createModel()` work for all 4 new providers
3. `validateProviderKey()` successfully validates API keys for all 4
4. TypeScript exhaustive checks pass (no `never` type errors)
5. All existing tests pass unchanged
6. New test cases cover all 4 providers
7. `DEFAULT_MODELS` has entries for all 10 providers (was 6)
8. Documentation updated with new provider options
