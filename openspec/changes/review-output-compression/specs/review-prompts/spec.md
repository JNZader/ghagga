# Review Prompts Delta

> **Change**: `review-output-compression`
> **Base spec**: `openspec/specs/review-prompts/spec.md`

## ADDED Requirements

### Requirement: Output Style Calibration

The system MUST append an `OUTPUT_STYLE_CALIBRATION` appendix to the system prompt of every compression-eligible review voice — the simple agent, each workflow specialist and the workflow synthesis call, each consensus stance, the diagnostic agent, and each fan-out lens — gated by a `ReviewSettings` flag (`compressOutput` — apply amendment: design decision 2 wins over this delta's draft name `enableOutputStyleCalibration`) that MUST default to enabled. The appendix MUST direct the model to: **bold** the key terms, keep each MESSAGE to at most one line, render multi-option comparisons compactly, and use zero filler prose. Rationale: the refuter voice already proves maximally terse output parses reliably; these directives target ~30-40% fewer output tokens, the expensive side of every review call.

Compression MUST be confined to the prose fields — MESSAGE, SUGGESTION, SUMMARY, and REASONING. The labeled-block skeleton instructions (STATUS/SUMMARY/FINDINGS blocks and the strict finding-field layout) MUST remain unchanged when the flag is on; the appendix is purely additive, so every regex parser (`parseReviewResponse`, `parseFindingsBlock`, the consensus DECISION/REASONING parsers, and the refuter verdict parser) keeps its contract untouched.

When the flag is disabled, the appendix MUST be entirely absent and every prompt MUST be byte-identical to the pre-change baseline, riding the same `.filter(Boolean)` prompt-assembly contract as `REVIEW_CALIBRATION` and the graph-neighborhood section. Rollback MUST require only a setting change, no code change.

The refuter and contrarian voices MUST be excluded from calibration in both flag states: their outputs are already maximally terse (single-line verdicts and 1-2 sentence summaries) and offer no compression headroom.

#### Scenario: Flag on compresses prose fields and leaves the skeleton intact

- GIVEN a review with `compressOutput` enabled
- WHEN the system prompt is assembled for any eligible voice (simple agent, workflow specialist or synthesis, consensus stance, diagnostic agent, or fan-out lens)
- THEN the prompt MUST contain an `OUTPUT_STYLE_CALIBRATION` appendix directing: bold key terms, MESSAGE at most one line, compact comparisons, zero filler
- AND the appendix MUST confine its directives to the prose fields (MESSAGE, SUGGESTION, SUMMARY, REASONING)
- AND the labeled-block skeleton instructions MUST be unchanged relative to the flag-off prompt (the appendix is purely additive)
- AND a model response written in the compressed style MUST still parse through `parseReviewResponse` and `parseFindingsBlock` without any parser change

#### Scenario: Prompts are byte-identical when the flag is off

- GIVEN the same review inputs with `compressOutput: false`
- WHEN prompts are built for every voice across simple, workflow, consensus, diagnostic, and fan-out modes
- THEN the prompts MUST be byte-identical to the pre-change baseline
- AND no `OUTPUT_STYLE_CALIBRATION` text MUST appear in any prompt
- AND the existing golden prompt suites MUST pass unchanged

#### Scenario: Refuter and contrarian are excluded

- GIVEN a fan-out review with lens, contrarian, and refuter phases, with the flag enabled
- WHEN the contrarian and refuter system prompts are assembled
- THEN the `OUTPUT_STYLE_CALIBRATION` appendix MUST NOT appear in either prompt
- AND the contrarian's existing 1-2 sentence SUMMARY cap and the refuter's single-line verdict format MUST remain untouched

#### Scenario: Fan-out lens voices are included

- GIVEN a fan-out review with 3 lenses and `compressOutput` enabled
- WHEN each lens system prompt is assembled
- THEN each lens prompt MUST contain the `OUTPUT_STYLE_CALIBRATION` appendix
- AND each lens's embedded labeled-block skeleton MUST remain byte-identical, so `parseFindingsBlock` still parses lens output under the compressed style
