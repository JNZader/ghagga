# Design: Review Output Compression

## Technical Approach

Approach A: ONE shared `OUTPUT_STYLE_CALIBRATION` constant appended to the system-prompt array of every PROSE voice, immediately after the existing calibration entry, behind `ReviewSettings.compressOutput` (default ON, explicit `false` = byte-identical prompts via the `.filter(Boolean)` contract). Refuter and contrarian voices get NOTHING — their output is already minimal and extra input tokens are net-negative. Same change wires `GenerateResult.outputTokens` into metadata for the three unmeasured voices.

## Architecture Decisions

| # | Decision | Choice and rationale (evidence) | Rejected alternative |
| --- | --- | --- | --- |
| 1 | Block shape: one shared string vs per-voice variants | ONE shared constant, appended at the same array slot as `REVIEW_CALIBRATION` for: simple (`simple.ts:206`), workflow specialists + synthesis (`workflow.ts:246,361`), consensus stances (`consensus.ts:287` — appended after whichever of REVIEW/COMPACT calibration the batch position uses), diagnostic (`diagnostic.ts:171`), fan-out lenses (`fan-out-lenses.ts:711`). The block's closing line defers to voice-specific caps, so it COMPOSES with the EXACT-format competizers: consensus length scaling (`prompts.ts:174-177,188-191,204-207`) and diagnostic hypothesis blocks (`prompts.ts:224-231`) keep labeled skeletons untouched — compression lives only in prose fields (MESSAGE/SUGGESTION/SUMMARY/REASONING/CONDITIONS/VERIFICATION). **Excluded: REFUTER (`fan-out-lenses.ts:490-498`, output is `<id>: stands\|refute` — nothing compressible) and CONTRARIAN (`:471-487`, SUMMARY already 1-2 sentences).** Appending ~120 input tokens to a voice whose entire output is ~60-160 tokens cannot pay for itself (see decision 6). | Per-voice variants (5+ constants to keep consistent; no evidence EXACT-block voices need different phrasing — the defer line handles it) |
| 2 | Flag surface | `ReviewSettings.compressOutput?: boolean` (`types.ts:217` area, beside `enableBlastRadius` :231). Semantics: `undefined`/`true` → ON, `false` → OFF (prompts byte-identical). Unlike graph-context there is NO environmental precondition (no graph to detect), so no auto-on resolver with probe order — just `resolveCompressOutputEnabled(options, fileConfig)`: `options.compressOutput === false` → false; else `fileConfig.compressOutput === false` → false; else true (precedence mirrors `resolveGraphContextEnabled`, `review.ts:1223-1228`, inverted because the default is ON). CLI flag `--no-compress-output` (boolean negation, same pattern as `--no-graph-context`, `review.ts:145`); `.ghagga.json` `compressOutput` for config-file control. `execute.ts` resolves once — `compressOutput: input.settings.compressOutput !== false` — and passes an explicit boolean per runner (same threading as `reviewLevel`, `execute.ts:202,220,242,262,284`); runners append `compressOutput ? OUTPUT_STYLE_CALIBRATION : ''`. | Opt-in default-off (contradicts proposal's default-ON scope decision and the graph-context precedent); resolver probing repo state (nothing to probe) |
| 3 | Fixture shape | Reuse the graph-context corpus `diff.patch` files (`packages/core/test/fixtures/graph-context/{fresh-exact-multi-file,not-exact-fresh,symbol-sparse-python}/diff.patch`) — the diff only provides realism; the ASSET is authored response pairs. New dir `packages/core/test/fixtures/output-compression/<case>/` with `verbose.txt` + `compressed.txt` (same findings, two styles) + `expected-findings.json`. Pinned per parser: `parseFindingsBlock` (`simple.ts:141`, reused by fan-out `fan-out-lenses.ts:40` and workflow synthesis), consensus `parseDecision/REASONING` (`consensus.ts:122,131`), refuter `parseRefuterVerdicts` (`fan-out-lenses.ts:505-512` — pair proves the terse format itself needs no calibration). Assert: both styles parse to IDENTICAL findings/verdicts. | Fresh detection corpus with ground-truth bugs (detection grading is the out-of-band model run's job; CI can only prove parser parity — fresh bugs buy nothing model-free) |
| 4 | A/B protocol | Provider: **CLI-bridge** (`cli-bridge.ts:281-309` already parses input/output split; ollama `ollama.ts:32` reports usage but is not the review-quality surface). Gateway blind spot ACCEPTABLE and documented — gateway reports `tokensUsed` total only (`gateway.ts:71`). Protocol: simple mode on `fresh-exact-multi-file/diff.patch`, one model from the user's review chain (codex-cli family), `compressOutput: false` run then default-ON run, record `metadata.outputTokensUsed` + findings count + findings diff. Gate: ≥30% output reduction, 0 findings lost. Documented run lives in `openspec/changes/review-output-compression/ab-run.md` (model, date, per-run tokens, findings delta). | Ollama-local A/B (measured but not representative); gateway first (out of scope per proposal) |
| 5 | Summary cap | UNCHANGED. `sanitizeMarkdownText(summary, 2000)` (`format.ts:717`) stays. Comment bytes are out of scope (proposal: "rendered comment bytes unchanged for identical findings" is a success criterion); `sanitizeMarkdownText` already passes `*` and `\|` through (`sanitize.ts:44-84`) so bold survives and tables in SUMMARY die at `sanitizeTableCell` (`sanitize.ts:93-98`) — the style block therefore says bold, NOT tables, in SUMMARY. Tightening the cap would be a comment-formatting change under a token-change flag. | Tighten to e.g. 1200 (changes rendered bytes for long summaries; different capability's spec) |
| 6 | Input-token overhead / break-even | Block ≈ **110-140 input tokens**/voice. At the typical 1:4 input:output price ratio on major providers, 120 input tokens cost ≈ 30 output tokens. Break-even reduction = 30 / baseline-output. Simple/workflow/consensus voices emit ~600-1,500 output tokens (multi-finding prose) → break-even at **2-5%**; the 30-40% target on a 1,000-token voice saves 300-400 output tokens (≈1,200-1,600 input-equivalents) for 120 spent → **~10x net positive**, and multi-voice modes multiply both sides per-voice so the ratio holds. The margin is WHY refuter/contrarian are excluded: refuter emits ~6-8 tokens/verdict × 5-20 candidates ≈ 50-160 output tokens; 40% of 100 = 40 output tokens ≈ 160 input-equivalents — at or below the 120-token block cost, with added directive-dilution risk on a one-line-per-verdict format. | Apply to all voices uniformly (net-negative on the two terse voices) |

## The Calibration Block (contract)

```text
## Output Style Calibration
- Keep every labeled block and field name EXACTLY as specified; compress only the prose inside fields.
- MESSAGE: one line — the defect and its trigger condition. No context restatement.
- SUGGESTION: one line — the fix. Do not restate the problem.
- SUMMARY: lead with the verdict; bold the key terms (**term**); no filler phrases.
- Prefer file:line references over describing the location in prose.
- Where this voice specifies a length cap ("2-3 sentences max"), that cap wins; compress within it.
```

No tables anywhere: `sanitizeTableCell` escapes pipes/newlines (`sanitize.ts:93-98`), so a markdown table in MESSAGE/SUGGESTION would render as escaped garbage inside the findings table.

## Settings Surface

| Field (ReviewSettings) | Type | Default | Meaning |
| --- | --- | --- | --- |
| `compressOutput` | `boolean?` | `undefined` = ON | `false` removes the block from every prose voice; prompts byte-identical |

No settings-spec delta (precedent: `enableGraphContext`, `types.ts:293`, carries none).

## File Changes

| Files | Action |
| --- | --- |
| `packages/core/src/agents/prompts.ts` | `OUTPUT_STYLE_CALIBRATION` constant (after `REVIEW_CALIBRATION`, :274-279) |
| `packages/core/src/agents/{simple,workflow,consensus,diagnostic,fan-out-lenses}.ts` | Accept `compressOutput` boolean; append block after calibration entry (`simple.ts:206`, `workflow.ts:246,361`, `consensus.ts:287`, `diagnostic.ts:171`, `fan-out-lenses.ts:711`); NOT in REFUTER_SYSTEM/CONTRARIAN_SYSTEM call sites |
| `packages/core/src/pipeline/execute.ts` | Resolve `compressOutput !== false`, thread to runners (reviewLevel pattern, :202-300) |
| `apps/cli/src/commands/review.ts` | `--no-compress-output` option, `resolveCompressOutputEnabled` (graph-context precedence pattern, :1214-1228), `.ghagga.json` `compressOutput` |
| `packages/core/src/agents/{simple,diagnostic,fan-out-lenses}.ts` (measurement) | Propagate `result.outputTokens` → `outputTokensUsed` metadata (workflow `workflow.ts:391-392,416-417` and consensus `consensus.ts:391` already aggregate) |
| `packages/core/test/fixtures/output-compression/*` | Parser-parity pairs (decision 3) |
| `packages/core/src/agents/prompts.test.ts`, `__snapshots__/pipeline-golden.test.ts.snap` | On-state snapshots authored; off-state (`compressOutput: false`) byte-identical asserts |
| `openspec/changes/review-output-compression/ab-run.md` | Documented out-of-band A/B run |
| Spec deltas | `review-prompts` (new output-style requirement); `core-engine` (output-token measurement); `review-formatting` UNTOUCHED |

## Slices: Size and Risk

| Slice | Lines | Risk | Notes |
| --- | --- | --- | --- |
| 1. Style block + flag + goldens | 150-250 | Medium | On-state golden churn across all prompt suites in one event; off-state byte-identity is the contract |
| 2. Measurement wiring | 80-150 | Low | Additive metadata; provider-matrix tested (gateway = undefined) |
| 3. Parser-parity corpus + A/B doc | 150-250 | Low | Model-free CI; A/B is out-of-band, gated before default-on claim stands |

## Testing Strategy

- **Slice 1**: per prompt site — on-snapshot contains the block exactly once at pinned position; `compressOutput: false` produces byte-identical output to pre-change goldens; refuter/contrarian prompts NEVER contain the block (explicit negative assert); CLI precedence tests (flag beats config beats default-ON, mirroring `review-graph-context.test.ts:62-73`).
- **Slice 2**: provider unit tests — simple/diagnostic/fan-out set `outputTokensUsed` when split reported, omit when gateway; cost-footer renders measured split (`cost-footer.ts:145-153`).
- **Slice 3**: every `output-compression` fixture case runs BOTH styles through each applicable parser → identical findings/verdicts; zero-findings drift fails loudly in CI (authored pairs, so any parse asymmetry is a real bug).
- **A/B**: not CI. Executed once out-of-band per decision 4; results recorded in `ab-run.md`; success criteria checked against proposal metrics before the default-ON claim is treated as verified.

## Migration / Rollout

Slices 1-2 land together (independent, both additive); slice 3 fixtures land with slice 1, A/B run executes after slice 2 merges. Rollback: `--no-compress-output` or `.ghagga.json` `compressOutput: false` — every prompt returns byte-identical; measurement metadata is harmless when unused.

## Open Questions

None.
