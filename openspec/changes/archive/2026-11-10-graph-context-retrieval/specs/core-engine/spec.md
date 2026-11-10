# Core Engine Delta

> **Change**: `graph-context-retrieval`
> **Base spec**: `openspec/specs/core-engine/spec.md`

## MODIFIED Requirements

### Requirement: Review Pipeline Execution

The system MUST execute reviews through a layered pipeline: Layer 0 (static analysis), Layer 1 (memory retrieval), Layer 2 (AI agents), Layer 3 (memory persistence).

Additionally, during Layer 1 context assembly the pipeline MUST assemble a graph-neighborhood context section for the changed files — per changed file, its direct importers and importees plus key imported/exported symbols — whenever a dependency graph is loaded. The step follows the code-intel precedent: enabled by default when a graph is available, disableable through the pipeline settings object (`enableGraphContext`, with `graphContextMaxTokens` capping the formatted output). Rationale: every voice currently pays for broad, low-signal context; the already-built dependency graph localizes each change's true semantic surroundings at a bounded, reversible cost.

The step MUST fail closed: a missing graph (no published `ghagga/graph` branch, no local `.ghagga/graph.json`), a graph stale beyond the 7-day tolerance, an oversized graph (beyond `MAX_GRAPH_SIZE_BYTES`), a language with no symbol data, or any error during neighborhood assembly MUST degrade to a review without a neighborhood section — never a failed review and never an error surfaced to the caller. The raw truncated diff remains the control context and MUST NOT be replaced by neighborhood content.

(Previously: the requirement covered only the four layers with no graph-derived context.)

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

#### Scenario: Graph neighborhood assembled when a graph is loaded

- GIVEN a diff touching 3 files and a dependency graph loaded (published `ghagga/graph` branch or local `.ghagga/graph.json`) whose index is 2 days old (within the 7-day tolerance)
- WHEN the review pipeline executes with default settings
- THEN Layer 1 MUST assemble a neighborhood context section listing, per changed file, its direct importers and importees and key imported/exported symbols
- AND the section MUST be capped by `graphContextMaxTokens`
- AND Layer 2 agents MUST receive it through a dedicated context field, separate from stack hints and memory context

#### Scenario: Graph neighborhood skipped when the setting is disabled

- GIVEN a loaded, fresh graph and pipeline settings with `enableGraphContext: false`
- WHEN the review pipeline executes
- THEN no neighborhood context MUST be assembled and no neighborhood field MUST be set on the pipeline state
- AND the review MUST complete with the same result shape as before this change

#### Scenario: Fail-closed when the graph is missing

- GIVEN a repository with no published `ghagga/graph` branch and no local `.ghagga/graph.json`
- WHEN the review pipeline executes with default settings
- THEN the pipeline MUST skip neighborhood assembly without error
- AND the review MUST complete normally with no neighborhood context

#### Scenario: Fail-closed when the graph is stale beyond 7 days

- GIVEN a loaded graph whose index metadata is 9 days old (beyond the 7-day tolerance)
- WHEN the review pipeline executes with default settings
- THEN the neighborhood section MUST be omitted entirely
- AND the review MUST complete normally with no error surfaced to the caller

#### Scenario: Fail-closed when the graph is oversized

- GIVEN a published graph whose size exceeds `MAX_GRAPH_SIZE_BYTES` (20 MB), so the loader refuses it
- WHEN the review pipeline executes
- THEN the review MUST proceed without neighborhood context and MUST NOT fail

#### Scenario: Symbol-sparse extractors degrade to imports and exports

- GIVEN a changed Python file extracted by the regex extractor, which records no `importSymbols`
- WHEN the neighborhood section is formatted
- THEN that file's entry MUST list imports and exports only, omitting symbol detail
- AND formatting MUST NOT fail or emit placeholder symbol text

### Requirement: Token Budget Management

The system MUST manage token consumption to avoid exceeding model context limits. Token usage from `generateText()` is tracked via `result.usage.inputTokens` and `result.usage.outputTokens` (AI SDK v5 naming).

The graph-neighborhood context MUST carry its own dedicated budget configured by `graphContextMaxTokens`, following the `codeIntelMaxTokens` precedent. Rationale: neighborhood tokens are additive signal; without a dedicated cap they would silently erode the diff budget that finding quality depends on.

The neighborhood budget MUST NOT shrink the diff budget: the 70/30 context split and diff truncation MUST be computed exactly as they would be with the feature disabled. In multi-voice modes the cap MUST be enforced per voice at the prompt seam: each workflow specialist and each consensus stance receives a neighborhood section capped by `graphContextMaxTokens`, carved from the shared assembled neighborhood for that voice's file subset, and a voice with no neighborhood entries for its subset receives no section.

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

#### Scenario: Neighborhood output is capped by its dedicated budget

- GIVEN changed files whose full neighborhood rendering would consume 5,000 tokens and `graphContextMaxTokens` set to 1,500
- WHEN the neighborhood section is formatted
- THEN the output MUST NOT exceed 1,500 tokens
- AND truncation MUST prioritize files with the most changes (same priority rule as diff truncation)

#### Scenario: Neighborhood budget never shrinks the diff budget

- GIVEN the same diff and configuration reviewed twice — once with `enableGraphContext` on and a fresh graph, once with it off
- WHEN the 70/30 context split and diff truncation are computed
- THEN both runs MUST produce identical diff budgets and identical truncated diff content

#### Scenario: Per-voice cap in a five-specialist fan-out

- GIVEN a workflow review with 5 specialists, a loaded fresh graph, and neighborhood entries covering the changed files
- WHEN the 5 specialist prompts are built from their context subsets
- THEN each specialist's neighborhood section MUST NOT exceed `graphContextMaxTokens`
- AND a specialist whose subset contains no neighborhood entries MUST receive no neighborhood section
- AND consensus stances MUST be subject to the same per-voice cap
