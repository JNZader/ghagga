# Core Engine Delta

> **Change**: `review-output-compression`
> **Base spec**: `openspec/specs/core-engine/spec.md`
>
> **Merge seam**: the open change `graph-context-retrieval` also MODIFIES `Requirement: Token Budget Management` (graph-neighborhood budget). This delta is written against the current base text (two scenarios below). Whichever change archives second MUST rebase onto the archived result so both requirement extensions survive — do not archive blind.

## MODIFIED Requirements

### Requirement: Token Budget Management

The system MUST manage token consumption to avoid exceeding model context limits. Token usage from `generateText()` is tracked via `result.usage.inputTokens` and `result.usage.outputTokens` (AI SDK v5 naming).

Every review mode MUST measure `GenerateResult.outputTokens` separately and propagate it into review metadata. Workflow and consensus already aggregate `metadata.outputTokensUsed` across their voices; simple, diagnostic, and fan-out MUST do the same, with fan-out summing `outputTokens` across all of its generate calls (lenses, contrarian, refuters). Rationale: output tokens are the expensive side of every review call, and the output-compression success metric is unevaluable for the three gap voices without this split.

`metadata.outputTokensUsed` MUST be populated only when the provider reports a token split; when it does not (the gateway default), the field MUST be absent and `tokensUsed` MUST remain the authoritative total either way. The cost footer's three split states — both sides measured, exactly one side measured with the other heuristic, or neither measured (70/30 heuristic) — MUST apply uniformly across all review modes.

(Previously: the requirement covered model-context truncation and usage tracking only.)

#### Scenario: Diff exceeds model context

- GIVEN a diff that exceeds the configured model's context window
- WHEN the review pipeline prepares the prompt
- THEN the diff MUST be truncated to fit within the token budget
- AND the truncation MUST prioritize files with the most changes
- AND the review result MUST note that the diff was truncated

#### Scenario: Token usage tracking with AI SDK v5

> Added by change: ai-sdk-v5-migration
- GIVEN a single-step `generateText()` call completes successfully
- WHEN the result usage is accessed
- THEN `result.usage.inputTokens` MUST contain the prompt token count
- AND `result.usage.outputTokens` MUST contain the completion token count
- AND the total tokens used MUST be calculated as `inputTokens + outputTokens`

#### Scenario: Output-token split is reported for a gap voice

- GIVEN a simple review that completes on a provider reporting the input/output split in `GenerateResult` (AI-SDK path)
- WHEN the review metadata is assembled
- THEN `metadata.outputTokensUsed` MUST equal the summed `outputTokens` across the mode's generate calls
- AND `metadata.tokensUsed` MUST remain the authoritative grand total
- AND the cost footer MUST render the output side as measured, not as the 70/30 heuristic
- AND the same behavior MUST hold for diagnostic and fan-out modes

#### Scenario: No split reported leaves the field absent

- GIVEN a diagnostic or fan-out review on the gateway provider, which reports no token split
- WHEN the review metadata is assembled
- THEN `metadata.outputTokensUsed` MUST be absent
- AND `metadata.tokensUsed` MUST still carry the total
- AND the cost footer MUST fall back to the 70/30 heuristic with estimated labeling
- AND the review MUST NOT fail or degrade

#### Scenario: Multi-voice aggregation is unchanged

- GIVEN a fan-out review with 3 lens calls, 1 contrarian call, and 2 refuter calls, all on a split-reporting provider
- WHEN the review completes
- THEN `metadata.outputTokensUsed` MUST equal the sum of `outputTokens` across all 6 calls
- AND the existing workflow and consensus aggregation semantics MUST remain unchanged by this change
