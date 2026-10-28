# Delta for review-prompts

> **Change**: `reduce-false-positives`
> **Domain**: Review Prompts & Memory Context (`packages/core/src/agents/`, `packages/core/src/memory/`)
> **Status**: Draft
> **Date**: 2026-03-05

---

## MODIFIED Requirements

### Requirement: Memory Context Retrieval Limit

The system MUST retrieve at most **3** observations when searching past review memory for prompt context.

(Previously: The system retrieved up to 8 observations via `searchMemoryForContext()` with `{ limit: 8 }`.)

#### Scenario: Memory search returns observations within the new limit

- GIVEN a project with 10 past review observations in the database
- WHEN `searchMemoryForContext()` is called for a new review
- THEN at most 3 observations are returned
- AND the 3 observations are the highest-ranked matches for the current file paths

#### Scenario: Memory search with fewer observations than the limit

- GIVEN a project with 2 past review observations in the database
- WHEN `searchMemoryForContext()` is called for a new review
- THEN all 2 observations are returned (no padding or synthetic observations)

#### Scenario: Memory search with no observations

- GIVEN a project with zero past review observations in the database
- WHEN `searchMemoryForContext()` is called for a new review
- THEN `null` is returned
- AND the review pipeline continues without memory context

---

### Requirement: Memory Context Framing in Prompts

The system MUST frame injected memory observations as **passive background context** that SHALL NOT be used as justification for flagging issues. The `buildMemoryContext()` function MUST include explicit instructions that observations are for situational awareness only and that findings MUST be justified solely from the code diff.

(Previously: `buildMemoryContext()` framed memory as "Past Review Memory (learned from previous reviews)" with the instruction "Use these past observations to give more informed, context-aware reviews," which encouraged the LLM to flag issues based on historical patterns rather than the actual diff.)

#### Scenario: Memory context is injected with anti-priming instructions

- GIVEN a review with non-null memory context containing 2 past observations
- WHEN `buildMemoryContext()` formats the memory for prompt injection
- THEN the output MUST contain an instruction stating the observations are "background context" or "situational awareness only"
- AND the output MUST contain an explicit prohibition: "Do NOT use them as reasons to flag issues" or equivalent phrasing
- AND the output MUST contain a directive that findings must be justified "from the code diff itself" or equivalent phrasing

#### Scenario: Memory context is null

- GIVEN a review with null memory context (memory disabled, no DB, or no matches)
- WHEN `buildMemoryContext(null)` is called
- THEN an empty string is returned
- AND no memory-related instructions appear in the system prompt

#### Scenario: Memory context does not dominate the prompt

- GIVEN a review where the diff is under 500 tokens
- WHEN memory context is injected into the system prompt
- THEN the memory context section SHOULD NOT exceed the size of the diff section
- AND the memory framing instructions remain present regardless of diff size

---

## ADDED Requirements

### Requirement: Review Level Prompt Calibration

The system MUST inject review-level-specific calibration instructions into the system prompt for **all three review modes** (simple, workflow, consensus) based on the `reviewLevel` field from `ReviewSettings`.

A new function `buildReviewLevelInstruction(level: ReviewLevel)` MUST exist in `prompts.ts` that returns level-appropriate instructions.

#### Scenario: Soft review level — bugs and security only

- GIVEN a review with `reviewLevel` set to `'soft'`
- WHEN the system prompt is assembled for any review mode
- THEN the prompt MUST include an instruction requiring **90%+ confidence** before flagging
- AND the prompt MUST instruct the reviewer to focus **exclusively** on bugs, security vulnerabilities, and logic errors
- AND the prompt MUST instruct the reviewer to **ignore** style, naming, and maintainability concerns

#### Scenario: Normal review level — balanced with caution on style

- GIVEN a review with `reviewLevel` set to `'normal'`
- WHEN the system prompt is assembled for any review mode
- THEN the prompt MUST include an instruction requiring **80%+ confidence** before flagging
- AND the prompt MUST instruct the reviewer to cover bugs, security, performance, and error handling
- AND the prompt MUST instruct the reviewer to be **cautious** with style-only findings

#### Scenario: Strict review level — thorough review

- GIVEN a review with `reviewLevel` set to `'strict'`
- WHEN the system prompt is assembled for any review mode
- THEN the prompt MUST instruct the reviewer to perform a **thorough review** covering all categories
- AND the prompt MUST include style, naming, and documentation in the review scope
- AND the prompt MUST instruct the reviewer to flag anything that could be improved

#### Scenario: Default review level when not explicitly set

- GIVEN a review where `reviewLevel` is `'normal'` (the default from `DEFAULT_SETTINGS`)
- WHEN the system prompt is assembled
- THEN the `'normal'` calibration instructions are injected
- AND no error or fallback occurs

#### Scenario: Review level flows through simple mode

- GIVEN a review in `'simple'` mode with `reviewLevel` set to `'soft'`
- WHEN `runSimpleReview()` assembles the system prompt
- THEN the soft-level calibration instructions appear in the system prompt sent to the LLM

#### Scenario: Review level flows through workflow mode

- GIVEN a review in `'workflow'` mode with `reviewLevel` set to `'soft'`
- WHEN `runWorkflowReview()` assembles the system prompt for each specialist
- THEN the soft-level calibration instructions appear in **every** specialist's system prompt
- AND the calibration instructions also appear in the synthesis prompt

#### Scenario: Review level flows through consensus mode

- GIVEN a review in `'consensus'` mode with `reviewLevel` set to `'strict'`
- WHEN `runConsensusReview()` assembles the system prompt for each model vote
- THEN the strict-level calibration instructions appear in **every** stance prompt (for, against, neutral)

---

### Requirement: Review Level Plumbing Through Agent Inputs

The `SimpleReviewInput`, `WorkflowReviewInput`, and `ConsensusReviewInput` interfaces MUST accept a `reviewLevel` field. The pipeline MUST pass `settings.reviewLevel` from `ReviewInput` into each agent's input type.

#### Scenario: Pipeline passes reviewLevel to simple agent

- GIVEN a `ReviewInput` with `settings.reviewLevel` set to `'soft'`
- WHEN the pipeline dispatches to `runSimpleReview()`
- THEN the `SimpleReviewInput` includes `reviewLevel: 'soft'`

#### Scenario: Pipeline passes reviewLevel to workflow agent

- GIVEN a `ReviewInput` with `settings.reviewLevel` set to `'strict'`
- WHEN the pipeline dispatches to `runWorkflowReview()`
- THEN the `WorkflowReviewInput` includes `reviewLevel: 'strict'`

#### Scenario: Pipeline passes reviewLevel to consensus agent

- GIVEN a `ReviewInput` with `settings.reviewLevel` set to `'normal'`
- WHEN the pipeline dispatches to `runConsensusReview()`
- THEN the `ConsensusReviewInput` includes `reviewLevel: 'normal'`

---

### Requirement: Anti-False-Positive Calibration Block

The system MUST append a `REVIEW_CALIBRATION` constant to the system prompts of **all** review modes. This calibration block MUST contain the following anti-hallucination guardrails:
1. A confidence threshold instruction: only report findings with 80%+ confidence based on the actual code shown.
2. A prohibition against flagging stylistic preferences unless they violate an explicitly provided rule.
3. A prohibition against inventing or assuming coding standards that are not provided.
4. A prohibition against flagging hypothetical edge cases that are unlikely in practice.
5. An explicit permission to return `STATUS: PASSED` with zero findings when the diff is small and clean.

#### Scenario: Calibration block appears in simple mode prompt

- GIVEN a review in `'simple'` mode
- WHEN the system prompt is assembled
- THEN the `REVIEW_CALIBRATION` text appears in the system prompt
- AND it appears after the main review instructions (not before)

#### Scenario: Calibration block appears in workflow specialist prompts

- GIVEN a review in `'workflow'` mode
- WHEN each specialist's system prompt is assembled
- THEN the `REVIEW_CALIBRATION` text appears in each of the 5 specialist system prompts

#### Scenario: Calibration block appears in consensus stance prompts

- GIVEN a review in `'consensus'` mode
- WHEN each stance's system prompt is assembled
- THEN the `REVIEW_CALIBRATION` text appears in all 3 stance prompts (for, against, neutral)

#### Scenario: Calibration block prohibits inventing standards

- GIVEN a review where `customRules` is empty (no repository-specific rules provided)
- WHEN the LLM evaluates the diff
- THEN the system prompt MUST NOT contain any instruction to "check adherence to coding standards"
- AND the calibration block MUST contain a prohibition against inventing or assuming coding standards

#### Scenario: Calibration block permits PASSED on clean diffs

- GIVEN a review of a small, clean diff (e.g., a 10-line variable rename)
- WHEN the LLM evaluates the diff
- THEN the system prompt MUST contain an instruction that returning `STATUS: PASSED` with zero findings is acceptable
- AND the LLM is not pressured to produce findings where none exist

#### Scenario: Calibration interacts with review level

- GIVEN a review with `reviewLevel: 'soft'` and the `REVIEW_CALIBRATION` block
- WHEN the system prompt is assembled
- THEN BOTH the soft-level instruction (90%+ confidence) AND the calibration block (80%+ confidence) appear in the prompt
- AND the more restrictive threshold (90% from soft level) takes effective precedence

---

## MODIFIED Requirements

### Requirement: Simple Review System Prompt Content

The `SIMPLE_REVIEW_SYSTEM` constant MUST be updated to remove the instruction "Check adherence to the repository's coding standards and rules" (currently item 6 in the numbered list). This instruction is misleading because no standards are actually provided to the LLM, causing it to invent phantom coding standards and flag false positives based on imagined rules.

(Previously: `SIMPLE_REVIEW_SYSTEM` contained 6 numbered instructions including item 6: "Check adherence to the repository's coding standards and rules".)

#### Scenario: System prompt no longer references unprovidable standards

- GIVEN the `SIMPLE_REVIEW_SYSTEM` constant
- WHEN it is read as a string
- THEN it MUST NOT contain the phrase "coding standards and rules" or equivalent
- AND it MUST contain the remaining 5 review instruction items (bugs, error handling, code quality, security, performance)

#### Scenario: Custom rules are still respected when provided

- GIVEN a review where `customRules` contains `["no-console-log", "max-function-length-50"]`
- WHEN the system prompt is assembled
- THEN the custom rules MAY be injected separately (outside `SIMPLE_REVIEW_SYSTEM`)
- AND the calibration block's prohibition against inventing standards does not conflict with explicitly provided rules

---

## REMOVED Requirements

### Requirement: Aggressive Memory Priming Instruction

The `buildMemoryContext()` function MUST NOT include the directive "Use these past observations to give more informed, context-aware reviews" or any phrasing that encourages the LLM to actively use past observations as a basis for current findings.

(Reason: This phrasing caused the LLM to pattern-match past observations against the current diff and generate false positives based on historical issues that are not present in the current code. Memory should inform, not drive, the review.)

#### Scenario: Old priming language is absent

- GIVEN a review with non-null memory context
- WHEN `buildMemoryContext()` formats the output
- THEN the output MUST NOT contain "give more informed" or "context-aware reviews"
- AND the output MUST NOT contain any imperative to "use" the observations for review decisions

---

## Non-Functional Requirements

### Requirement: No Schema or API Changes

All changes in this delta MUST be confined to the prompt/memory layer within `packages/core`. There MUST be no database schema changes, no new npm dependencies, no API contract changes, and no modifications to the `ReviewResult` output shape.

#### Scenario: Types remain structurally unchanged

- GIVEN the `ReviewLevel` type in `types.ts`
- WHEN this change is applied
- THEN the type definition `'soft' | 'normal' | 'strict'` MUST remain unchanged
- AND no new types are added to `types.ts` beyond what already exists

#### Scenario: Existing tests remain valid

- GIVEN the existing test suite in the repository
- WHEN this change is applied
- THEN all existing tests MUST pass without modification
- AND any test that asserts on prompt content MAY need updating only if it asserts on the removed "coding standards" line or the old memory framing text

### Requirement: Cross-Provider Compatibility

The calibration instructions and review-level prompts MUST use universal, provider-agnostic language. They MUST NOT rely on provider-specific prompt engineering tricks (e.g., Anthropic XML tags, OpenAI system role hacks).

#### Scenario: Prompts work across all supported providers

- GIVEN the calibration and review-level instructions
- WHEN the same diff is reviewed using Anthropic, OpenAI, and Google providers
- THEN each provider SHOULD produce reviews that respect the calibration guardrails
- AND no provider-specific formatting is required in the injected instructions

### Requirement: Backward Compatibility of Pipeline Calls

The `reviewPipeline()` function signature and the `ReviewInput` type MUST NOT change. The `reviewLevel` field already exists on `ReviewSettings` and MUST be threaded internally without altering external contracts.

#### Scenario: CLI distribution mode is unaffected

- GIVEN a CLI invocation that does not set `reviewLevel` explicitly
- WHEN `DEFAULT_SETTINGS` provides `reviewLevel: 'normal'`
- THEN the review runs with normal-level calibration
- AND the CLI does not need any code changes

#### Scenario: SaaS distribution mode is unaffected

- GIVEN a SaaS review triggered via webhook
- WHEN `reviewLevel` is read from the repository's stored settings
- THEN the review runs with the configured level
- AND no server-side code changes are needed beyond what `packages/core` provides

---

## Traceability Matrix

| Proposal Section                   | Spec Requirement                                | Scenarios        |
| ---------------------------------- | ----------------------------------------------- | ---------------- |
| Change 1: Memory limit             | Memory Context Retrieval Limit                  | 3                |
| Change 1: Instruction reframe      | Memory Context Framing in Prompts               | 3                |
| Change 1: Instruction reframe      | Aggressive Memory Priming Instruction (REMOVED) | 1                |
| Change 2: Wire reviewLevel         | Review Level Prompt Calibration                 | 7                |
| Change 2: Wire reviewLevel         | Review Level Plumbing Through Agent Inputs      | 3                |
| Change 3: Anti-false-positive      | Anti-False-Positive Calibration Block           | 6                |
| Change 3: Remove phantom standards | Simple Review System Prompt Content             | 2                |
| Cross-cutting                      | No Schema or API Changes                        | 2                |
| Cross-cutting                      | Cross-Provider Compatibility                    | 1                |
| Cross-cutting                      | Backward Compatibility of Pipeline Calls        | 2                |
| **Totals**                         | **10 requirements**                             | **30 scenarios** |
