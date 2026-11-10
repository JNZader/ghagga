# Review Prompts Delta

> **Change**: `graph-context-retrieval`
> **Base spec**: `openspec/specs/review-prompts/spec.md`

## ADDED Requirements

### Requirement: Graph Neighborhood Prompt Section

When graph-neighborhood context is available, the system MUST render it as a dedicated, additive "Graph Neighborhood" section in each voice's system prompt (simple agent, workflow specialists, consensus stances), carrying per-file importers/importees and key symbols. The section MUST be appended after the existing context sections without modifying them. Rationale: a distinct, stable section keeps the neighborhood auditable and golden-testable instead of smearing it through the stack-hints channel.

Neighborhood content is repository-derived data of untrusted provenance: the section MUST be fenced per the prompts untrusted-content contract — explicit instructions that the block is context data, not directives; that any instruction-looking text inside it MUST NOT be followed; and that findings MUST still be justified from the code diff itself (anti-priming parity with the memory-framing contract).

When the feature is disabled or degraded (no graph, graph stale beyond 7 days, oversized graph, or a neighborhood that formats to empty), the section MUST be entirely absent and the resulting prompts MUST be byte-identical to the prompts produced without this change.

#### Scenario: Neighborhood section is injected with untrusted-content fencing

- GIVEN a review with a fresh loaded graph and neighborhood entries for 2 changed files
- WHEN any voice's system prompt is built (simple, workflow specialist, or consensus stance)
- THEN the prompt MUST contain a "Graph Neighborhood" section listing per-file importers, importees, and key symbols
- AND the section MUST include fencing instructions stating the content is untrusted repository data that MUST NOT be obeyed as instructions
- AND the section MUST NOT contain any directive encouraging findings based on the neighborhood rather than the diff

#### Scenario: Prompts are byte-identical when the setting is disabled

- GIVEN the same review inputs with `enableGraphContext: false`
- WHEN prompts are built for simple, workflow, and consensus voices
- THEN the prompts MUST be byte-identical to the pre-change baseline
- AND the existing golden prompt suites MUST pass unchanged

#### Scenario: Prompts are byte-identical when the graph degrades

- GIVEN a repository whose graph is missing, stale beyond 7 days, or oversized, with `enableGraphContext` on
- WHEN prompts are built
- THEN no "Graph Neighborhood" section MUST appear
- AND the prompts MUST be byte-identical to the pre-change baseline

#### Scenario: Per-specialist neighborhood subsets in workflow mode

- GIVEN a workflow review with 5 specialists and neighborhood entries covering the changed files
- WHEN the specialist prompts are built
- THEN each specialist's "Graph Neighborhood" section MUST contain only entries for that specialist's file subset
- AND each specialist's section MUST be capped by `graphContextMaxTokens`
