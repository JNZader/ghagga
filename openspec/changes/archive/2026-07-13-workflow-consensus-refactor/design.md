# Design: Workflow & Consensus Mode Support for CLI Bridge and Gateway

**Status**: approved
**Date**: 2026-03-19

## Architecture Decision

**Introduce a `GenerateTextFn` abstraction** that decouples agent orchestration from the LLM backend. Agents call `generateFn(system, prompt)` instead of directly importing AI SDK, CLI bridge, or gateway functions.

```
pipeline.ts
  ├─ resolveGenerateTextFns()      ← NEW: creates GenerateTextFn(s) based on provider
  ├─ runSimpleReview(generateFn)   ← refactored: uses GenerateTextFn
  ├─ runWorkflowReview(generateFns) ← refactored: uses GenerateTextFn[]  
  ├─ runConsensusReview(generateFns) ← refactored: uses GenerateTextFn[]
  └─ runDiagnosticReview(...)       ← unchanged (AI SDK only)
```

## New File: `packages/core/src/providers/generate-fn.ts`

Single file containing:

### Type Definition

```typescript
/** Result from any LLM text generation backend */
export interface GenerateResult {
  text: string;
  tokensUsed: number;
  provider: string;
  model: string;
}

/** Generic text generation function — abstracts AI SDK, CLI bridge, and gateway */
export type GenerateTextFn = (system: string, prompt: string) => Promise<GenerateResult>;
```

### Factory: AI SDK

```typescript
export function createAISDKGenerateFn(
  provider: LLMProvider,
  model: string,
  apiKey: string,
): GenerateTextFn {
  return async (system, prompt) => {
    const languageModel = createModel(provider, model, apiKey);
    const result = await generateTextWithTimeout(
      { model: languageModel, system, prompt, temperature: 0.3 },
      { provider, model },
    );
    if (result === null) {
      throw new Error(`LLM call timed out (${provider}/${model})`);
    }
    return {
      text: result.text,
      tokensUsed: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      provider,
      model,
    };
  };
}
```

### Factory: CLI Bridge

```typescript
export function createCLIBridgeGenerateFn(options: {
  preferredCLI?: string;
  cliModel?: string;
  credentials?: Record<string, string>;
}): GenerateTextFn {
  return async (system, prompt) => {
    const result = generateViaCLI(prompt, system, options);
    return {
      text: result.text,
      tokensUsed: 0, // CLI doesn't report tokens
      provider: 'cli-bridge',
      model: result.cli,
    };
  };
}
```

### Factory: Gateway

```typescript
export function createGatewayGenerateFn(options: {
  gatewayUrl: string;
  gatewayToken: string;
  model?: string;
  project?: string;
}): GenerateTextFn {
  return async (system, prompt) => {
    const result = await generateViaGateway(prompt, system, options);
    return {
      text: result.text,
      tokensUsed: result.tokensUsed ?? 0,
      provider: result.provider,
      model: result.model,
    };
  };
}
```

## Agent Refactoring Pattern

### Before (workflow.ts)

```typescript
export interface WorkflowReviewInput {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  providerChain?: ProviderChainEntry[];
  // ...
}

// Inside specialist loop:
const specialistModel = createModel(entry.provider, entry.model, entry.apiKey);
const result = await generateTextWithTimeout({ model: specialistModel, system, prompt, temperature: 0.3 });
```

### After (workflow.ts)

```typescript
export interface WorkflowReviewInput {
  /** One GenerateTextFn per provider in the chain (round-robin for specialists) */
  generateFns: GenerateTextFn[];
  // ... (same context fields, no provider/model/apiKey)
}

// Inside specialist loop:
const generateFn = input.generateFns[index % input.generateFns.length]!;
const result = await generateFn(system, prompt);
```

Same pattern for consensus.ts and simple.ts.

## Pipeline Refactoring

### Current Flow (3 branches)

```
if isCliBridge → runCLIBridgeReview (simple only)
else if isGateway → runGatewayReview (simple only)
else → switch(mode) { simple, workflow, consensus, diagnostic }
```

### New Flow (unified)

```typescript
// Step 1: Build GenerateTextFn(s)
const generateFns = resolveGenerateTextFns(input);

// Step 2: Resolve effective mode (diagnostic → simple for non-SDK)
const effectiveMode = resolveEffectiveMode(input.mode, isCliBridge, isGateway);

// Step 3: Dispatch to agent
switch (effectiveMode) {
  case 'simple':    return runSimpleReview({ generateFn: generateFns[0], ... });
  case 'workflow':  return runWorkflowReview({ generateFns, ... });
  case 'consensus': return runConsensusReview({ generateFns, ... });
  case 'diagnostic': return runDiagnosticReview({ ... }); // AI SDK only, uses old path
}
```

### `resolveGenerateTextFns` Logic

```typescript
function resolveGenerateTextFns(input: ReviewInput): GenerateTextFn[] {
  if (isCliBridge) {
    return [createCLIBridgeGenerateFn({ preferredCLI, cliModel, credentials })];
  }
  if (isGateway) {
    return [createGatewayGenerateFn({ gatewayUrl, gatewayToken, model })];
  }
  // AI SDK: one function per chain entry (for round-robin distribution)
  const chain = input.providerChain ?? [resolvePrimaryProvider(input)];
  return chain.map(entry => createAISDKGenerateFn(entry.provider, entry.model, entry.apiKey));
}
```

## Timeout Handling

- **AI SDK**: `generateTextWithTimeout` wraps with 60s timeout (existing). The factory catches `null` and throws an Error so agents get a clean exception.
- **CLI Bridge**: `execSync` has 180s timeout (existing). Throws on timeout.
- **Gateway**: `fetch` has 180s `AbortSignal.timeout` (existing). Throws on timeout.

All three backends throw on failure. Agents use `allSettled` to handle partial failures gracefully.

## Concurrency & Rate Limiting

Workflow already has `runWithConcurrency` with auto-calculated schedules based on model TPM. This works unchanged because:

- AI SDK: rate schedule from model name (existing)
- CLI Bridge: sequential by nature (execSync), concurrency=1 forced
- Gateway: gateway handles its own rate limiting, concurrency=1 is safe default

The agents will detect that CLI bridge and gateway `generateFns` have length 1, and `calculateRateSchedule` returns sensible defaults for unknown models.

**Decision**: For CLI bridge and gateway, force `concurrency: 1` in workflow mode. This prevents interleaving CLI calls (which would fail anyway with execSync) and avoids overwhelming a single gateway.

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `providers/generate-fn.ts` | **NEW** | `GenerateTextFn` type + 3 factory functions |
| `agents/workflow.ts` | **MODIFY** | Accept `GenerateTextFn[]`, remove `createModel` import |
| `agents/consensus.ts` | **MODIFY** | Accept `GenerateTextFn[]`, remove `createModel` import |
| `agents/simple.ts` | **MODIFY** | Accept `GenerateTextFn`, remove `createModel` import |
| `pipeline.ts` | **MODIFY** | Unified dispatch, remove `runCLIBridgeReview`/`runGatewayReview`, add `resolveGenerateTextFns` |

## What Does NOT Change

- `providers/cli-bridge.ts` — `generateViaCLI` signature unchanged
- `providers/gateway.ts` — `generateViaGateway` signature unchanged
- `providers/index.ts` — `createModel` unchanged (still used by AI SDK factory)
- `agents/prompts.ts` — all prompts unchanged
- `agents/diagnostic.ts` — untouched (stays AI SDK-only)
- `utils/concurrency.ts` — unchanged
- `utils/llm-timeout.ts` — unchanged
- `types.ts` — no new types needed in main types file
