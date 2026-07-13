# Archive Report: Workflow and Consensus Refactor

**Change**: `workflow-consensus-refactor`
**Archive date**: 2026-07-13
**Status**: IMPLEMENTED

## Outcome

PR #175 (`7595d83`) introduced the shared `GenerateTextFn`/`GenerateResult` abstraction, factories for AI SDK, CLI Bridge, and Gateway, refactored simple/workflow/consensus agents, unified pipeline dispatch, and removed backend-specific review implementations. The merge reports 1,739 tests passing and clean typecheck/formatting at implementation time.

## Evidence

- Merge: PR #175
- Abstraction: `packages/core/src/providers/generate-fn.ts`
- Factory tests: `packages/core/src/providers/generate-fn.test.ts`
- Unified resolution: `packages/core/src/pipeline/providers.ts`
- Agent consumers: `packages/core/src/agents/simple.ts`, `workflow.ts`, `consensus.ts`

## Spec synchronization

`openspec/specs/core-engine/spec.md` now records the durable backend-agnostic generation contract for simple, workflow, and consensus modes, including serialization when only one generation function is available.

## Historical artifact caveat

The task file contains a completed verification/cleanup tail but many earlier implementation boxes remain unchecked despite the PR's merged implementation. The artifact is preserved as written; merge and code evidence establish closure.
