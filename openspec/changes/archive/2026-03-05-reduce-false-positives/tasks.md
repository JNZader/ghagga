# Tasks: Reduce False Positives in AI Reviews

> **Change**: `reduce-false-positives`
> **Phases**: 4 (Foundation, Core Implementation, Pipeline Wiring, Testing)
> **Total Tasks**: 16
> **Files Modified**: 7 production + 6 test files

---

## Phase 1: Foundation — Prompt Constants & Memory Limit (no dependents)

These tasks are independent leaf changes: new constants, function signatures, and a one-line limit change. Nothing else depends on their internal wiring yet.
- [x] 1.1 **Reduce memory observation limit from 8 to 3**
  - File: `packages/core/src/memory/search.ts` (line 87)
  - Change `{ limit: 8 }` to `{ limit: 3 }` in the `searchObservations()` call
  - Verify: grep the file for `limit:` — should show only `3`

- [x] 1.2 **Add `REVIEW_CALIBRATION` constant to `prompts.ts`**
  - File: `packages/core/src/agents/prompts.ts`
  - Add a new exported constant `REVIEW_CALIBRATION` after the consensus stances section (after line 175), containing:

    ```
    ## Review Calibration
    - Only report findings you are 80%+ confident about based on the actual code shown.
    - Do NOT flag stylistic preferences unless they violate an explicitly provided rule.
    - Do NOT invent or assume coding standards that are not provided.
    - Do NOT flag hypothetical edge cases that are unlikely in practice.
    - If the diff is small and clean, it is OK to return STATUS: PASSED with zero findings.
    ```
  - Export it from the module
  - Spec ref: Anti-False-Positive Calibration Block requirement (5 guardrails)

- [x] 1.3 **Add `buildReviewLevelInstruction()` function to `prompts.ts`**
  - File: `packages/core/src/agents/prompts.ts`
  - Import `ReviewLevel` from `../types.js`
  - Add new exported function `buildReviewLevelInstruction(level: ReviewLevel): string` that returns:
    - `'soft'`: "Only flag issues you are very confident about (90%+). Focus exclusively on bugs, security vulnerabilities, and logic errors. Ignore style, naming, and maintainability concerns."
    - `'normal'`: "Flag issues you are confident about (80%+). Cover bugs, security, performance, and error handling. Be cautious with style-only findings."
    - `'strict'`: "Perform a thorough review covering all categories including style, naming, and documentation. Flag anything that could be improved."
  - Spec ref: Review Level Prompt Calibration requirement (soft/normal/strict scenarios)

- [x] 1.4 **Rewrite `buildMemoryContext()` with anti-priming instructions**
  - File: `packages/core/src/agents/prompts.ts` (line 184-187)
  - Replace the current implementation:
    - Remove: `## Past Review Memory (learned from previous reviews)` header
    - Remove: `> Use these past observations to give more informed, context-aware reviews.` footer
    - Add new header: `## Background Context from Past Reviews`
    - Add new instruction: "The following observations are background context from past reviews of this project. They are provided for situational awareness only. Do NOT use them as reasons to flag issues. Only flag issues you can justify from the code diff itself."
  - Keep the null/empty guard at the top (`if (!memoryContext) return '';`)
  - Spec ref: Memory Context Framing requirement + Aggressive Memory Priming removal

- [x] 1.5 **Remove "coding standards" instruction from `SIMPLE_REVIEW_SYSTEM`**
  - File: `packages/core/src/agents/prompts.ts` (line 15)
  - Delete line 15: `6. Check adherence to the repository's coding standards and rules`
  - Renumber is not required (numbered list in prompt text, LLM doesn't care about gaps)
  - Spec ref: Simple Review System Prompt Content requirement

---

## Phase 2: Core Implementation — Thread `reviewLevel` into Agent Input Types

These tasks modify the three agent files to accept `reviewLevel` and inject the new prompt elements into system prompt assembly. Depends on Phase 1 (the new functions/constants must exist).
- [x] 2.1 **Add `reviewLevel` to `SimpleReviewInput` and inject into system prompt**
  - File: `packages/core/src/agents/simple.ts`
  - Add `reviewLevel: import('../types.js').ReviewLevel;` to the `SimpleReviewInput` interface (after `stackHints`)
  - Import `buildReviewLevelInstruction` and `REVIEW_CALIBRATION` from `./prompts.js`
  - Import `ReviewLevel` type from `../types.js`
  - In `runSimpleReview()` (line 150): destructure `reviewLevel` from input
  - In the system prompt assembly array (lines 156-163), append:
    - `buildReviewLevelInstruction(reviewLevel)` — after stackHints
    - `REVIEW_CALIBRATION` — as the last element (after review level instruction)
  - Spec ref: Review level flows through simple mode; Calibration block appears in simple mode prompt

- [x] 2.2 **Add `reviewLevel` to `WorkflowReviewInput` and inject into specialist + synthesis prompts**
  - File: `packages/core/src/agents/workflow.ts`
  - Add `reviewLevel: import('../types.js').ReviewLevel;` to `WorkflowReviewInput` interface
  - Import `buildReviewLevelInstruction` and `REVIEW_CALIBRATION` from `./prompts.js`
  - Import `ReviewLevel` type from `../types.js`
  - In `runWorkflowReview()` (line 80): destructure `reviewLevel` from input
  - In the specialist system prompt assembly (lines 97-104), append `buildReviewLevelInstruction(reviewLevel)` and `REVIEW_CALIBRATION` to the array
  - In the synthesis step (line 165-170): append `buildReviewLevelInstruction(reviewLevel)` and `REVIEW_CALIBRATION` to the synthesis system prompt (either by building a system array like specialists, or concatenating to `WORKFLOW_SYNTHESIS_SYSTEM`)
  - Spec ref: Review level flows through workflow mode; Calibration appears in every specialist prompt + synthesis

- [x] 2.3 **Add `reviewLevel` to `ConsensusReviewInput` and inject into stance prompts**
  - File: `packages/core/src/agents/consensus.ts`
  - Add `reviewLevel: import('../types.js').ReviewLevel;` to `ConsensusReviewInput` interface
  - Import `buildReviewLevelInstruction` and `REVIEW_CALIBRATION` from `./prompts.js`
  - Import `ReviewLevel` type from `../types.js`
  - In `runConsensusReview()` (line 189): destructure `reviewLevel` from input
  - In the stance system prompt assembly (lines 205-212), append `buildReviewLevelInstruction(reviewLevel)` and `REVIEW_CALIBRATION` to each model's system array
  - Spec ref: Review level flows through consensus mode; Calibration appears in all 3 stance prompts

---

## Phase 3: Pipeline Wiring — Pass `reviewLevel` from Settings to Agents

Depends on Phase 2 (agent input types must accept `reviewLevel`).
- [x] 3.1 **Pass `settings.reviewLevel` to all three agent calls in `pipeline.ts`**
  - File: `packages/core/src/pipeline.ts`
  - In the `case 'simple':` block (line 168-178): add `reviewLevel: input.settings.reviewLevel` to the `runSimpleReview()` call object
  - In the `case 'workflow':` block (line 181-190): add `reviewLevel: input.settings.reviewLevel` to the `runWorkflowReview()` call object
  - In the `case 'consensus':` block (line 194-206): add `reviewLevel: input.settings.reviewLevel` to the `runConsensusReview()` call object
  - Verify: TypeScript compilation passes (all agent input types now require `reviewLevel`)
  - Spec ref: Review Level Plumbing Through Agent Inputs (3 pipeline scenarios)

---

## Phase 4: Testing — Update Existing Tests & Add New Coverage

All test files co-located with source as `*.test.ts`. Depends on all prior phases being complete.

### 4A: Update tests that will break due to changed behavior

- [x] 4.1 **Update `prompts.test.ts` — fix `buildMemoryContext` assertions + add new test groups**
  - File: `packages/core/src/agents/prompts.test.ts`
  - **Fix broken tests**:
    - Line 53-54: Update `it('includes "Past Review Memory" section title')` — change expected string from `'Past Review Memory'` to `'Background Context from Past Reviews'` (or equivalent new header)
    - Line 58-61: Delete or rewrite `it('includes guidance footer')` — the old footer `'Use these past observations to give more informed, context-aware reviews.'` is removed. Replace with a test asserting the new anti-priming instruction (e.g., contains `'situational awareness only'` and `'Do NOT use them as reasons to flag issues'`)
  - **Add new tests**:
    - `describe('buildReviewLevelInstruction')`: test `'soft'` returns 90%+ confidence text; `'normal'` returns 80%+ confidence text; `'strict'` returns thorough review text
    - `describe('REVIEW_CALIBRATION')`: test it contains all 5 guardrail items (80%+ confidence, no stylistic preferences, no inventing standards, no hypothetical edge cases, PASSED permission)
    - `describe('SIMPLE_REVIEW_SYSTEM')`: add assertion that it does NOT contain `'coding standards and rules'`; verify it still contains the remaining 5 instruction items
  - Spec ref: All spec scenarios for Memory Context Framing, Review Level Calibration, Anti-False-Positive Calibration Block, Simple Review System Prompt Content

- [x] 4.2 **Update `search.test.ts` — change limit assertions from 8 to 3**
  - File: `packages/core/src/memory/search.test.ts`
  - Line 103: Change `{ limit: 8 }` to `{ limit: 3 }`
  - Line 186: Change `{ limit: 8 }` to `{ limit: 3 }`
  - Verify: `npm run test -- search.test` passes
  - Spec ref: Memory Context Retrieval Limit scenarios

- [x] 4.3 **Update `workflow.test.ts` — add `reviewLevel` to `makeInput` helper**
  - File: `packages/core/src/agents/workflow.test.ts`
  - Add `reviewLevel: 'normal' as const` to the `makeInput()` helper's default return (line 41-51)
  - Import `REVIEW_CALIBRATION` and `buildReviewLevelInstruction` in the mock for `./prompts.js` (line 13-21) — add them to the mock factory
  - **Add new test**: verify that specialist system prompts include the review-level instruction and calibration text when `reviewLevel` is provided
  - **Add new test**: verify that the synthesis system prompt includes review-level instruction and calibration text
  - Spec ref: Review level flows through workflow mode; Calibration block appears in workflow specialist prompts

- [x] 4.4 **Update `consensus.test.ts` — no structural changes needed but add integration coverage**
  - File: `packages/core/src/agents/consensus.test.ts`
  - Note: The existing tests focus on `parseVote` and `calculateConsensus` (pure functions), not on `runConsensusReview`. These tests will pass without changes.
  - **Optional**: Add a `runConsensusReview` integration test (similar to workflow.test.ts pattern) verifying that stance prompts include review-level instruction and calibration text. This requires mocking `ai`, `../providers/index.js`, and `./prompts.js` similar to workflow.test.ts.
  - Spec ref: Review level flows through consensus mode; Calibration block appears in consensus stance prompts

- [x] 4.5 **Update `pipeline.test.ts` — verify `reviewLevel` is passed to each agent**
  - File: `packages/core/src/pipeline.test.ts`
  - In the `'agent input'` describe block:
    - **Add test**: `it('passes reviewLevel from settings to simple agent')` — verify `runSimpleReview` was called with `expect.objectContaining({ reviewLevel: 'normal' })`
    - **Add test**: `it('passes reviewLevel to workflow agent')` — switch to workflow mode, verify `runWorkflowReview` gets `reviewLevel`
    - **Add test**: `it('passes reviewLevel to consensus agent')` — switch to consensus mode, verify `runConsensusReview` gets `reviewLevel` (inside the models array or top-level, depending on implementation)
  - Spec ref: Pipeline passes reviewLevel scenarios (simple, workflow, consensus)

- [x] 4.6 **Run full test suite and verify all tests pass**
  - Command: `npm run test` (or `pnpm test`, check package.json scripts) from `packages/core`
  - Verify: 0 failures, no regressions
  - Check: TypeScript compilation clean (`npx tsc --noEmit`)
  - Spec ref: Non-functional requirement — Existing tests remain valid

---

## Dependency Graph

```
Phase 1 (1.1, 1.2, 1.3, 1.4, 1.5)    — all independent, can run in parallel
         │
         ▼
Phase 2 (2.1, 2.2, 2.3)               — depend on 1.2 + 1.3; independent of each other
         │
         ▼
Phase 3 (3.1)                          — depends on 2.1 + 2.2 + 2.3
         │
         ▼
Phase 4 (4.1-4.6)                      — depends on all above; 4.1-4.5 can run in parallel, 4.6 last
```

## Traceability to Spec Scenarios

| Spec Requirement                           | Scenarios | Covered by Tasks                                  |
| ------------------------------------------ | --------- | ------------------------------------------------- |
| Memory Context Retrieval Limit             | 3         | 1.1, 4.2                                          |
| Memory Context Framing in Prompts          | 3         | 1.4, 4.1                                          |
| Aggressive Memory Priming (REMOVED)        | 1         | 1.4, 4.1                                          |
| Review Level Prompt Calibration            | 7         | 1.3, 2.1-2.3, 4.1, 4.3                            |
| Review Level Plumbing Through Agent Inputs | 3         | 2.1-2.3, 3.1, 4.5                                 |
| Anti-False-Positive Calibration Block      | 6         | 1.2, 2.1-2.3, 4.1, 4.3, 4.4                       |
| Simple Review System Prompt Content        | 2         | 1.5, 4.1                                          |
| No Schema or API Changes                   | 2         | (structural — verified by 4.6)                    |
| Cross-Provider Compatibility               | 1         | (manual — no provider-specific syntax in prompts) |
| Backward Compatibility of Pipeline Calls   | 2         | 3.1, 4.5                                          |
