# Proposal: Workflow & Consensus Mode Support for CLI Bridge and Gateway

**Status**: approved
**Author**: SDD Orchestrator
**Date**: 2026-03-19

## Intent

Enable workflow (5-specialist) and consensus (3-stance debate) review modes to work with CLI Bridge and LLM Gateway providers, not just the AI SDK direct path.

Currently, the pipeline intercepts `cli-bridge` and `gateway` providers early (lines 363-459 of `pipeline.ts`) and routes them through `runCLIBridgeReview` / `runGatewayReview`, which build a single prompt and make ONE LLM call — effectively forcing simple mode regardless of the user's `input.mode` setting.

Workflow mode needs 5 sequential specialist calls + 1 synthesis call.
Consensus mode needs 3 stance calls + voting logic (no extra LLM call).

## Scope

- **In scope**: Refactoring agents (workflow, consensus, simple) to use a generic "generate text" function that can route to AI SDK, CLI bridge, or gateway.
- **In scope**: Keeping the AI SDK path working identically (no breaking changes).
- **In scope**: Passing the user's selected `mode` through CLI bridge and gateway paths.
- **Out of scope**: Adding new review modes (diagnostic stays AI SDK-only for now).
- **Out of scope**: Modifying the gateway service itself (gateway already has `/v1/generate`).
- **Out of scope**: Dashboard changes (mode selector already exists).

## Approach

**Option B: Abstract the LLM call, keep orchestration in ghagga.**

Instead of modifying agents to accept a pluggable model, we introduce a `GenerateTextFn` type — a function with signature `(system: string, prompt: string) => Promise<{ text: string; tokensUsed: number }>`. Each backend (AI SDK, CLI bridge, gateway) implements this interface.

The workflow and consensus agents already know how to orchestrate multi-call reviews. They just need to swap `generateTextWithTimeout(model, ...)` for `generateFn(system, prompt)`.

The pipeline's responsibility shifts from "which code path to run" to "which `generateFn` to build" — then all modes use the same agent code.

This is the simplest approach because:
1. No changes to the gateway service
2. No changes to CLI bridge adapters
3. Agents stay testable (inject a mock `generateFn`)
4. Existing AI SDK path works unchanged (just wraps `generateTextWithTimeout` in a `GenerateTextFn`)

## Risks

| Risk | Mitigation |
|------|------------|
| CLI bridge is synchronous (execSync) — workflow makes 5 sequential calls | Already acceptable: CLI bridge takes ~30s per call, 5 calls = ~2.5 min. Gateway and even AI SDK free tiers are similar. |
| Gateway timeout on large diffs with 6 calls | Gateway already has 3-min timeout per call. Workflow/consensus calls use truncated diffs. |
| Breaking existing simple mode behavior | Full test coverage of existing paths before refactoring. |
| Token budget explosion with 5-6 calls | Each specialist already gets context-scoped prompts (less tokens per call). Total is same as current workflow mode. |

## Acceptance Criteria

1. `mode: 'workflow'` with `provider: 'cli-bridge'` runs 5 specialist + 1 synthesis call through CLI bridge
2. `mode: 'workflow'` with `provider: 'gateway'` runs 5 specialist + 1 synthesis call through gateway
3. `mode: 'consensus'` with `provider: 'cli-bridge'` runs 3 stance calls through CLI bridge
4. `mode: 'consensus'` with `provider: 'gateway'` runs 3 stance calls through gateway
5. `mode: 'simple'` with all 3 backends continues to work identically
6. `mode: 'workflow'` with AI SDK providers continues to work identically
7. `mode: 'consensus'` with AI SDK providers continues to work identically
8. Progress events are emitted correctly for all combinations
9. Existing tests pass without modification
