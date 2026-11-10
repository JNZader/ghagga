# Review Formatting Delta

> **Change**: `nightly-health-digest`
> **Base spec**: `openspec/specs/review-formatting/spec.md`
>
> **Merge seam**: the base spec covers `formatReviewComment` only; this delta adds a
> sibling pure formatter. No open change touches this capability.

## ADDED Requirements

### Requirement: Digest Issue Format

A `formatDigestIssue` pure function MUST render the nightly digest issue body from health-module outputs (aggregation-window severity counts, trend, per-file risk ranking) as GitHub-flavored markdown. Rationale: the digest is updated in place nightly, so the body needs a machine-recognizable marker header for lookup and deterministic content so updates are diffable and testable offline.

The body MUST satisfy:

- **Marker header**: the body MUST start with a stable, machine-recognizable digest marker header (the same convention that identifies digest issues for update-in-place).
- **Summary counts**: the body MUST include per-severity finding counts for the aggregation window.
- **Trend**: the body MUST include a trend line comparing against the previous digest when one exists, and MUST omit it cleanly on the first digest.
- **Ranked files**: the body MUST list the top-ranked riskiest files with their risk scores, in ranking order.
- **Determinism**: identical inputs MUST produce byte-identical output; the function MUST NOT throw for empty ranked lists or absent trend data, and MUST perform no I/O.

#### Scenario: Marker header and deterministic output

- GIVEN two identical digest inputs (window counts, trend, ranked files)
- WHEN `formatDigestIssue` renders both
- THEN both bodies MUST start with the digest marker header
- AND the two outputs MUST be byte-identical
- AND the output MUST be valid GitHub-flavored markdown with no I/O side effects

#### Scenario: Ranked files and summary counts rendered

- GIVEN a digest input with window counts { critical: 1, high: 4, medium: 9 } and ranked files [`src/auth.ts` (score 87), `src/db.ts` (score 41)]
- WHEN `formatDigestIssue` renders the body
- THEN the body MUST show the per-severity counts for the window
- AND the ranked files MUST appear in ranking order with their scores
- AND the highest-ranked file MUST appear first

#### Scenario: Trend line present on update, absent on first digest

- GIVEN one digest input with a previous-digest score of 72 and a current score of 65, and one first-run input with no previous digest
- WHEN both bodies are rendered
- THEN the update body MUST contain a trend line reflecting the delta (-7, worsening)
- AND the first-run body MUST NOT contain a trend line and MUST NOT throw
