# Spec: Optimize Token Usage for Free-Tier LLM Providers

**Status**: draft  
**Proposal**: [proposal.md](./proposal.md)  
**Date**: 2026-03-16  

## Requirements

### R1: Concurrency-Limited Execution

The system MUST replace `Promise.allSettled(all)` in workflow and consensus modes with a concurrency-limited executor that processes at most `N` LLM calls simultaneously.

- Workflow mode MUST default to `concurrency: 2` (2 specialists at a time)
- Consensus mode MUST default to `concurrency: 1` (sequential)
- The concurrency value MUST be configurable via `ReviewSettings.reviewConcurrency`
- Valid values: `1 | 2 | 3 | 5` (1 = fully sequential, 5 = fully parallel for workflow)
- The concurrency limiter MUST be implemented inline (no external `p-limit` dependency)

### R2: Inter-Batch Delay

The system MUST support a configurable delay between concurrency batches.

- Default: `reviewDelayMs: 0` (no delay)
- The delay MUST be applied **after each individual LLM call completes**, not between batches
- When `reviewDelayMs > 0`, each specialist/stance call MUST wait at least `reviewDelayMs` milliseconds after the previous call completes before starting
- The delay MUST NOT be applied within a concurrent batch (only between sequential calls)
- The delay value MUST be configurable via `ReviewSettings.reviewDelayMs`

### R3: Compact Prompts (Shared Context Deduplication)

The system MUST provide a compact system prompt variant for workflow specialists.

- The **first specialist** in each workflow review MUST receive the full system prompt (specialist instructions + staticContext + memoryContext + stackHints + reviewLevel + REVIEW_CALIBRATION)
- **Subsequent specialists** (2nd through 5th) MUST receive a compact system prompt that includes:
  - The specialist-specific instructions (unchanged)
  - The review level instruction (unchanged)
  - A minimal calibration reference: `"Apply the same review calibration: only report findings you are 80%+ confident about. Do not flag hypothetical issues."`
  - The diff (via user prompt, unchanged)
  - But NOT staticContext, memoryContext, stackHints, or full REVIEW_CALIBRATION
- The **synthesis call** MUST continue to receive full context (reviewLevel + REVIEW_CALIBRATION)
- Consensus mode SHOULD NOT use compact prompts (each stance needs full context for independent evaluation)
- A `buildCompactCalibration()` function MUST be exported from `prompts.ts`

### R4: generateWithFallback Integration

The system MUST wire `generateWithFallback` into both workflow and consensus modes.

- `WorkflowReviewInput` MUST accept an optional `providerChain: FallbackProvider[]` in addition to the existing single-provider fields
- When `providerChain` is provided, each specialist call MUST use `generateWithFallback` instead of `generateTextWithTimeout`
- When only single provider fields are provided, the system MUST construct a single-entry chain and still use `generateWithFallback` (for consistent code paths)
- `ConsensusReviewInput` MUST accept an optional `providerChain` per model config for fallback capability
- The pipeline MUST pass the provider chain through to agents when available

### R5: 413 as Retryable Error

The `isRetryableError()` function in `fallback.ts` MUST treat HTTP 413 responses as retryable.

- Status code 413 in error messages MUST trigger fallback to the next provider
- Error messages containing `"too large"` or `"payload"` (case-insensitive) MUST also trigger fallback
- This allows a provider with higher TPM limits to handle the request

### R6: Configuration Types

`ReviewSettings` in `types.ts` MUST be extended with:

```typescript
/** Max concurrent LLM calls for workflow/consensus modes. Default: 2. */
reviewConcurrency?: 1 | 2 | 3 | 5;

/** Delay in ms between sequential LLM calls. Default: 0. */
reviewDelayMs?: number;
```

Both fields MUST be optional with defaults applied at the agent level, not in the type definition.

`DEFAULT_SETTINGS` MUST NOT include these fields (undefined = use agent defaults).

### R7: Pipeline Pass-Through

The pipeline (`pipeline.ts`) MUST pass `reviewConcurrency` and `reviewDelayMs` from `ReviewSettings` through to the agent functions.

- `WorkflowReviewInput` MUST accept optional `reviewConcurrency` and `reviewDelayMs`
- `ConsensusReviewInput` MUST accept optional `reviewConcurrency` and `reviewDelayMs`
- The pipeline MUST forward `input.settings.reviewConcurrency` and `input.settings.reviewDelayMs` to agent calls
- The pipeline MUST also forward `providerChain` when available

### R8: Backward Compatibility

- Default behavior MUST NOT change observable review quality or output format
- Default concurrency (`2`) MUST NOT cause tests to fail (batched execution still runs all specialists)
- All existing test assertions MUST pass without modification (except for call-order-dependent assertions that assumed fully parallel execution)
- Simple mode MUST be completely unchanged
- The synthesis step in workflow mode MUST remain a single call after all specialists complete

## Scenarios

### S1: Workflow review with Groq free tier (concurrency: 1, delay: 500)

**Given** a Groq provider with 8K TPM limit  
**And** `reviewConcurrency: 1` and `reviewDelayMs: 500`  
**When** a workflow review is triggered with a 2K token diff  
**Then** each specialist runs sequentially (one at a time)  
**And** a 500ms delay is inserted between each specialist call  
**And** peak TPM never exceeds ~3.5K (one call at a time)  
**And** the review completes successfully (no 413 errors)  

### S2: Workflow review with default settings (concurrency: 2, delay: 0)

**Given** an Anthropic provider with high TPM limits  
**And** default settings (`reviewConcurrency: undefined`, `reviewDelayMs: undefined`)  
**When** a workflow review is triggered  
**Then** specialists run in batches of 2 (2, 2, 1)  
**And** no delay between calls  
**And** the review completes with the same findings as fully parallel mode  

### S3: Consensus review with Gemini (concurrency: 1, delay: 1000)

**Given** a Google Gemini provider with 20 RPM limit  
**And** `reviewConcurrency: 1` and `reviewDelayMs: 1000`  
**When** a consensus review is triggered  
**Then** each stance (for, against, neutral) runs sequentially  
**And** a 1000ms delay is inserted between calls  
**And** total time is ~3s for 3 calls + LLM time  
**And** RPM usage is 3 requests per review (within 20 RPM limit)  

### S4: Compact prompts reduce token usage in workflow mode

**Given** a workflow review with compact prompts enabled (default)  
**And** staticContext is 300 tokens, memoryContext is 200 tokens, stackHints is 100 tokens, REVIEW_CALIBRATION is 200 tokens  
**When** the review runs  
**Then** the first specialist receives ~800 tokens of shared context  
**And** specialists 2-5 receive ~50 tokens of compact calibration instead of ~800  
**And** total shared context tokens = 800 + (50 * 4) = 1000 instead of 800 * 5 = 4000  
**And** savings = ~3000 tokens per workflow review  

### S5: 413 triggers fallback to next provider

**Given** a provider chain: [Groq (primary), Anthropic (fallback)]  
**And** the diff is too large for Groq's TPM limit  
**When** Groq returns HTTP 413 "Request Entity Too Large"  
**Then** the fallback chain tries Anthropic  
**And** the review completes using Anthropic  

### S6: Provider chain in workflow mode

**Given** a provider chain: [DeepSeek, Groq, Anthropic]  
**And** `reviewConcurrency: 2`  
**When** DeepSeek returns 429 during the 3rd specialist call  
**Then** that specialist call falls back to Groq  
**And** remaining specialists continue using DeepSeek (fallback is per-call)  
**And** the synthesis call uses the primary provider (DeepSeek)  

### S7: Full parallelism opt-in (concurrency: 5)

**Given** `reviewConcurrency: 5` and a provider with high limits  
**When** a workflow review runs  
**Then** all 5 specialists fire simultaneously (same as current behavior)  
**And** the review behaves identically to the pre-optimization code  

### S8: Simple mode unchanged

**Given** any concurrency and delay configuration  
**When** a simple review is triggered  
**Then** the review makes exactly 1 LLM call  
**And** `reviewConcurrency` and `reviewDelayMs` are ignored  

## Edge Cases

- **concurrency > number of calls**: If `reviewConcurrency: 5` with consensus (3 calls), all 3 run in parallel. The concurrency limit is a max, not a target.
- **reviewDelayMs with concurrency > 1**: Delay applies between batches, not within a batch. With `concurrency: 2, delay: 1000`: batch[0,1] → 1s → batch[2,3] → 1s → batch[4].
- **All specialists fail in batched mode**: Same behavior as current — synthesis receives `[FAILED]` markers for each and produces a degraded review.
- **Fallback succeeds with different provider**: The metadata records the provider that actually completed each call. Synthesis provider may differ from specialist providers.
- **Zero-length provider chain**: Falls back to single provider (backward compat).
- **Compact prompt on single-specialist failure**: If the first specialist fails, the second specialist still gets compact prompts (the context was "provided" to the first call, even if it failed — the LLM can't know this, and the compact calibration is sufficient).

## Non-Functional Requirements

- **No new dependencies**: Concurrency limiter is implemented inline (~20-30 lines)
- **No database migration**: New settings are optional fields in JSONB
- **Performance**: Default `concurrency: 2` is ~1.5x slower than fully parallel (acceptable trade-off)
- **Testability**: Concurrency limiter is a pure utility function testable in isolation
