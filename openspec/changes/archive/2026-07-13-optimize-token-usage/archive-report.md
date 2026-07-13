# Archive Report: Optimize Token Usage

**Change**: `optimize-token-usage`
**Archive date**: 2026-07-13
**Status**: IMPLEMENTED WITH LATER GAP COMPLETION

## Outcome

Rate-aware scheduling first shipped in PR #148 (`6d65f8e`), serializing or batching workflow/consensus calls according to effective provider capacity. Commit `100f7ad` later completed the original change's remaining gaps: explicit `reviewConcurrency`/`reviewDelayMs` settings and pipeline wiring, HTTP 413 fallback coverage, compact-calibration coverage, and updated integration expectations.

## Evidence

- Initial scheduling merge: PR #148
- Gap completion: `100f7ad`, `feat(core): complete optimize-token-usage gaps and fix stale integration test`
- Runtime validation/wiring: `packages/core/src/pipeline/prepare.ts`, `packages/core/src/pipeline/execute.ts`
- Concurrency utility/agents: `packages/core/src/utils/concurrency.ts`, `packages/core/src/agents/workflow.ts`, `packages/core/src/agents/consensus.ts`
- Tests cover invalid settings, pass-through, compact prompts, and retry behavior.

## Spec synchronization

`openspec/specs/core-engine/spec.md` now records the durable bounded-concurrency, inter-batch delay, compact shared-context, and HTTP 413 fallback behavior.

## Historical artifact caveat

The original checklist remains unchecked and its manual real-provider exercise is not recorded as completed. Closure is based on merged implementation plus automated coverage; no claim of a live free-tier manual run is made.
