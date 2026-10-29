# Proposal: Reduce False Positives in AI Reviews

## Intent

GHAGGA's AI code review produces too many false positives, eroding developer trust in the tool. Developers report that 30-50% of flagged findings are stylistic preferences, hypothetical edge cases, or pattern-matched ghosts from memory context. The root cause is a combination of aggressive memory priming, a dead `reviewLevel` config, unenforced token budgets, and system prompts that encourage the LLM to invent coding standards. This proposal describes three targeted, low-risk changes to the prompt layer and memory retrieval that will measurably reduce noise without losing real findings.

## Scope

### In Scope

1. **Reduce memory observation limit and reframe instruction** — Change `searchMemoryForContext()` limit from 8 to 3 observations, and rewrite `buildMemoryContext()` to treat memory as passive background context that MUST NOT be used as justification for flagging new issues.
2. **Wire `reviewLevel` into all review prompts** — Make the existing `ReviewLevel` type (`soft | normal | strict`) actually influence the system prompt: `soft` restricts to high-confidence bugs/security only; `normal` is unchanged; `strict` enables thorough analysis including style.
3. **Add anti-false-positive instructions to all system prompts** — Inject a confidence threshold ("Only report findings you are 80%+ confident about"), prohibit inventing coding standards, and ban flagging stylistic preferences or hypothetical edge cases.

### Out of Scope

- **Negative feedback loop in memory** — Storing false-positive dismissals as counter-observations is a larger change (schema, UI, persist logic) deferred to a follow-up.
- **Enforcing the token budget** — `calculateTokenBudget()` returns budgets but nothing truncates context to fit. Important but orthogonal; tracked separately.
- **Per-repository custom rules** — The `customRules` field in `ReviewSettings` is empty for most repos. Providing a rules authoring UX is a separate feature.
- **Consensus mode improvements** — The consensus agent produces votes not findings; its false-positive dynamics differ and need separate investigation.

## Approach

Three surgical edits to the `packages/core` package, all confined to the prompt/memory layer. No schema changes, no new dependencies, no API changes, no database migrations.

### Change 1: Memory limit + instruction reframe

**File**: `packages/core/src/memory/search.ts` (line 87)
- Change `{ limit: 8 }` to `{ limit: 3 }`

**File**: `packages/core/src/agents/prompts.ts` (lines 184-187)
- Rewrite `buildMemoryContext()` to use phrasing like: _"The following observations are background context from past reviews of this project. They are provided for situational awareness only. Do NOT use them as reasons to flag issues. Only flag issues you can justify from the code diff itself."_

### Change 2: Wire `reviewLevel` into prompts

**File**: `packages/core/src/agents/prompts.ts`
- Add a new `buildReviewLevelInstruction(level: ReviewLevel): string` function that returns:
  - `soft`: _"Only flag issues you are very confident about (90%+). Focus exclusively on bugs, security vulnerabilities, and logic errors. Ignore style, naming, and maintainability concerns."_
  - `normal`: _"Flag issues you are confident about (80%+). Cover bugs, security, performance, and error handling. Be cautious with style-only findings."_
  - `strict`: _"Perform a thorough review covering all categories including style, naming, and documentation. Flag anything that could be improved."_

**Files**: `packages/core/src/agents/simple.ts` (lines 156-163), `packages/core/src/agents/workflow.ts` (lines 97-104), `packages/core/src/agents/consensus.ts` (lines 205-212)
- Thread `reviewLevel` from `ReviewSettings` through the input types and inject `buildReviewLevelInstruction()` into the system prompt assembly for all three review modes.

### Change 3: Anti-false-positive instructions

**File**: `packages/core/src/agents/prompts.ts`
- Add a `REVIEW_CALIBRATION` constant appended to `SIMPLE_REVIEW_SYSTEM` and all workflow specialist prompts:

  ```
  ## Review Calibration
  - Only report findings you are 80%+ confident about based on the actual code shown.
  - Do NOT flag stylistic preferences unless they violate an explicitly provided rule.
  - Do NOT invent or assume coding standards that are not provided.
  - Do NOT flag hypothetical edge cases that are unlikely in practice.
  - If the diff is small and clean, it is OK to return STATUS: PASSED with zero findings.
  ```
- Remove line 6 of `SIMPLE_REVIEW_SYSTEM` ("Check adherence to the repository's coding standards and rules") since no standards are actually provided.

## Affected Areas

| Area                                    | Impact    | Description                                                                                                                            |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/agents/prompts.ts`   | Modified  | Rewrite `buildMemoryContext()`, add `buildReviewLevelInstruction()`, add `REVIEW_CALIBRATION` constant, remove phantom standards check |
| `packages/core/src/memory/search.ts`    | Modified  | Reduce observation limit from 8 to 3                                                                                                   |
| `packages/core/src/agents/simple.ts`    | Modified  | Accept `reviewLevel` in input, inject into system prompt assembly                                                                      |
| `packages/core/src/agents/workflow.ts`  | Modified  | Accept `reviewLevel` in input, inject into system prompt assembly for all specialists                                                  |
| `packages/core/src/agents/consensus.ts` | Modified  | Accept `reviewLevel` in input, inject into system prompt assembly for all stances                                                      |
| `packages/core/src/types.ts`            | Unchanged | `ReviewLevel` type already exists and is correctly defined                                                                             |
| `packages/db/src/schema.ts`             | Unchanged | Schema already stores `reviewLevel`                                                                                                    |

## Risks

| Risk                                                                                       | Likelihood | Mitigation                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reducing memory from 8 to 3 may lose relevant context for large repos with deep history    | Low        | 3 observations is still sufficient for the top-ranked matches; quality > quantity. Can tune later with A/B testing.                                                  |
| Anti-false-positive instructions may suppress real findings (false negatives)              | Medium     | The 80% confidence threshold is deliberately conservative. `strict` mode preserves the old thorough behavior. We monitor PASSED rate and finding counts post-deploy. |
| `soft` mode may be too aggressive in suppressing findings, making reviews feel useless     | Low        | `soft` is opt-in and clearly documented. Default remains `normal`.                                                                                                   |
| Prompt changes interact unpredictably across LLM providers (Anthropic vs OpenAI vs Google) | Medium     | Test the same diff against all 3 major providers before merging. Calibration instructions use universal language, not provider-specific tricks.                      |
| Adding review level to all three agent input types requires plumbing through the pipeline  | Low        | `reviewLevel` is already on `ReviewSettings` which is on `ReviewInput`. We just need to pass `settings.reviewLevel` into each agent's input type.                    |

## Rollback Plan

All changes are in the prompt/retrieval layer with no schema or API changes:
1. **Revert the commit** — A single `git revert` restores the previous prompts, memory limit, and agent inputs.
2. **No data migration needed** — Memory observations are unaffected. The database schema is unchanged.
3. **No client-side changes** — All 4 distribution modes (SaaS, Action, CLI, 1-click) consume the same `@ghagga/core` package. Reverting core reverts everything.
4. **Feature flag alternative** — If partial rollback is needed, revert only the memory limit (search.ts) or only the prompt changes (prompts.ts) independently. The three changes are additive and independent.

## Dependencies

- None. All changes are internal to `packages/core` using existing types and interfaces.

## Success Criteria

- [ ] False positive rate decreases by at least 30% (measured by: findings dismissed without action by developers on the SaaS dashboard over 2-week window post-deploy vs. pre-deploy baseline)
- [ ] No increase in false negatives (measured by: no bugs in merged PRs that GHAGGA previously caught but now misses — spot-check 20 recent PRs)
- [ ] `reviewLevel: 'soft'` produces at most 1-2 findings on a clean, well-written small PR (< 200 lines)
- [ ] `reviewLevel: 'strict'` produces equivalent or more findings than the current behavior
- [ ] Memory context in prompts is never larger than the diff itself for PRs under 500 tokens of diff
- [ ] All existing tests pass without modification (prompt changes are behavioral, not structural)
- [ ] Manual test: run the same 5 real-world PRs through old and new prompts, compare finding counts and quality
