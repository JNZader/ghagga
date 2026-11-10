# Proposal: Review Output Compression

## Intent

Output tokens are the expensive side of every review call — completion tokens are priced above prompt tokens on the major providers — and multi-voice modes multiply the bill: workflow makes six specialist calls, consensus three stances, fan-out three-plus lenses and refuters. Every voice's output is verbose by instruction: 2-3 sentence summaries, multi-line MESSAGE/SUGGESTION prose, hypothesis blocks. No prompt today asks for compressed output style, even though the refuter already proves maximally terse output parses reliably. This change appends an Attention-Span-style output calibration (bold key terms, single-line messages, compact comparisons, zero filler) to every voice, targeting ~30-40% fewer output tokens with no findings lost — and closes the measurement gap so the savings are visible in the cost-footer split.

## Scope Decision

**Approach A, default ON.** A flag-gated `OUTPUT_STYLE_CALIBRATION` block appended per voice — riding the same `.filter(Boolean)` prompt-assembly contract as `REVIEW_CALIBRATION` and graph-neighborhood sections — is reversible, keeps prompt goldens byte-stable when off, and leaves every regex parser untouched: the labeled-block skeleton (STATUS/SUMMARY/FINDINGS) stays as-is and compression is confined to the prose inside MESSAGE, SUGGESTION, SUMMARY, and REASONING. Default ON follows the graph-context precedent: a prompt appendix behind a flag with zero parser risk ships enabled; rollback is a setting. Approach B (single-line findings redesign) rewrites `parseFindingsBlock`, every prompt, and every golden, and its regex has no error path — malformed rows silently drop findings. Approach C (formatter-only) saves zero output tokens, only comment bytes. The measurement gap (simple/diagnostic/fan-out record no output-token split) is closed in scope so the success metric is evaluable at all.

## Scope

### In Scope

- `OUTPUT_STYLE_CALIBRATION` block in `prompts.ts` and the fan-out lens/contrarian systems, behind a `ReviewSettings` flag (precedent: `enableGraphContext`).
- Compression confined to prose fields (MESSAGE/SUGGESTION/SUMMARY/REASONING); labeled-block skeleton byte-identical.
- `GenerateResult.outputTokens` wired into `metadata.outputTokensUsed` for simple, diagnostic, and fan-out (workflow/consensus already aggregate).
- Parser-parity corpus: authored compressed/verbose response pairs must parse to identical findings; prompt-byte goldens on and off.
- One documented out-of-band A/B model run for true detection-rate (same scoping as graph-context-retrieval).

### Out of Scope

- Approach B output-format redesign; formatter-only compression (Approach C).
- Gateway token-split reporting (gateway reports no split; the A/B run uses providers that do).
- Model routing and input-side compression (`compress/` already owns that).

## Capabilities

### Modified Capabilities

- `review-prompts`: new output-style requirement — flag-gated calibration appendix, prose-field compression, byte-stable prompts when disabled.
- `core-engine`: output-token measurement for the three gap voices (delta to Token Budget Management / review metadata).

No `review-formatting` delta: rendered comment bytes stay unchanged for identical findings.

## Approach

Slices land in dependency order, each independently testable:

1. **Style block + flag** — `OUTPUT_STYLE_CALIBRATION` appendix at every voice prompt site; golden suites extended with on-state snapshots; off-state stays byte-identical.
2. **Measurement wiring** — propagate `outputTokens` for simple/diagnostic/fan-out into `outputTokensUsed`; rides the persistence graph-context already shipped (server `review.ts`, db `schema.ts`) — no schema change.
3. **Parser-parity corpus + A/B protocol** — compressed/verbose fixture pairs pinned against `parseFindingsBlock`/consensus/refuter parsers; the documented out-of-band run (needs slice 2's split on a reporting provider) records reduction % and findings delta.

Slices 1 and 2 are independent; slice 3's A/B evaluation depends on slice 2.

## Affected Areas

| Area                            | Impact   | Description                                                                                          |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `packages/core`                 | Modified | Style block + flag (prompts, fan-out lenses), outputTokens wiring (simple/diagnostic/fan-out), corpus |
| `openspec/specs/review-prompts` | Modified | New output-style requirement                                                                         |

Rough size: 300-500 authored lines across the three slices.

## Risks

| Risk                                            | Mitigation                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Findings lost under terser style (model omission) | Parser-parity proves format survival in CI; true detection-rate gated on the documented out-of-band run (0 findings lost) before default-on stands |
| Silent zero-findings parse on drift (no error path) | Corpus pins compressed-style responses against the strict 6-field regex per parser                                                          |
| Directive dilution vs EXACT-format blocks       | Per-voice phrasing decided in design; refuter/contrarian already terse and may be excluded                                                     |
| Multi-voice golden churn when on                | One flag flip; on-state goldens authored per prompt site                                                                                      |
| Gateway reports no token split                  | A/B protocol scoped to AI-SDK/CLI-bridge providers; gateway rides `tokensUsed` total (documented)                                             |

## Rollback Plan

Flip the flag off: prompt arrays return byte-identical (`.filter(Boolean)` contract, `prompts.ts:651`); on-state goldens remain as fixtures; measurement wiring is additive metadata, harmless when a provider reports no split.

## Dependencies

- `GenerateResult.outputTokens` (AI-SDK path only, `generate-fn.ts:32`); `REVIEW_CALIBRATION` append precedent (`prompts.ts:274`); corpus-harness pattern (`graph-context-corpus.test.ts`); token-split persistence already shipped (server `review.ts:964-968`, db `schema.ts:179-180`). No new libraries.

## Success Criteria

- [ ] Golden prompt suites byte-identical when the flag is off.
- [ ] Parser-parity corpus green: compressed and verbose response pairs parse to identical findings across all parsers.
- [ ] simple/diagnostic/fan-out metadata carry `outputTokensUsed` when the provider reports a split; the cost-footer shows it.
- [ ] A/B protocol documented and executed once out-of-band: ~30-40% output-token reduction, 0 findings lost, results recorded in the change docs.
- [ ] Rendered comment bytes unchanged for identical findings.

## Open Design Questions

1. One shared `OUTPUT_STYLE_CALIBRATION` block or per-voice phrasings where EXACT-format labeled blocks compete (consensus stances, diagnostic hypotheses)?
2. Fixtures: reuse graph-context corpus `diff.patch` files with authored response pairs, or a fresh detection corpus with ground-truth bugs?
3. A/B provider surface: CLI-bridge/AI-SDK only (split-reporting) — is the gateway blind spot acceptable for the documented run?
4. All prompt sites in slice 1 at once, or staged (simple + workflow synthesis + consensus REASONING first)?
5. Does the 2000-char summary cap tighten alongside the token target, or stay put since comment bytes are out of scope?
