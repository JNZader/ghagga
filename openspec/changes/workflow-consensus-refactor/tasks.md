# Tasks: Workflow & Consensus Mode Support for CLI Bridge and Gateway

**Status**: done
**Date**: 2026-03-19
**Estimated effort**: ~2 hours (one session)

---

## Phase 1: Foundation — GenerateTextFn Abstraction

### Task 1: Create `providers/generate-fn.ts`
- [ ] Define `GenerateResult` interface: `{ text, tokensUsed, provider, model }`
- [ ] Define `GenerateTextFn` type: `(system: string, prompt: string) => Promise<GenerateResult>`
- [ ] Implement `createAISDKGenerateFn(provider, model, apiKey)`:
  - Wraps `createModel` + `generateTextWithTimeout`
  - Converts `null` timeout to thrown Error
  - Maps `usage.inputTokens + outputTokens` to `tokensUsed`
- [ ] Implement `createCLIBridgeGenerateFn(options)`:
  - Wraps `generateViaCLI(prompt, system, options)`
  - Returns `tokensUsed: 0` (CLI doesn't report tokens)
  - Maps `result.cli` to `model` field
- [ ] Implement `createGatewayGenerateFn(options)`:
  - Wraps `generateViaGateway(prompt, system, options)`
  - Maps `result.tokensUsed ?? 0`
- [ ] Export all types and factories
- [ ] Run `pnpm biome check --write` on new file

**Files**: `packages/core/src/providers/generate-fn.ts` (NEW)
**Commit**: `feat(core): add GenerateTextFn abstraction for backend-agnostic LLM calls`

---

## Phase 2: Refactor Agents

### Task 2: Refactor `agents/simple.ts`
- [ ] Add `generateFn?: GenerateTextFn` to `SimpleReviewInput` interface
- [ ] When `generateFn` is provided, use it instead of `createModel` + `generateTextWithTimeout`
- [ ] When `generateFn` is NOT provided, create one internally from `provider/model/apiKey` (backward compat)
- [ ] Update `parseReviewResponse` call to use `result.provider` and `result.model` from `GenerateResult`
- [ ] Verify: `runSimpleReview` without `generateFn` works identically to before

**Files**: `packages/core/src/agents/simple.ts`
**Commit**: `refactor(core): simple agent accepts GenerateTextFn`

### Task 3: Refactor `agents/workflow.ts`
- [ ] Add `generateFns?: GenerateTextFn[]` to `WorkflowReviewInput` interface
- [ ] When `generateFns` is provided:
  - Each specialist uses `generateFns[index % generateFns.length]`
  - Synthesis uses `generateFns[0]`
  - Skip `createModel` calls
- [ ] When `generateFns` is NOT provided, create them from `providerChain` or flat fields (backward compat)
- [ ] Specialist loop: replace `generateTextWithTimeout({ model: specialistModel, ... })` with `generateFn(system, prompt)`
- [ ] Map `GenerateResult` fields into specialist output shape (`text`, `tokensUsed`, `providerUsed`, `modelUsed`)
- [ ] Synthesis step: same pattern — use `generateFns[0]` instead of `createModel`
- [ ] Handle timeout: `generateFn` throws on timeout (factory converts null to Error), caught by `allSettled`
- [ ] For CLI bridge/gateway (single generateFn), force `concurrency: 1` when `generateFns.length === 1`

**Files**: `packages/core/src/agents/workflow.ts`
**Commit**: `refactor(core): workflow agent accepts GenerateTextFn[] for backend-agnostic calls`

### Task 4: Refactor `agents/consensus.ts`
- [ ] Add `generateFns?: GenerateTextFn[]` to `ConsensusReviewInput` interface
- [ ] When `generateFns` is provided:
  - Each stance uses `generateFns[index % generateFns.length]`
  - Skip `createModel` calls
- [ ] When `generateFns` is NOT provided, create them from `models` config (backward compat)
- [ ] Vote loop: replace `generateTextWithTimeout({ model: languageModel, ... })` with `generateFn(system, prompt)`
- [ ] Map `GenerateResult` fields into vote parsing: pass `result.provider`, `result.model` to `parseVote`
- [ ] Handle timeout: same as workflow (factory throws, caught by `allSettled`)
- [ ] For CLI bridge/gateway (single generateFn), force `concurrency: 1` when `generateFns.length === 1`

**Files**: `packages/core/src/agents/consensus.ts`
**Commit**: `refactor(core): consensus agent accepts GenerateTextFn[] for backend-agnostic calls`

---

## Phase 3: Pipeline Unification

### Task 5: Add `resolveGenerateTextFns` to pipeline.ts
- [ ] Import `createAISDKGenerateFn`, `createCLIBridgeGenerateFn`, `createGatewayGenerateFn` from `providers/generate-fn.ts`
- [ ] Create function `resolveGenerateTextFns(input: ReviewInput): GenerateTextFn[]`:
  - If `isCliBridge`: return `[createCLIBridgeGenerateFn({ preferredCLI, cliModel, credentials })]`
  - If `isGateway`: return `[createGatewayGenerateFn({ gatewayUrl, gatewayToken, model, project: 'ghagga' })]`
  - Else (AI SDK): return `chain.map(entry => createAISDKGenerateFn(entry.provider, entry.model, entry.apiKey))`
- [ ] Create function `resolveEffectiveMode(mode, isCliBridge, isGateway)`:
  - If `mode === 'diagnostic'` and (`isCliBridge` || `isGateway`): return `'simple'` + emit progress warning
  - Otherwise: return `mode`

**Files**: `packages/core/src/pipeline.ts`
**Commit**: `feat(core): add resolveGenerateTextFns for unified backend dispatch`

### Task 6: Unify pipeline dispatch
- [ ] Remove `runCLIBridgeReview` function and its `CLIBridgeReviewInput` interface
- [ ] Remove `runGatewayReview` function and its `GatewayReviewInput` interface
- [ ] Replace the three-way branch (`isCliBridge` / `isGateway` / else) with unified flow:
  1. `const generateFns = resolveGenerateTextFns(input)`
  2. `const effectiveMode = resolveEffectiveMode(input.mode, isCliBridge, isGateway)`
  3. `switch (effectiveMode)` → dispatch to agents with `generateFns`
- [ ] For `simple`: pass `generateFns[0]` as `generateFn`
- [ ] For `workflow`: pass `generateFns` array
- [ ] For `consensus`: pass `generateFns` array (pipeline still builds consensus models for metadata, but actual calls use generateFns)
- [ ] For `diagnostic`: keep existing AI SDK code (only reached when provider is AI SDK)
- [ ] Preserve error handling: wrap agent calls in try/catch, fall back to `createStaticOnlyResult` on failure
- [ ] Preserve progress events: emit `agent-start` with mode and provider info

**Files**: `packages/core/src/pipeline.ts`
**Commit**: `refactor(core): unify pipeline dispatch — all modes work with all backends`

---

## Phase 4: Testing & Verification

### Task 7: Unit tests for `generate-fn.ts`
- [x] Test `createAISDKGenerateFn`: mock `generateTextWithTimeout`, verify it's called with correct params
- [x] Test `createCLIBridgeGenerateFn`: mock `generateViaCLI`, verify prompt/system are passed correctly
- [x] Test `createGatewayGenerateFn`: mock `generateViaGateway`, verify options are forwarded
- [x] Test timeout handling: AI SDK factory converts `null` to thrown Error

**Files**: `packages/core/src/providers/generate-fn.test.ts` (NEW)
**Commit**: `test(core): add unit tests for GenerateTextFn factories`

### Task 8: Integration smoke test
- [x] Run `pnpm test` to verify all existing tests pass (1739/1739 passed)
- [x] Run `pnpm biome check --write` across modified files (no issues)
- [x] Run `pnpm build` to verify TypeScript compilation (`tsc --noEmit` clean)
- [x] Manual verification: confirm types compile with `tsc --noEmit` (ghagga-core + @ghagga/server)

**Files**: N/A (verification only)
**Commit**: N/A (no code changes)

---

## Phase 5: Cleanup

### Task 9: Remove dead code and debug logging
- [x] Remove the `console.log('[ghagga] Gateway debug:' ...)` from pipeline.ts — already removed in Task 6
- [x] Clean up any unused imports from pipeline.ts after removing `runCLIBridgeReview`/`runGatewayReview` — verified clean
- [x] Verify no unused imports in agents after removing `createModel` direct usage — verified clean

**Files**: `packages/core/src/pipeline.ts`
**Commit**: `chore(core): remove debug logging and dead code`

---

## Summary

| Phase | Tasks | Estimated |
|-------|-------|-----------|
| 1. Foundation | Task 1 | 15 min |
| 2. Agent Refactoring | Tasks 2-4 | 45 min |
| 3. Pipeline Unification | Tasks 5-6 | 30 min |
| 4. Testing | Tasks 7-8 | 20 min |
| 5. Cleanup | Task 9 | 10 min |
| **Total** | **9 tasks** | **~2 hours** |

## Dependencies

```
Task 1 → Tasks 2, 3, 4 (agents need GenerateTextFn type)
Tasks 2, 3, 4 → Tasks 5, 6 (pipeline needs refactored agents)
Tasks 5, 6 → Task 7 (tests need new code)
Task 7 → Task 8 (smoke test after unit tests)
Task 8 → Task 9 (cleanup after verification)
```
