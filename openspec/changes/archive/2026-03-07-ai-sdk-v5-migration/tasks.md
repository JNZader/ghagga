# Tasks: AI SDK v5 Migration

**Change ID:** ai-sdk-v5-migration
**Status:** completed
**Date:** 2026-03-07

---

## Phase 1: Update Package Dependencies

### 1.1 Update `packages/core/package.json`

- [x] Change `"ai": "^4.3.0"` → `"ai": "^5.0.0"`
- [x] Change `"@ai-sdk/anthropic": "^1.2.0"` → `"@ai-sdk/anthropic": "^2.0.0"`
- [x] Change `"@ai-sdk/google": "^1.2.0"` → `"@ai-sdk/google": "^2.0.0"`
- [x] Change `"@ai-sdk/openai": "^1.3.0"` → `"@ai-sdk/openai": "^2.0.0"`
- [x] Change `"zod": "^3.24.0"` → `"zod": "^4.1.8"`

**File:** `packages/core/package.json` lines 54-60

### 1.2 Update `apps/server/package.json`

- [x] Change `"zod": "^3.24.0"` → `"zod": "^4.1.8"`

**File:** `apps/server/package.json` line 28

### 1.3 Install Dependencies

- [x] Run `pnpm install` from monorepo root
- [x] Verify no peer dependency warnings or resolution conflicts
- [ ] Commit the updated `pnpm-lock.yaml`

---

## Phase 2: Fix Breaking API Changes in Providers

### 2.1 Verify Provider Factory Functions (typecheck)

- [x] Run `pnpm typecheck` from monorepo root
- [x] Verify `createAnthropic({ apiKey })` compiles (line 50)
- [x] Verify `createOpenAI({ apiKey })` compiles (line 52)
- [x] Verify `createOpenAI({ apiKey, baseURL, name })` compiles (lines 56-72)
- [x] Verify `createGoogleGenerativeAI({ apiKey })` compiles (line 54)
- [x] Verify `import type { LanguageModel } from 'ai'` compiles (line 23)
- [x] Verify `providerInstance(model) as LanguageModel` cast compiles (line 96)

**File:** `packages/core/src/providers/index.ts`

**Action:** If any factory function signature changed, update the call. Based
on AI SDK v5 docs, the factory functions (`createAnthropic`, `createOpenAI`,
`createGoogleGenerativeAI`) still accept `{ apiKey }` and `{ apiKey, baseURL }`
options, so no changes are expected.

### 2.2 Verify Fallback Provider (typecheck)

- [x] Verify `generateText({ model, system, prompt, temperature })` compiles
- [x] Verify `result.usage?.inputTokens` and `result.usage?.outputTokens`
  access compiles (renamed from promptTokens/completionTokens)
- [x] Verify `result.text` access compiles

**File:** `packages/core/src/providers/fallback.ts`

---

## Phase 3: Fix Breaking API Changes in Agents

### 3.1 Verify Simple Agent (typecheck)

- [x] Verify `generateText()` call at line 175-180 compiles
- [x] Verify `result.usage` access at line 183 compiles (updated to inputTokens/outputTokens)
- [x] Verify `result.text` access is unchanged

**File:** `packages/core/src/agents/simple.ts`

### 3.2 Verify Consensus Agent (typecheck)

- [x] Verify `generateText()` call at line 220-225 compiles
- [x] Verify `result.usage` access at line 227 compiles (updated to inputTokens/outputTokens)
- [x] Verify `result.text` access is unchanged

**File:** `packages/core/src/agents/consensus.ts`

### 3.3 Verify Workflow Agent (typecheck)

- [x] Verify specialist `generateText()` calls at lines 113-118 compile
- [x] Verify synthesis `generateText()` call at lines 178-183 compiles
- [x] Verify `result.usage` access at lines 124 and 186 compiles (updated to inputTokens/outputTokens)
- [x] Verify `result.text` access is unchanged

**File:** `packages/core/src/agents/workflow.ts`

---

## Phase 4: Fix Zod v4 Changes

### 4.1 Verify Zod Schema Compilation

- [x] Verify `z.object()`, `z.boolean()`, `z.string()`, `z.enum()`,
  `z.union()`, `z.array()` still compile
- [x] Verify `.optional()`, `.strict()`, `.safeParse()` still compile
- [x] Verify the `import { z } from 'zod'` import still works

**File:** `apps/server/src/routes/api/settings.ts` lines 17, 24-35

### 4.2 Check `.issues` vs `.errors` on `ZodError`

- [x] If `parsed.error.issues` causes a type error, change to `parsed.error.errors`
  → No change needed: `.issues` still compiles with Zod v4 (backward compatible alias)
- [x] Verify `.path` and `.message` properties still exist on error items

**File:** `apps/server/src/routes/api/settings.ts` line 148

```typescript
// If needed, change:
details: parsed.error.issues.map((i) => ({
// To:
details: parsed.error.errors.map((i) => ({
```

### 4.3 Verify TypeScript Performance

- [x] After all changes, check that `pnpm typecheck` completes in reasonable
  time (< 30 seconds) — both packages typecheck instantly
- [x] If slow, verify `tsconfig.base.json` has compatible `moduleResolution`
  → Not needed, typecheck is fast
- [x] If needed, ensure zod version is `>=4.1.8` (not an earlier v4 release)
  → Confirmed via package.json constraint

---

## Phase 5: Run Tests and Fix Failures

### 5.1 Run Full Test Suite

- [x] Run `pnpm test` from monorepo root
- [x] Record which tests pass and which fail
  → 4 failures in fallback.test.ts and workflow.test.ts (mock usage property names)

### 5.2 Fix Failing Tests (if any)

Expected areas where tests might need updates:

#### 5.2.1 Mock Return Types

If `generateText` return type changed in ways that affect even `as any` casts:
- [x] Update `fallback.test.ts` mock return values if needed
  → Changed promptTokens→inputTokens, completionTokens→outputTokens in mocks
- [x] Update `workflow.test.ts` mock return values if needed
  → Changed promptTokens→inputTokens, completionTokens→outputTokens in mocks
- [x] Update `consensus-review.test.ts` mock return values if needed
  → Changed promptTokens→inputTokens, completionTokens→outputTokens in mocks

**Files:**
- `packages/core/src/providers/fallback.test.ts`
- `packages/core/src/agents/workflow.test.ts`
- `packages/core/src/agents/consensus-review.test.ts`

#### 5.2.2 Zod Error Assertions

- [x] If `apps/server` has tests that assert on Zod error shapes, verify they
  still pass with Zod v4 — all 475 server tests pass

### 5.3 Run Full Test Suite Again

- [x] Run `pnpm test` — all tests MUST pass (1328 core + 475 server = 1803 total)
- [x] Run `pnpm typecheck` — zero type errors

---

## Phase 6: Final Verification

### 6.1 Build Check

- [x] Run `pnpm build` to verify the full monorepo builds
  → `pnpm exec turbo typecheck build` — 14/14 tasks successful
- [x] Verify no runtime import errors in the built output

### 6.2 Review Checklist

- [x] `ai@^5.0.0` installed and resolved
- [x] `@ai-sdk/anthropic@^2.0.0` installed and resolved
- [x] `@ai-sdk/google@^2.0.0` installed and resolved
- [x] `@ai-sdk/openai@^2.0.0` installed and resolved
- [x] `zod@^4.1.8` installed and resolved (both packages)
- [x] `pnpm typecheck` passes
- [x] `pnpm test` passes
- [x] `pnpm build` passes
- [x] No breaking changes missed

---

## Estimated Effort

| Phase     | Estimate    | Notes                                         |
| --------- | ----------- | --------------------------------------------- |
| Phase 1   | 5 min       | Package.json edits + install                  |
| Phase 2   | 10 min      | Typecheck-driven; likely zero code changes    |
| Phase 3   | 10 min      | Typecheck-driven; likely zero code changes    |
| Phase 4   | 10 min      | One possible `.issues` → `.errors` change     |
| Phase 5   | 15 min      | Run tests, fix any mock/assertion issues      |
| Phase 6   | 5 min       | Build + final verification                    |
| **Total** | **~55 min** | Low-risk migration due to minimal API surface |

## Dependencies

- Phase 2-4 depend on Phase 1 (packages must be installed first)
- Phase 5 depends on Phases 2-4 (code must compile first)
- Phase 6 depends on Phase 5 (tests must pass first)
