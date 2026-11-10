# Review Formatting Delta

> **Change**: `blast-radius-diagram`
> **Base spec**: `openspec/specs/review-formatting/spec.md`

## ADDED Requirements

### Requirement: R7: Blast-Radius Diagram Section

`formatReviewComment` MUST render an additive `### Blast Radius` section containing a fenced ` ```mermaid ` block when the review result carries blast-radius diagram data (`result.metadata.blastRadius` includes a capped node/edge list). Rationale: blast radius is computed and paid for on every graph-backed review, but the comment currently renders no picture of why the review was narrowed — a sanitized, deterministic diagram gives reviewers that picture on both forges (GitHub and GitLab render mermaid natively) with zero adapter changes.

The section MUST be data-presence-gated exactly like `formatSemanticDiffSection` (`format.ts:496-499` precedent): when the result carries no diagram data, the section MUST contribute zero bytes and the comment MUST be byte-identical to the output of the same function before this change. This gate applies identically to all three consumers (server queue, CLI, action) because they share the single `formatReviewComment` implementation (R1).

The renderer MUST treat file names as untrusted input (they come from the attacker-controlled PR head) and satisfy this sanitization contract:

- Node ids MUST be purely numeric-generated (`n0`, `n1`, …) — never derived from file paths.
- Labels MUST be emitted inside double quotes, with any `"` in the file name removed or replaced.
- Raw `-->` sequences, HTML tags/entities, and newline characters MUST NOT reach the mermaid output from a file name; a multi-line or HTML-carrying file name MUST be rendered as a single-line, allowlist-sanitized label.
- Node and edge lists MUST be explicitly sorted and ids assigned deterministically, so identical inputs produce byte-identical mermaid across runs (no `Set` iteration order in output).

Legend honesty MUST be preserved inside the section: when the metadata records `graphStale`, the section MUST display a stale-graph note; when it records `exceededCap`, the section MUST display a truncation note; when the node list was truncated by the render cap, the section MUST display a "+N more" indicator naming the count of omitted nodes. No honest-status flag present in the metadata MAY be silently dropped from the rendered section.

#### Scenario: S7: Diagram section rendered when data is present

- GIVEN a `ReviewResult` whose `metadata.blastRadius` carries a capped node/edge list (3 changed files, 2 dependents, 4 edges, no flags)
- WHEN `formatReviewComment(result)` is called
- THEN the output MUST contain an `### Blast Radius` heading
- AND the section MUST contain exactly one fenced ` ```mermaid ` block whose body declares the 5 nodes and 4 edges with numeric ids (`n0`…`n4`) and double-quoted labels
- AND the section MUST NOT appear more than once

#### Scenario: S8: Byte-identical comment when diagram data is absent

- GIVEN the exact same `ReviewResult` used in the R2/S1 golden tests, whose `metadata.blastRadius` carries counts only (no node/edge list)
- WHEN `formatReviewComment(result)` is called
- THEN the output MUST NOT contain the string `### Blast Radius` nor any ` ```mermaid ` fence
- AND the output MUST be byte-identical to the pre-change function output for that input (zero bytes contributed)

#### Scenario: S9: Injection vectors in file names are neutralized

- GIVEN a `ReviewResult` whose diagram nodes include file names `evil"label.ts`, `a-->b.ts`, `<img src=x>.ts`, and `head\ner.ts` (embedded newline)
- WHEN `formatReviewComment(result)` is called
- THEN every rendered label MUST be a single line inside double quotes
- AND no label MAY contain a raw `"`, a `-->` sequence, an HTML tag or entity, or a newline character
- AND the mermaid block MUST remain syntactically renderable (no injected edges, no broken fences, no header injection via `#` on a new line)

#### Scenario: S10: Capped truncation shows "+N more"

- GIVEN a `ReviewResult` whose diagram data was capped at the render node limit (25) out of 40 eligible nodes, with directory clustering applied
- WHEN `formatReviewComment(result)` is called
- THEN the mermaid block MUST declare at most 25 nodes
- AND the section MUST display a `+15 more` indicator (the exact omitted count)
- AND the truncated nodes' file names MUST NOT appear in the section

#### Scenario: S11: Stale graph and exceeded cap render in the legend

- GIVEN a `ReviewResult` whose `metadata.blastRadius` records `graphStale: true` and `exceededCap: true` alongside a node/edge list
- WHEN `formatReviewComment(result)` is called
- THEN the section MUST contain a legend note stating the graph is stale (per the existing 7-day rule)
- AND the section MUST contain a legend note stating the blast radius exceeded the cap
- AND neither flag MAY be dropped from the rendered output
