# Design: Optimize Token Usage for Free-Tier LLM Providers

**Status**: draft  
**Spec**: [spec.md](./spec.md)  
**Date**: 2026-03-16  

## Architecture Decisions

### AD1: Inline Concurrency Limiter (No p-limit Dependency)

**Decision**: Implement a minimal concurrency limiter as a utility function in `utils/concurrency.ts` instead of importing `p-limit`.

**Rationale**: The required functionality is ~25 lines of TypeScript. `p-limit` would add a dependency for a trivial utility. GHAGGA's monorepo already avoids unnecessary dependencies (e.g., inline diff parsing instead of `diff` package).

**Implementation**:
```typescript
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  delayMs?: number,
): Promise<PromiseSettledResult<T>[]> {
  // Process tasks in batches of `concurrency` size
  // Apply `delayMs` between batches
}
```

**Alternatives Considered**:
1. **`p-limit` npm package**: Rejected — adds a dependency for 25 lines of code.
2. **`Promise.allSettled` with manual chunking**: This IS the approach, just wrapped in a utility.
3. **AsyncGenerator/for-await pattern**: More complex, harder to test, no benefit.

### AD2: Compact Prompts via Builder Function

**Decision**: Add a `buildCompactCalibration()` function in `prompts.ts` that returns a minimal calibration block (~50 tokens) for non-primary specialist calls.

**Rationale**: The shared context (staticContext, memoryContext, stackHints, full REVIEW_CALIBRATION) adds ~800-1000 tokens per specialist. For specialists 2-5, the specialist-specific prompt is the critical part — the shared context primarily helps the first reviewer and the synthesis step. Compact prompts save ~3K tokens per workflow review.

**Design**:
```typescript
// Full system prompt (specialist 1):
[specialist.system, staticContext, memoryContext, stackHints, reviewLevel, REVIEW_CALIBRATION]

// Compact system prompt (specialists 2-5):
[specialist.system, reviewLevel, COMPACT_CALIBRATION]

// Synthesis (unchanged):
[SYNTHESIS_SYSTEM, reviewLevel, REVIEW_CALIBRATION]
```

The compact calibration preserves the most important constraint (80%+ confidence threshold) while dropping verbose context that the specialist doesn't need for its focused analysis.

**Alternatives Considered**:
1. **Move shared context to user prompt**: Rejected — would increase user prompt size for all calls (diff + context in same message).
2. **Reference-based context ("see previous context")**: LLMs don't share context between calls; this would be meaningless.
3. **Full context for all specialists (no compact)**: Current behavior; wastes ~3K tokens per review.

### AD3: generateWithFallback as Universal Call Pattern

**Decision**: Route all multi-agent LLM calls through `generateWithFallback`, even when only a single provider is configured (wrap it in a single-entry chain).

**Rationale**: This simplifies the code path (one call pattern instead of two) and ensures every LLM call benefits from fallback behavior (timeout → next provider, 413 → next provider, 429 → next provider). The overhead of wrapping a single provider in a chain is negligible (one extra function call frame).

**Interface change for WorkflowReviewInput**:
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

**Pipeline adaptation**: The pipeline already resolves `providerChain` from either `input.providerChain` or single-provider fields. It will construct the `FallbackProvider[]` and pass it to agents.

### AD4: 413 Detection in isRetryableError

**Decision**: Add 413 status code and payload-size error messages to `isRetryableError()`.

**Rationale**: HTTP 413 means the request body exceeded the provider's limit. The next provider in the chain may have a higher limit. This is fundamentally different from 400 (bad request syntax) — it's a capacity issue, not a client error.

**Pattern**:
```typescript
// In isRetryableError():
const status = parseInt(statusMatch[1] ?? '0', 10);
return status >= 500 || status === 413;  // Add 413

// Also catch descriptive error messages:
if (message.includes('too large') || message.includes('payload too large')) {
  return true;
}
```

## Implementation Map

### Layer 1: Utilities (no dependencies on other changes)

```
packages/core/src/utils/concurrency.ts (NEW)
├── runWithConcurrency<T>(tasks, concurrency, delayMs?) → PromiseSettledResult<T>[]
└── delay(ms) → Promise<void>
```

### Layer 2: Types & Config

```
packages/core/src/types.ts
└── ReviewSettings
    ├── reviewConcurrency?: 1 | 2 | 3 | 5
    └── reviewDelayMs?: number
```

### Layer 3: Fallback Enhancement

```
packages/core/src/providers/fallback.ts
└── isRetryableError()
    └── Add: status === 413, 'too large', 'payload too large'
```

### Layer 4: Prompt Compaction

```
packages/core/src/agents/prompts.ts
├── COMPACT_CALIBRATION (const string, ~50 tokens)
└── buildCompactCalibration() → string
```

### Layer 5: Agent Refactoring

```
packages/core/src/agents/workflow.ts
├── WorkflowReviewInput: replace provider/model/apiKey with providerChain
├── Import and use runWithConcurrency for specialist calls
├── Import and use generateWithFallback for each LLM call
├── Apply compact prompts for specialists 2-5
└── Apply delay between calls via runWithConcurrency

packages/core/src/agents/consensus.ts
├── ConsensusReviewInput: add optional providerChain per model
├── Import and use runWithConcurrency for vote calls
├── Import and use generateWithFallback for each LLM call
└── Apply delay between calls via runWithConcurrency
```

### Layer 6: Pipeline Wiring

```
packages/core/src/pipeline.ts
├── Build FallbackProvider[] from providerChain or single-provider fields
├── Pass reviewConcurrency to workflow/consensus calls
├── Pass reviewDelayMs to workflow/consensus calls
└── Pass providerChain to workflow/consensus calls
```

### Layer 7: Tests

```
packages/core/src/utils/concurrency.test.ts (NEW)
├── Test concurrency=1 (sequential)
├── Test concurrency=2 (batched)
├── Test concurrency=5 (parallel)
├── Test delay between batches
├── Test error handling (Promise.allSettled semantics)

packages/core/src/providers/fallback.test.ts
├── Test 413 triggers fallback
├── Test 'too large' message triggers fallback

packages/core/src/agents/prompts.test.ts
├── Test buildCompactCalibration returns minimal text
├── Test COMPACT_CALIBRATION token count (~50 tokens)

packages/core/src/agents/workflow.test.ts
├── Update: test sequential execution order
├── Update: test compact prompts for specialists 2-5
├── Update: verify generateWithFallback is called
├── Add: test concurrency=1 behavior
├── Add: test delay between calls

packages/core/src/agents/consensus.test.ts
├── Update: test sequential execution
├── Add: test concurrency=1 behavior
├── Add: test delay between calls
```

## Sequence Diagram: Workflow Review with Concurrency=2

```
Pipeline → Workflow Agent
  |
  |── Build providerChain from input
  |── runWithConcurrency(5 specialists, concurrency=2, delay=500ms)
  |
  |── Batch 1: [Scope, Standards] → generateWithFallback (parallel)
  |   ├── Scope: DeepSeek → success
  |   └── Standards: DeepSeek → success
  |── delay(500ms)
  |
  |── Batch 2: [Errors, Security] → generateWithFallback (parallel)
  |   ├── Errors: DeepSeek → 413 → Groq → success
  |   └── Security: DeepSeek → success
  |── delay(500ms)
  |
  |── Batch 3: [Performance] → generateWithFallback
  |   └── Performance: DeepSeek → success
  |
  |── Collect all specialist outputs
  |── Synthesis: generateWithFallback (single call, full context)
  |
  └── Return ReviewResult
```

## Sequence Diagram: Consensus with Concurrency=1

```
Pipeline → Consensus Agent
  |
  |── runWithConcurrency(3 stances, concurrency=1, delay=1000ms)
  |
  |── Call 1: FOR stance → generateWithFallback → success
  |── delay(1000ms)
  |── Call 2: AGAINST stance → generateWithFallback → success
  |── delay(1000ms)
  |── Call 3: NEUTRAL stance → generateWithFallback → success
  |
  |── Collect votes
  |── calculateConsensus(votes)
  |
  └── Return ReviewResult
```

## Compact Prompt Detail

### Full system prompt (~800-1000 tokens, specialist 1 only):
```
[WORKFLOW_SCOPE_SYSTEM]         ~120 tokens
[staticContext]                  ~300 tokens (variable)
[memoryContext]                  ~200 tokens (variable)
[stackHints]                    ~100 tokens (variable)
[reviewLevelInstruction]        ~40 tokens
[REVIEW_CALIBRATION]            ~80 tokens
```

### Compact system prompt (~170-210 tokens, specialists 2-5):
```
[WORKFLOW_*_SYSTEM]             ~120-170 tokens
[reviewLevelInstruction]        ~40 tokens
[COMPACT_CALIBRATION]           ~30 tokens
```

### COMPACT_CALIBRATION content:
```
Only report findings you are 80%+ confident about based on the actual code shown.
Do not flag stylistic preferences or hypothetical edge cases.
```

## No Architectural Changes

This optimization is purely internal to the agent execution layer. The external API (`ReviewInput` → `ReviewResult`) is unchanged. The only user-facing additions are two optional configuration fields.
