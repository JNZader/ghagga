# Tasks: Add 4 New OpenAI-Compatible LLM Providers

**Status**: ready  
**Design**: [design.md](./design.md)  
**Date**: 2026-03-16  

## Phase 1: Core Types (foundation — all other phases depend on this)

### 1.1 Update LLMProvider and SaaSProvider in core types
**File**: `packages/core/src/types.ts`  
**Change**:
- `LLMProvider`: add `| 'groq' | 'cerebras' | 'deepseek' | 'openrouter'` (6 → 10)
- `SaaSProvider`: add `| 'groq' | 'cerebras' | 'deepseek' | 'openrouter'` (5 → 9)
- `DEFAULT_MODELS`: add 4 new entries:
  - `groq: 'llama-3.3-70b-versatile'`
  - `cerebras: 'gpt-oss-120b'`
  - `deepseek: 'deepseek-chat'`
  - `openrouter: 'deepseek/deepseek-r1:free'`
**Estimate**: 5 min

### 1.2 Mirror type updates in API types package
**File**: `packages/types/src/api.ts`  
**Change**:
- `LLMProvider`: add `| 'groq' | 'cerebras' | 'deepseek' | 'openrouter'`
- `SaaSProvider`: add `| 'groq' | 'cerebras' | 'deepseek' | 'openrouter'`
**Estimate**: 2 min

### 1.3 Update DB schema provider union
**File**: `packages/db/src/schema.ts`  
**Change**:
- `DbProviderChainEntry.provider`: add `| 'groq' | 'cerebras' | 'deepseek' | 'openrouter'`
**Estimate**: 2 min

## Phase 2: Provider Factory (depends on Phase 1)

### 2.1 Add base URLs and switch cases
**File**: `packages/core/src/providers/index.ts`  
**Change**:
- Add 4 base URL constants:
  ```
  GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
  CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1'
  DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
  OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
  ```
- Add 4 `case` blocks in `createProvider()` switch — identical pattern to `qwen`
- Update JSDoc comment listing supported providers
**Estimate**: 5 min

## Phase 3: Server Validation & Routes (depends on Phase 1)

### 3.1 Add curated models and validation cases
**File**: `apps/server/src/lib/provider-models.ts`  
**Change**:
- Add 4 entries to `CURATED_MODELS`:
  ```
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768']
  cerebras: ['gpt-oss-120b', 'llama-4-scout-17b-16e-instruct', 'llama3.1-8b', 'qwen-3-32b']
  deepseek: ['deepseek-chat', 'deepseek-reasoner']
  openrouter: ['deepseek/deepseek-r1:free', 'deepseek/deepseek-chat-v3-0324:free', 'google/gemini-2.5-pro-exp-03-25:free', 'meta-llama/llama-4-maverick:free']
  ```
- Add 4 `case` blocks in `validateProviderKey()` — each calls `validateOpenAI(apiKey, BASE_URL)`
  - Groq: `return await validateOpenAI(apiKey, 'https://api.groq.com/openai/v1');`
  - Cerebras: `return await validateOpenAI(apiKey, 'https://api.cerebras.ai/v1');`
  - DeepSeek: `return await validateOpenAI(apiKey, 'https://api.deepseek.com/v1');`
  - OpenRouter: `return await validateOpenAI(apiKey, 'https://openrouter.ai/api/v1');`
**Estimate**: 10 min

### 3.2 Update settings route validation arrays
**File**: `apps/server/src/routes/api/settings.ts`  
**Change**:
- Line 263: `VALID_SAAS_PROVIDERS` — add `'groq', 'cerebras', 'deepseek', 'openrouter'`
- Line 489: `validProviders` — add `'groq', 'cerebras', 'deepseek', 'openrouter'`
**Estimate**: 2 min

### 3.3 Update installations route validation array
**File**: `apps/server/src/routes/api/installations.ts`  
**Change**:
- Line 167: `VALID_SAAS_PROVIDERS` — add `'groq', 'cerebras', 'deepseek', 'openrouter'`
**Estimate**: 2 min

## Phase 4: Frontend (depends on Phase 1)

### 4.1 Add provider options to ProviderEntry
**File**: `apps/dashboard/src/components/settings/ProviderEntry.tsx`  
**Change**:
- Add 4 entries to `PROVIDER_OPTIONS`:
  ```
  { value: 'groq', label: 'Groq' }
  { value: 'cerebras', label: 'Cerebras' }
  { value: 'deepseek', label: 'DeepSeek' }
  { value: 'openrouter', label: 'OpenRouter' }
  ```
**Estimate**: 2 min

### 4.2 Update ProviderChainEditor available providers
**File**: `apps/dashboard/src/components/settings/ProviderChainEditor.tsx`  
**Change**:
- Line 66: Add `'groq', 'cerebras', 'deepseek', 'openrouter'` to the available providers array
- Line 99: Change `chain.length < 5` → `chain.length < 8`
**Estimate**: 2 min

## Phase 5: Tests (depends on Phases 1–4)

### 5.1 Add provider factory tests
**File**: `packages/core/src/providers/index.test.ts`  
**Change**:
- Add 4 new test cases in `describe('createProvider')`:
  - `groq`: verifies `createOpenAI` called with Groq base URL and name
  - `cerebras`: verifies `createOpenAI` called with Cerebras base URL and name
  - `deepseek`: verifies `createOpenAI` called with DeepSeek base URL and name
  - `openrouter`: verifies `createOpenAI` called with OpenRouter base URL and name
**Estimate**: 5 min

### 5.2 Update types test provider count
**File**: `packages/core/src/types.test.ts`  
**Change**:
- Line 37–38: Update test description and providers array from 6 to 10:
  ```
  'should have entries for all 10 LLM providers'
  const providers = ['anthropic', 'openai', 'google', 'github', 'ollama', 'qwen',
                      'groq', 'cerebras', 'deepseek', 'openrouter'] as const;
  ```
**Estimate**: 2 min

### 5.3 Update provider-models tests
**File**: `apps/server/src/lib/provider-models.test.ts`  
**Change**:
- Update CURATED_MODELS count: `toHaveLength(5)` → `toHaveLength(9)`
- Update `arrayContaining` to include new providers
- Add validation test blocks for groq, cerebras, deepseek, openrouter (each tests valid key + invalid key scenarios)
**Estimate**: 10 min

### 5.4 Update CLI review test
**File**: `apps/cli/src/commands/review.test.ts`  
**Change**:
- Line 307: Add new providers to `validProviders` array
- Add `expect(validProviders).toContain('groq')` etc.
**Estimate**: 2 min

## Phase 6: Documentation (depends on all above)

### 6.1 Update .env.example
**File**: `.env.example`  
**Change**: Add commented-out env vars for new providers:
```
# GROQ_API_KEY=
# CEREBRAS_API_KEY=
# DEEPSEEK_API_KEY=
# OPENROUTER_API_KEY=
```
**Estimate**: 2 min

### 6.2 Update README provider section
**File**: `README.md` (or relevant docs)  
**Change**: Add new providers to the supported providers list
**Estimate**: 5 min

## Summary

| Phase | Tasks | Files | Est. Time |
|-------|-------|-------|-----------|
| 1. Core Types | 3 | 3 | 9 min |
| 2. Provider Factory | 1 | 1 | 5 min |
| 3. Server | 3 | 3 | 14 min |
| 4. Frontend | 2 | 2 | 4 min |
| 5. Tests | 4 | 4 | 19 min |
| 6. Documentation | 2 | 2 | 7 min |
| **Total** | **15** | **15** | **~58 min** |

## Execution Order

```
Phase 1 (types) ──→ Phase 2 (factory)
                ──→ Phase 3 (server)   ──→ Phase 5 (tests) ──→ Phase 6 (docs)
                ──→ Phase 4 (frontend)
```

Phases 2, 3, 4 can run in parallel after Phase 1 completes. Phase 5 depends on all code changes. Phase 6 is independent.

## Verification Checklist

- [ ] `pnpm typecheck` passes (exhaustive checks compile)
- [ ] `pnpm test` passes (all test suites green)
- [ ] Dashboard shows 9 providers in dropdown (5 existing + 4 new)
- [ ] Chain editor allows up to 8 providers
- [ ] Each new provider validates successfully with a real API key (manual test)
