# Spec: Workflow & Consensus Mode Support for CLI Bridge and Gateway

**Status**: approved
**Date**: 2026-03-19

## Requirements

### R1: Generic Text Generation Interface

A `GenerateTextFn` type that abstracts the LLM call:

```typescript
type GenerateTextFn = (
  system: string,
  prompt: string,
) => Promise<GenerateTextResult>;

interface GenerateTextResult {
  text: string;
  tokensUsed: number;
  provider: string;
  model: string;
}
```

Three factory functions create instances for each backend:
- `createAISDKGenerateFn(provider, model, apiKey)` — wraps `generateTextWithTimeout`
- `createCLIBridgeGenerateFn(options)` — wraps `generateViaCLI`
- `createGatewayGenerateFn(options)` — wraps `generateViaGateway`

### R2: Workflow Agent Refactoring

`runWorkflowReview` accepts a `GenerateTextFn` (or array of them for provider chain distribution) instead of `provider/model/apiKey`.

Each specialist call uses `generateFn(system, prompt)` instead of `createModel() + generateTextWithTimeout()`.

The synthesis call also uses `generateFn`.

Provider chain distribution (round-robin across providers) MUST continue to work for AI SDK. For CLI bridge and gateway, all calls use the same backend (no chain distribution — a single CLI/gateway is one "provider").

### R3: Consensus Agent Refactoring

`runConsensusReview` accepts a `GenerateTextFn` per stance (or a single one shared across stances for CLI bridge/gateway).

Each stance call uses `generateFn(system, prompt)` instead of `createModel() + generateTextWithTimeout()`.

The voting algorithm (`calculateConsensus`) is unchanged.

### R4: Pipeline Refactoring

The three-way branch in `reviewPipeline` (`isCliBridge` / `isGateway` / else) is unified:

1. Pipeline resolves which backend to use
2. Pipeline creates the appropriate `GenerateTextFn`(s)
3. Pipeline delegates to the mode-appropriate agent: `runSimpleReview`, `runWorkflowReview`, or `runConsensusReview`
4. No more `runCLIBridgeReview` or `runGatewayReview` — they are replaced by the generic path

### R5: Simple Agent Refactoring

`runSimpleReview` also accepts `GenerateTextFn` for consistency, though it makes just one call.

### R6: Diagnostic Mode

Diagnostic mode remains AI SDK-only. If the user selects `mode: 'diagnostic'` with CLI bridge or gateway, the pipeline falls back to simple mode with a progress warning.

## Scenarios

### S1: Workflow via Gateway

```
User selects: mode=workflow, provider=gateway
Pipeline creates: gatewayGenerateFn
Pipeline calls: runWorkflowReview with generateFn
Workflow agent makes 5 specialist calls via gatewayGenerateFn → POST /v1/generate x5
Workflow agent makes 1 synthesis call via gatewayGenerateFn → POST /v1/generate x1
Total: 6 gateway calls, unified review result
```

### S2: Consensus via CLI Bridge

```
User selects: mode=consensus, provider=cli-bridge, preferredCLI=opencode
Pipeline creates: cliBridgeGenerateFn
Pipeline calls: runConsensusReview with generateFn for all 3 stances
Consensus agent makes 3 calls via cliBridgeGenerateFn → opencode CLI x3
Voting algorithm produces status/summary
Total: 3 CLI calls, consensus result
```

### S3: Workflow via AI SDK (existing — must not break)

```
User selects: mode=workflow, provider=anthropic, providerChain=[anthropic, openai, google]
Pipeline creates: [aiSdkGenerateFn(anthropic), aiSdkGenerateFn(openai), aiSdkGenerateFn(google)]
Workflow distributes: specialist[0]→anthropic, specialist[1]→openai, specialist[2]→google, specialist[3]→anthropic, specialist[4]→openai
Synthesis uses: chain[0] (anthropic)
Total: 6 AI SDK calls across 3 providers
```

### S4: Diagnostic with Gateway (fallback)

```
User selects: mode=diagnostic, provider=gateway
Pipeline detects: diagnostic not supported for gateway
Pipeline emits: progress warning "Diagnostic mode not supported for gateway, falling back to simple"
Pipeline runs: runSimpleReview with gatewayGenerateFn
```

## Edge Cases

### E1: CLI Bridge Failure Mid-Workflow

If specialist 3 of 5 fails (CLI crash), the workflow synthesis step receives the failure message and produces a partial review. Same behavior as current AI SDK path (uses `allSettled`).

### E2: Gateway Timeout Mid-Consensus

If one of 3 stance calls times out, the voting algorithm handles fewer votes gracefully (already implemented in `calculateConsensus`).

### E3: Empty Provider Chain with CLI Bridge

If `providerChain[0].provider === 'cli-bridge'`, all workflow specialists use the same CLI bridge. No round-robin distribution (single provider).

### E4: Mixed Chain with Gateway

Not supported. If chain[0] is gateway, all calls go through gateway. The gateway itself can route to different providers internally.

## Acceptance Criteria (testable)

1. **AC1**: `runWorkflowReview({ ..., generateFn: mockFn })` calls `mockFn` exactly 6 times (5 specialists + 1 synthesis)
2. **AC2**: `runConsensusReview({ ..., generateFn: mockFn })` calls `mockFn` exactly 3 times (one per stance)
3. **AC3**: `runSimpleReview({ ..., generateFn: mockFn })` calls `mockFn` exactly 1 time
4. **AC4**: Pipeline with `provider: 'gateway', mode: 'workflow'` produces a valid `ReviewResult` with `metadata.mode === 'workflow'`
5. **AC5**: Pipeline with `provider: 'cli-bridge', mode: 'consensus'` produces a valid `ReviewResult` with `metadata.mode === 'consensus'`
6. **AC6**: Pipeline with `provider: 'anthropic', mode: 'workflow'` produces identical behavior to current implementation
7. **AC7**: Pipeline with `mode: 'diagnostic', provider: 'gateway'` falls back to simple mode with a progress warning
8. **AC8**: All existing tests pass without modification
