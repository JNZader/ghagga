# Review Ledger — review-output-compression

Full-4R review (diff >400 lines: +2038/−8) of `feat/review-output-compression`, 2026-11-10. Four lenses, one exhaustive sweep each. Zero BLOCKER/CRITICAL candidates → no refutation batch. Fix round 1 of max 2: 6 findings (5 WARNING + 1 SUGGESTION) → scoped re-review **6/6 RESOLVED, zero new BLOCKER/CRITICAL**.

## Fixed (round 1, commit e102a1e)

| ID | Lens | Severity | Resolution |
|---|---|---|---|
| RES-001 | resilience | WARNING | `?? 0` on one-sided splits wrote a MEASURED ZERO for the missing side, zeroing the ~5x-priced output cost in the footer. All 5 aggregation sites (simple, diagnostic, fan-out ×3) now write/sum each side only when the provider reported it. Regression: one-sided-split partial-state test. |
| RES-002 | resilience | WARNING | Mixed-providerChain fan-out (gateway + cli-bridge): gateway voices' `?? 0` contributed to "measured" sums that visibly contradicted `tokensUsed`. Gateway voices now contribute nothing. |
| RES-003 | resilience | WARNING | `.ghagga.json` `compressOutput: "false"` (string) / `null` / `0` silently degraded to ON. Now hard-exits like `pinLensesToFirst` (review.ts:1120); caught by the command's try → tui.error + exit 1. |
| REL-001 | reliability | WARNING | The T2.4 gap-voices insertion DELETED the `demotes ## to ###` regression test (the exact PR #479 defect) in a collateral hunk. Restored from main. |
| REL-002 | reliability | WARNING | Corpus had zero fixture for `parseHypotheses` (diagnostic) or `parseReviewResponse` STATUS/SUMMARY (simple + workflow synthesis input). 2 new fixture pairs (diagnostic-hypotheses, status-summary), corpus 17→24 tests. Parser subtleties discovered: `**high**` in CONFIDENCE silently downgrades to `medium` (kept plain); the SUMMARY regex absorbs hypothesis blocks (pre-existing, symmetric both styles). |
| REA-001 | readability | SUGGESTION | Dead `_mode` loop in the cost-footer gap-voices test falsely implied mode-scoped coverage. Removed + one-sided-split partial-state regression added. |

## Info (never blocking)

- R2-N01 (re-review note): fan-out metadata spread writes BOTH sums when `splitReported` — an output-only split would still publish `inputTokensUsed: 0` as measured. No known provider reports output-only; residual RES-001 shape at the spread site.
- R2-N02 (re-review note): neighborhood-format.ts:90 `continue`→`break` — this is the deliberate demo-PR #479 plant (break is the CORRECT behavior: stop filling at first overflow); the "advisory" note in the re-review is the exact semantic the demo review itself debated.

## Verified clean (per lens)

- **Risk**: LEDGER empty — block text regex-scanned (zero pipes/backticks/HTML); flag matrix verified all paths (CLI false beats config true; undefined→true everywhere including server/action); refuter+contrarian excluded in both states (the only compositions, no third path); fan-out splitReported+?? 0 NaN impossible; ~720 worst-case workflow input tokens = documented design tradeoff (break-even in-code at prompts.ts:281-300).
- **Reliability**: byte-identity PROVEN (the `.filter(Boolean)` trailing-`''` drop is separator-neutral; `on === off + '\n' + BLOCK` tests in all 5 modes + `preChangeBaseline` in 3); default-ON invisible to pipeline goldens (agents mocked) — new ON-state snapshot equals unchanged baseline, no hidden churn; outputTokens per-call (not summed, not tokensUsed) for simple/diagnostic; fan-out sums 3+1+2=6 calls with count assertions; corpus deterministic (sorted readdir, no clock).
- **Resilience**: gateway undefined→field omitted; opencode last-step-wins undercount aggregated once (not multiplied); model ignoring the block = no savings, no break; corpus pin is harness-level single commented site.
- **Readability**: break-even math in-code; `enableOutputStyleCalibration` survives only as amendment/history; split aggregation triplication mirrors pre-existing totalTokens at same sites (refactor = taste); corpus cases descriptively named; ab-run.md stranger-executable (provider, fixture path, formula, gates, rollback); all exports consumed.
