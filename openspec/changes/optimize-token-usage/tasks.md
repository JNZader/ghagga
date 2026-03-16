# Tasks: Optimize Token Usage for Free-Tier LLM Providers

**Status**: ready  
**Design**: [design.md](./design.md)  
**Date**: 2026-03-16  

## Phase 1: Utilities & Types (foundation — no dependencies)

### 1.1 Create concurrency limiter utility
**File**: `packages/core/src/utils/concurrency.ts` (NEW)  
**Change**:
- Implement `runWithConcurrency<T>(tasks, concurrency, delayMs?)`:
  - Accepts an array of `() => Promise<T>` task factories
  - Processes tasks in batches of `concurrency` size using `Promise.allSettled`
  - Applies `delayMs` between batches (if > 0)
  - Returns `PromiseSettledResult<T>[]` in original task order
- Implement `delay(ms)` helper (simple `setTimeout` promise wrapper)
- Export both functions
```typescript
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  delayMs = 0,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    if (i > 0 && delayMs > 0) {
      await delay(delayMs);
    }
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}
```
**Estimate**: 10 min

### 1.2 Create concurrency limiter tests
**File**: `packages/core/src/utils/concurrency.test.ts` (NEW)  
**Change**:
- Test `concurrency: 1` runs tasks sequentially (verify execution order via timestamps)
- Test `concurrency: 2` runs tasks in batches of 2
- Test `concurrency: 5` with 5 tasks runs all in parallel (single batch)
- Test `concurrency: 3` with 7 tasks produces batches [3, 3, 1]
- Test `delayMs: 100` inserts delay between batches (verify total time ≥ expected)
- Test `delayMs: 0` (default) inserts no delay
- Test error handling: failed tasks appear as `rejected` in results, other tasks still run
- Test empty task array returns empty results
- Test concurrency > tasks.length still works (single batch)
**Estimate**: 15 min

### 1.3 Add reviewConcurrency and reviewDelayMs to ReviewSettings
**File**: `packages/core/src/types.ts`  
**Change**:
- Add to `ReviewSettings` interface:
  ```typescript
  /** Max concurrent LLM calls in workflow/consensus modes (1=sequential, 5=parallel). Default: 2. */
  reviewConcurrency?: 1 | 2 | 3 | 5;
  /** Delay in ms between sequential LLM call batches. Default: 0. */
  reviewDelayMs?: number;
  ```
- Do NOT add to `DEFAULT_SETTINGS` (undefined = agent applies its own default)
**Estimate**: 3 min

## Phase 2: Fallback Enhancement (depends on Phase 1.3 for types)

### 2.1 Add 413 to retryable errors
**File**: `packages/core/src/providers/fallback.ts`  
**Change**:
- In `isRetryableError()`, modify the status code check:
  ```typescript
  // Before: return status >= 500;
  // After:
  return status >= 500 || status === 413;
  ```
- Add text-based detection after the status code check:
  ```typescript
  // Payload too large (some providers don't include status code in message)
  if (message.includes('too large') || message.includes('payload too large')) {
    return true;
  }
  ```
- Update JSDoc comment to mention 413
**Estimate**: 5 min

### 2.2 Add 413 fallback tests
**File**: `packages/core/src/providers/fallback.test.ts`  
**Change**:
- Add test: `'falls back to second provider on 413 error from first'`
  ```typescript
  mockGenerateText.mockRejectedValueOnce(new Error('status: 413 Request Entity Too Large'));
  mockGenerateText.mockResolvedValueOnce(successResult('413 fallback'));
  // Expect: result from second provider
  ```
- Add test: `'falls back on "too large" error message'`
  ```typescript
  mockGenerateText.mockRejectedValueOnce(new Error('Request too large for model context'));
  mockGenerateText.mockResolvedValueOnce(successResult('too large fallback'));
  ```
- Add test: `'falls back on "payload too large" error message'`
**Estimate**: 5 min

## Phase 3: Compact Prompts (depends on nothing, can run parallel with Phase 2)

### 3.1 Add compact calibration to prompts
**File**: `packages/core/src/agents/prompts.ts`  
**Change**:
- Add new exported constant:
  ```typescript
  export const COMPACT_CALIBRATION = `Only report findings you are 80%+ confident about based on the actual code shown. Do not flag stylistic preferences or hypothetical edge cases.`;
  ```
- Add builder function:
  ```typescript
  export function buildCompactCalibration(): string {
    return COMPACT_CALIBRATION;
  }
  ```
**Estimate**: 3 min

### 3.2 Add compact prompts tests
**File**: `packages/core/src/agents/prompts.test.ts`  
**Change**:
- Add test: `'COMPACT_CALIBRATION contains confidence threshold'`
  ```typescript
  expect(COMPACT_CALIBRATION).toContain('80%');
  ```
- Add test: `'COMPACT_CALIBRATION is shorter than REVIEW_CALIBRATION'`
  ```typescript
  expect(COMPACT_CALIBRATION.length).toBeLessThan(REVIEW_CALIBRATION.length);
  ```
- Add test: `'buildCompactCalibration returns COMPACT_CALIBRATION'`
**Estimate**: 5 min

## Phase 4: Workflow Agent Refactoring (depends on Phases 1, 2, 3)

### 4.1 Refactor WorkflowReviewInput to accept providerChain
**File**: `packages/core/src/agents/workflow.ts`  
**Change**:
- Update `WorkflowReviewInput`:
  ```typescript
  export interface WorkflowReviewInput {
    diff: string;
    providerChain: FallbackProvider[];  // replaces provider/model/apiKey
    staticContext: string;
    memoryContext: string | null;
    stackHints: string;
    reviewLevel: ReviewLevel;
    reviewConcurrency?: number;
    reviewDelayMs?: number;
    onProgress?: ProgressCallback;
  }
  ```
- Add imports: `FallbackProvider` and `generateWithFallback` from `../providers/fallback.js`
- Add imports: `runWithConcurrency` from `../utils/concurrency.js`
- Add import: `COMPACT_CALIBRATION` from `./prompts.js`
- Remove import: `generateTextWithTimeout`
- Remove import: `createModel`
**Estimate**: 5 min

### 4.2 Implement sequential batching and compact prompts in workflow
**File**: `packages/core/src/agents/workflow.ts`  
**Change**:
- Replace the specialist execution block (lines 100-136) with:
  ```typescript
  const concurrency = input.reviewConcurrency ?? 2;
  const delayMs = input.reviewDelayMs ?? 0;

  const specialistTasks = SPECIALISTS.map((specialist, index) => () => {
    // First specialist gets full context, rest get compact
    const isFirst = index === 0;
    const system = isFirst
      ? [specialist.system, staticContext, buildMemoryContext(memoryContext),
         stackHints, buildReviewLevelInstruction(reviewLevel), REVIEW_CALIBRATION]
      : [specialist.system, buildReviewLevelInstruction(reviewLevel), COMPACT_CALIBRATION];

    return generateWithFallback({
      providers: input.providerChain,
      system: system.filter(Boolean).join('\n'),
      prompt: userPrompt,
      temperature: 0.3,
    });
  });

  const results = await runWithConcurrency(specialistTasks, concurrency, delayMs);
  ```
- Update result collection to map `FallbackResult` instead of `generateTextWithTimeout` output
- Remove `createModel()` call (no longer needed — fallback creates models internally)
- Remove `languageModel` variable
- Update synthesis call to use `generateWithFallback` with `input.providerChain`
- Update provider/model in `parseReviewResponse` call to use `providerChain[0]` values
**Estimate**: 20 min

### 4.3 Update workflow tests for new interface
**File**: `packages/core/src/agents/workflow.test.ts`  
**Change**:
- Update `makeInput()` to use `providerChain` instead of `provider/model/apiKey`:
  ```typescript
  providerChain: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'sk-test-key' }],
  ```
- Update mock setup: mock `generateWithFallback` instead of `generateText`
- Mock `runWithConcurrency` or let it execute (testing the real utility is fine)
- Add mock for `../providers/fallback.js` with `generateWithFallback`
- Add mock for `../utils/concurrency.js` if needed for call-order assertions
- Update existing tests:
  - `'creates the language model...'` → verify `providerChain` is passed through
  - `'makes exactly 5 specialist calls + 1 synthesis call'` → verify 6 calls to `generateWithFallback`
  - Token counting tests → adapt to `FallbackResult.tokensUsed` shape
  - System prompt tests → verify first specialist gets full context, rest get compact
- Add new tests:
  - `'first specialist gets full shared context'`
  - `'specialists 2-5 get compact calibration only'`
  - `'synthesis call gets full REVIEW_CALIBRATION'`
  - `'respects reviewConcurrency setting'`
  - `'respects reviewDelayMs setting'`
  - `'uses generateWithFallback for each specialist call'`
**Estimate**: 30 min

## Phase 5: Consensus Agent Refactoring (depends on Phases 1, 2)

### 5.1 Refactor ConsensusReviewInput for concurrency and fallback
**File**: `packages/core/src/agents/consensus.ts`  
**Change**:
- Update `ConsensusReviewInput`:
  ```typescript
  export interface ConsensusReviewInput {
    diff: string;
    models: ConsensusModelConfig[];
    staticContext: string;
    memoryContext: string | null;
    stackHints: string;
    reviewLevel: ReviewLevel;
    reviewConcurrency?: number;
    reviewDelayMs?: number;
    onProgress?: ProgressCallback;
  }
  ```
- Update `ConsensusModelConfig` to include optional fallback providers:
  ```typescript
  export interface ConsensusModelConfig {
    provider: LLMProvider;
    model: string;
    apiKey: string;
    stance: ConsensusStance;
  }
  ```
  (No change to ConsensusModelConfig — fallback uses single-entry chain per model)
- Replace `Promise.allSettled(votePromises)` with `runWithConcurrency` call
- Replace `generateTextWithTimeout` with `generateWithFallback` (single-entry provider chain per model config)
- Apply `reviewConcurrency` (default: 1) and `reviewDelayMs` (default: 0)
- Remove `createModel` import (fallback handles this)
- Update result collection to map `FallbackResult`
**Estimate**: 15 min

### 5.2 Update consensus tests for new interface
**File**: `packages/core/src/agents/consensus.test.ts`  
**Change**:
- Update mock setup: mock `generateWithFallback` instead of `generateText`
- Update `makeInput()` if needed for new optional fields
- Update existing tests for new call pattern
- Add new tests:
  - `'runs votes sequentially with concurrency: 1 (default)'`
  - `'respects reviewConcurrency setting'`
  - `'respects reviewDelayMs setting'`
  - `'uses generateWithFallback for each vote call'`
- Consensus does NOT use compact prompts (each stance needs full context)
**Estimate**: 20 min

## Phase 6: Pipeline Wiring (depends on Phases 4, 5)

### 6.1 Pass concurrency config and provider chain to agents
**File**: `packages/core/src/pipeline.ts`  
**Change**:
- Update the workflow case (lines 234-246) to pass new fields:
  ```typescript
  case 'workflow':
    result = await runWorkflowReview({
      diff: truncatedDiff,
      providerChain: buildProviderChain(input),
      staticContext,
      memoryContext,
      stackHints,
      reviewLevel: input.settings.reviewLevel,
      reviewConcurrency: input.settings.reviewConcurrency,
      reviewDelayMs: input.settings.reviewDelayMs,
      onProgress: input.onProgress,
    });
    break;
  ```
- Update the consensus case (lines 248-277) to pass new fields:
  ```typescript
  case 'consensus':
    result = await runConsensusReview({
      diff: truncatedDiff,
      models: [/* same stance configs */],
      staticContext,
      memoryContext,
      stackHints,
      reviewLevel: input.settings.reviewLevel,
      reviewConcurrency: input.settings.reviewConcurrency,
      reviewDelayMs: input.settings.reviewDelayMs,
      onProgress: input.onProgress,
    });
    break;
  ```
- Add helper function `buildProviderChain(input: ReviewInput): FallbackProvider[]`:
  ```typescript
  function buildProviderChain(input: ReviewInput): FallbackProvider[] {
    if (input.providerChain && input.providerChain.length > 0) {
      return input.providerChain.map(e => ({
        provider: e.provider as LLMProvider,
        model: e.model,
        apiKey: e.apiKey,
      }));
    }
    if (input.provider && input.model && input.apiKey) {
      return [{ provider: input.provider, model: input.model, apiKey: input.apiKey }];
    }
    throw new Error('No provider configured');
  }
  ```
- Add import for `FallbackProvider` type
**Estimate**: 15 min

### 6.2 Update pipeline tests
**File**: `packages/core/src/pipeline.test.ts`  
**Change**:
- Verify `runWorkflowReview` is called with `providerChain` instead of flat provider fields
- Verify `reviewConcurrency` and `reviewDelayMs` are forwarded from `settings`
- Verify `runConsensusReview` receives `reviewConcurrency` and `reviewDelayMs`
- Add test: `'passes reviewConcurrency from settings to workflow agent'`
- Add test: `'passes reviewDelayMs from settings to consensus agent'`
- Add test: `'builds providerChain from single provider fields when no chain exists'`
- Add test: `'builds providerChain from providerChain when available'`
**Estimate**: 15 min

## Phase 7: Verification (depends on all above)

### 7.1 Run full test suite
**Command**: `pnpm test`  
**Verify**:
- All existing tests pass
- New tests pass
- No TypeScript errors (`pnpm typecheck`)
- Biome lint passes (`pnpm lint`)
**Estimate**: 5 min

### 7.2 Manual verification with Groq free tier
**Command**: `ghagga review --provider groq --mode workflow --concurrency 1 --delay 500`  
**Verify**:
- No 413 errors
- Review completes successfully
- Progress output shows sequential specialist execution
**Estimate**: 10 min

## Summary

| Phase | Tasks | Files | Est. Time |
|-------|-------|-------|-----------|
| 1. Utilities & Types | 3 | 3 | 28 min |
| 2. Fallback Enhancement | 2 | 2 | 10 min |
| 3. Compact Prompts | 2 | 2 | 8 min |
| 4. Workflow Refactoring | 3 | 2 | 55 min |
| 5. Consensus Refactoring | 2 | 2 | 35 min |
| 6. Pipeline Wiring | 2 | 2 | 30 min |
| 7. Verification | 2 | 0 | 15 min |
| **Total** | **16** | **11** | **~3 hours** |

## Execution Order

```
Phase 1.1 (concurrency util) ──→ Phase 4 (workflow)  ──→ Phase 6 (pipeline) ──→ Phase 7 (verify)
Phase 1.2 (concurrency tests)                         
Phase 1.3 (types)            ──→ Phase 2 (fallback)  ──→ Phase 5 (consensus)
                             ──→ Phase 3 (prompts)   ──→ Phase 4 (workflow)
```

- Phase 1 tasks can all run in parallel
- Phases 2 and 3 can run in parallel after Phase 1
- Phase 4 depends on Phases 1, 2, 3
- Phase 5 depends on Phases 1, 2
- Phase 6 depends on Phases 4, 5
- Phase 7 depends on everything

## Verification Checklist

- [ ] `pnpm typecheck` passes (no TypeScript errors)
- [ ] `pnpm test` passes (all test suites green)
- [ ] `pnpm lint` passes (Biome lint clean)
- [ ] Workflow mode: first specialist gets full context, rest get compact
- [ ] Workflow mode: `concurrency: 1` runs specialists sequentially
- [ ] Workflow mode: `concurrency: 5` runs all in parallel (backward compat)
- [ ] Consensus mode: `concurrency: 1` runs stances sequentially
- [ ] 413 errors trigger fallback to next provider
- [ ] Simple mode completely unchanged
- [ ] Default settings produce same review quality as before
