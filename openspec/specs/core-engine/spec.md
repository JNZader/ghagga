# Core Review Engine Specification

> **Origin**: Archived from `ghagga-v2-rewrite` change, domain `core` (2026-03-07)

## Purpose

The core review engine is the heart of GHAGGA. It receives a code diff and configuration, orchestrates static analysis tools and AI agents, and returns a structured review result. It is distribution-agnostic — it knows nothing about HTTP, CLI, or GitHub Actions.

## Requirements

### Requirement: Review Pipeline Execution

The system MUST execute reviews through a layered pipeline: Layer 0 (static analysis), Layer 1 (memory retrieval), Layer 2 (AI agents), Layer 3 (memory persistence).

#### Scenario: Successful full pipeline review

- GIVEN a valid diff string and a repository configuration with mode "workflow"
- WHEN the review pipeline is executed
- THEN Layer 0 MUST run Semgrep, Trivy, and CPD in parallel
- AND Layer 1 MUST search memory for past observations related to the changed files
- AND Layer 2 MUST run the workflow agents with static analysis findings and memory context injected
- AND Layer 3 MUST save new observations from the review to memory
- AND the pipeline MUST return a structured ReviewResult

#### Scenario: Static analysis failure does not block review

- GIVEN a valid diff and configuration
- WHEN one or more static analysis tools fail (binary not found, timeout, crash)
- THEN the pipeline MUST continue with the remaining tools
- AND the pipeline MUST log a warning for each failed tool
- AND the AI agents MUST still receive whatever findings were collected

#### Scenario: Empty diff

- GIVEN an empty diff string
- WHEN the review pipeline is invoked
- THEN the system MUST return a ReviewResult with status "SKIPPED" and reason "empty diff"
- AND no AI tokens MUST be consumed

### Requirement: Simple Review Mode

The system MUST support a "simple" review mode that uses a single LLM call with a comprehensive system prompt.

#### Scenario: Simple review produces structured output

- GIVEN a diff and configuration with mode "simple"
- WHEN the simple review agent is executed
- THEN the agent MUST return a status (PASSED or FAILED)
- AND a summary (2-3 sentences)
- AND zero or more findings, each with: severity (critical/high/medium/low/info), category, file, line, message, and suggestion

#### Scenario: Simple review receives static analysis context

- GIVEN static analysis found 3 issues
- WHEN the simple review agent prompt is constructed
- THEN the prompt MUST include the static analysis findings formatted as pre-confirmed issues
- AND the prompt MUST instruct the agent NOT to repeat those findings

### Requirement: Workflow Review Mode

The system MUST support a "workflow" review mode with 5 specialist agents running in parallel, followed by a synthesis step.

#### Scenario: Five specialists run in parallel

- GIVEN a diff and configuration with mode "workflow"
- WHEN the workflow review is executed
- THEN 5 specialist agents MUST be invoked: scope-analysis, coding-standards, error-handling, security-audit, performance-review
- AND all 5 SHOULD run in parallel (using Promise.allSettled)
- AND if any specialist fails, the remaining results MUST still be synthesized

#### Scenario: Synthesis deduplicates findings

- GIVEN 5 specialist reports where 2 agents flagged the same issue
- WHEN the synthesis step runs
- THEN the final report MUST contain the finding only once
- AND the finding MUST reference the highest severity among duplicates

#### Scenario: Workflow with memory context

- GIVEN memory contains 2 past observations about the changed files
- WHEN the specialist agents receive their prompts
- THEN each specialist MUST receive the past observations as additional context

### Requirement: Consensus Review Mode

The system MUST support a "consensus" review mode where multiple LLM models review the same diff with different stances and vote on the outcome.

#### Scenario: Multi-model voting

- GIVEN a diff and configuration with mode "consensus" and 3 configured models
- WHEN the consensus review is executed
- THEN each model MUST review the diff with an assigned stance: one FOR approval, one AGAINST, one NEUTRAL
- AND each model MUST return: decision (approve/reject/abstain), confidence (0-1), and reasoning
- AND the final recommendation MUST be calculated using weighted voting

#### Scenario: Consensus threshold

- GIVEN 3 model votes: approve (confidence 0.9), reject (confidence 0.6), approve (confidence 0.8)
- WHEN the consensus is calculated
- THEN the recommendation MUST be "approve"
- AND the confidence gap between approve and reject MUST exceed 0.3 (30%)

#### Scenario: No clear consensus

- GIVEN 3 model votes with no decision reaching 60% weighted support
- WHEN the consensus is calculated
- THEN the recommendation MUST be "needs-human-review"
- AND the report MUST include all individual model reasoning

### Requirement: Multi-Provider AI Support

The system MUST support multiple LLM providers through the Vercel AI SDK (v5+).

> Updated by change: ai-sdk-v5-migration (2026-03-07)
> — Migrated from AI SDK v4 to v5, `@ai-sdk/*` providers from v1 to v2, Zod v3 to v4.
> — Token usage properties renamed: `usage.promptTokens` → `usage.inputTokens`, `usage.completionTokens` → `usage.outputTokens`.
> — Provider factories (`createAnthropic`, `createOpenAI`, `createGoogleGenerativeAI`) and `LanguageModel` type unchanged.
> — Zod v4 is fully backward compatible for the schema patterns used in this project.

#### Scenario: Provider fallback chain

- GIVEN a repository configured with provider "anthropic" and a valid API key
- WHEN the Anthropic API returns a 5xx error
- THEN the system SHOULD fall back to the next provider in the chain (OpenAI, then Google)
- AND the system MUST log which provider was used

#### Scenario: BYOK (Bring Your Own Key)

- GIVEN a repository with an encrypted API key stored in the database
- WHEN a review is triggered for that repository
- THEN the system MUST decrypt the key at runtime
- AND the key MUST never be logged or included in error messages
- AND the key MUST be used for all LLM calls for that review

### Requirement: Token Budget Management

The system MUST manage token consumption to avoid exceeding model context limits. Token usage from `generateText()` is tracked via `result.usage.inputTokens` and `result.usage.outputTokens` (AI SDK v5 naming).

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

### Requirement: Stack Detection

The system MUST auto-detect the tech stack from the files in the diff.

#### Scenario: TypeScript project detected

- GIVEN a diff containing `.ts` and `.tsx` files
- WHEN stack detection runs
- THEN the detected stack MUST include "typescript" and "react" (if JSX present)
- AND the agent prompts MUST receive stack-specific review hints

#### Scenario: Multi-language diff

- GIVEN a diff containing `.py`, `.go`, and `.sql` files
- WHEN stack detection runs
- THEN the detected stacks MUST include "python", "go", and "sql"
- AND each language-specific hint MUST be included in the prompt

---

### Requirement: Staged Diff Mode

> Added by change: cli-git-hooks

The review pipeline MUST support receiving a diff scoped to staged files only, instead of the full working tree diff. The staged diff MUST be obtained via `git diff --cached` and passed through the same pipeline as a regular diff.

#### Scenario: Staged diff with changes

- GIVEN a repository with staged changes (files added to the git index)
- WHEN the review pipeline receives a staged diff
- THEN the pipeline MUST process the diff through all enabled layers (static analysis, memory, AI agents, memory persistence)
- AND the findings MUST reference only files present in the staged diff

#### Scenario: No staged changes

- GIVEN a repository with no staged changes (`git diff --cached` produces empty output)
- WHEN the review pipeline is invoked with staged mode
- THEN the pipeline MUST return a ReviewResult with status `SKIPPED`
- AND no static analysis tools MUST be invoked
- AND no AI tokens MUST be consumed

#### Scenario: Partially staged file

- GIVEN a file has some hunks staged and others unstaged
- WHEN the review pipeline receives the staged diff
- THEN the diff MUST contain only the staged hunks
- AND the review MUST evaluate only the staged content, not the unstaged portions

---

### Requirement: Quick Mode (Static Analysis Only)

> Added by change: cli-git-hooks

The review pipeline MUST support a `quick` mode that runs only static analysis tools (Semgrep, Trivy, CPD) and skips the AI/LLM review step entirely. This mode is designed for speed-sensitive contexts like pre-commit hooks.

#### Scenario: Quick mode skips AI review

- GIVEN a valid diff and configuration with `quick` mode enabled
- WHEN the review pipeline is executed
- THEN Layer 0 (static analysis) MUST run normally
- AND Layer 2 (AI agents) MUST be skipped entirely
- AND no LLM API calls MUST be made
- AND no AI tokens MUST be consumed

#### Scenario: Quick mode preserves static analysis findings

- GIVEN a diff containing code with known Semgrep rule violations
- AND `quick` mode is enabled
- WHEN the review pipeline completes
- THEN the ReviewResult MUST contain the Semgrep findings
- AND the metadata MUST indicate the provider as `none` and model as `static-only`

#### Scenario: Quick mode with memory

- GIVEN `quick` mode is enabled
- AND memory is enabled
- WHEN the review pipeline is executed
- THEN Layer 1 (memory retrieval) MAY be skipped (no AI agents to inject context into)
- AND Layer 3 (memory persistence) MUST still save static analysis observations

#### Scenario: Quick mode execution time

- GIVEN a typical diff (< 500 lines)
- AND `quick` mode is enabled
- WHEN the review pipeline is executed
- THEN the total execution time SHOULD be under 10 seconds

---

### Requirement: Commit Message Validation Mode

> Added by change: cli-git-hooks

The review pipeline MUST support a commit message validation mode that reads a commit message from a file path and evaluates its quality using a lightweight LLM prompt. This mode does NOT analyze code diffs.

#### Scenario: Valid commit message

- GIVEN a commit message file containing `feat(auth): add OAuth2 device flow for GitHub login`
- WHEN the commit message validation is executed
- THEN the result MUST have status `PASSED`
- AND the summary MUST indicate the commit message is acceptable

#### Scenario: Low-quality commit message

- GIVEN a commit message file containing `fix`
- WHEN the commit message validation is executed
- THEN the result MUST have status `FAILED`
- AND at least one finding with severity `high` or `critical` MUST be present
- AND the finding MUST explain why the message is inadequate

#### Scenario: Empty commit message file

- GIVEN a commit message file that is empty or contains only whitespace
- WHEN the commit message validation is executed
- THEN the result MUST have status `FAILED`
- AND a finding MUST indicate the commit message is empty

#### Scenario: Commit message file not found

- GIVEN a commit message file path that does not exist
- WHEN the commit message validation is attempted
- THEN the system MUST return an error indicating the file was not found
- AND the exit code MUST be non-zero

#### Scenario: Commit message validation does not run static analysis

- GIVEN commit message validation mode is active
- WHEN the pipeline is executed
- THEN static analysis tools (Semgrep, Trivy, CPD) MUST NOT be invoked
- AND only the commit message LLM prompt MUST be sent

#### Scenario: Commit message validation with quick mode

- GIVEN `--commit-msg` and `--quick` are both specified
- WHEN the pipeline is executed
- THEN the commit message MUST be validated using basic heuristics (length, non-empty)
- AND no LLM call MUST be made
- AND egregiously short or empty messages MUST be flagged

---

### Requirement: Exit on Issues Mode

> Added by change: cli-git-hooks

The review pipeline MUST support an `exit-on-issues` mode where the process exits with code 1 when any finding has severity `critical` or `high`. This enables hooks to block commits on serious issues.

#### Scenario: Critical issue found with exit-on-issues

- GIVEN a review result containing at least one finding with severity `critical`
- AND `exit-on-issues` mode is active
- WHEN the exit code is determined
- THEN the exit code MUST be 1

#### Scenario: High issue found with exit-on-issues

- GIVEN a review result containing findings with severity `high` but none with `critical`
- AND `exit-on-issues` mode is active
- WHEN the exit code is determined
- THEN the exit code MUST be 1

#### Scenario: Only medium/low/info issues with exit-on-issues

- GIVEN a review result containing findings with severity `medium`, `low`, and `info` only
- AND `exit-on-issues` mode is active
- WHEN the exit code is determined
- THEN the exit code MUST be 0

#### Scenario: No findings with exit-on-issues

- GIVEN a review result with zero findings
- AND `exit-on-issues` mode is active
- WHEN the exit code is determined
- THEN the exit code MUST be 0

#### Scenario: Exit-on-issues not active (default behavior)

- GIVEN a review result containing findings with severity `critical`
- AND `exit-on-issues` mode is NOT active
- WHEN the exit code is determined
- THEN the exit code MUST follow the existing behavior (based on ReviewStatus, not finding severity)

---

### Requirement: Mutually Exclusive Flags

> Added by change: cli-git-hooks

The flags `--staged` and `--commit-msg` MUST be treated as mutually exclusive. They represent different review modes and MUST NOT be combined.

#### Scenario: --staged and --commit-msg together

- GIVEN the user runs `ghagga review --staged --commit-msg .git/COMMIT_EDITMSG`
- WHEN the command parses the options
- THEN the system MUST display an error message indicating `--staged` and `--commit-msg` are mutually exclusive
- AND the exit code MUST be non-zero
- AND no review MUST be executed

#### Scenario: --staged alone is valid

- GIVEN the user runs `ghagga review --staged`
- WHEN the command parses the options
- THEN no validation error MUST occur
- AND the staged diff review MUST proceed

#### Scenario: --commit-msg alone is valid

- GIVEN the user runs `ghagga review --commit-msg .git/COMMIT_EDITMSG`
- WHEN the command parses the options
- THEN no validation error MUST occur
- AND the commit message validation MUST proceed

#### Scenario: --quick with --commit-msg is valid

- GIVEN the user runs `ghagga review --commit-msg .git/COMMIT_EDITMSG --quick`
- WHEN the command parses the options
- THEN no validation error MUST occur
- AND the commit message MUST be validated using heuristics only (no LLM)

---

### Requirement: ReviewInput Type Extension

> Added by change: cli-git-hooks (modifies Review Pipeline Execution)

The `ReviewInput` type MUST be extended with new optional fields to support the staged, quick, commit-msg, and exit-on-issues modes.

#### Scenario: ReviewInput with staged mode fields

- GIVEN a CLI invocation with `--staged`
- WHEN the ReviewInput is constructed
- THEN the `diff` field MUST contain the output of `git diff --cached`
- AND existing pipeline behavior MUST apply to this diff identically

#### Scenario: ReviewInput with quick mode

- GIVEN a CLI invocation with `--quick`
- WHEN the ReviewInput is constructed
- THEN `aiReviewEnabled` MUST be set to `false`
- AND the pipeline MUST skip AI agents per existing behavior for `aiReviewEnabled: false`

#### Scenario: Default behavior unchanged

- GIVEN a CLI invocation without any of the new flags
- WHEN the ReviewInput is constructed
- THEN none of the new fields MUST affect the pipeline
- AND existing behavior MUST be preserved exactly


## Backend-Agnostic Generation and Rate-Aware Scheduling

### Requirement: Backend-Agnostic Text Generation

The review engine MUST expose one asynchronous text-generation contract for AI
SDK, CLI Bridge, and Gateway backends. Simple, workflow, and consensus modes
MUST consume that contract without backend-specific review implementations.
When callers do not inject a generation function, the agents MUST retain the
AI SDK-compatible fallback behavior.

#### Scenario: Workflow review through CLI Bridge

- GIVEN CLI Bridge resolves to one generation function
- WHEN workflow mode runs
- THEN all specialist and synthesis calls use that function
- AND execution is serialized when only one function is available

#### Scenario: Consensus review through Gateway

- GIVEN Gateway resolves to a generation function
- WHEN consensus mode runs
- THEN every stance and vote uses the shared generation contract
- AND provider/model metadata from each result is preserved

### Requirement: Rate-Aware Review Scheduling

Workflow and consensus review MUST accept a positive integer concurrency limit
and a non-negative inter-batch delay. The pipeline MUST validate and pass these
settings to the agents. Multi-call prompts SHOULD avoid repeating shared
calibration context after the first call, and HTTP 413 responses MUST be
eligible for provider fallback.

#### Scenario: Free-tier provider is serialized

- GIVEN `reviewConcurrency` is `1` and `reviewDelayMs` is non-zero
- WHEN a workflow or consensus review executes multiple calls
- THEN no more than one call runs at once
- AND the configured delay is applied between batches

#### Scenario: Oversized request falls back

- GIVEN the active provider returns HTTP 413
- AND a fallback provider exists
- WHEN generation is attempted
- THEN the engine retries through the fallback chain instead of failing the review immediately
