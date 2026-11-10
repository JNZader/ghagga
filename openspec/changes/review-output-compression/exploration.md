# Exploration: Review Output Compression (Attention-Span-inspired)

## Exploration Scope

Compressing the AI reviewer's OUTPUT style (bold key terms, short paragraphs, tables for comparisons, zero filler) across all review voices, targeting ~40% fewer output tokens, with detection-rate (no findings lost) measured by an eval. Input-side compression (existing `packages/core/src/compress/`), model routing, and pricing changes are out of scope. Read-only exploration; no tests or model runs executed.

## Current State

- **Format instructions per voice** (`packages/core/src/agents/prompts.ts`): SIMPLE_REVIEW_SYSTEM mandates `STATUS/SUMMARY: [2-3 sentence]/FINDINGS:` labeled blocks (`prompts.ts:42-57`); WORKFLOW specialists use free bullet formats (`:65-143`); WORKFLOW_SYNTHESIS reuses the findings block (`:153-166`); CONSENSUS stances already carry length scaling ("2-3 sentences max") and "be brief and direct" (`:170-212`); DIAGNOSTIC adds hypothesis blocks (`:216-261`); COMPACT_CALIBRATION says "Be concise" for non-primary calls (`:270`). Fan-out lenses each embed the same findings block (`agents/fan-out-lenses.ts:72-230`); CONTRARIAN caps SUMMARY at 1-2 sentences (`:471-488`); REFUTER is already maximally terse (`<id>: stands|refute`, `:490-499`). No prompt anywhere asks for bold/tables/zero-filler today.
- **Parsing is regex over labeled text, not JSON or markdown**: `parseReviewResponse` (STATUS `simple.ts:82`, SUMMARY single-block `:89-98`) and `parseFindingsBlock` — a strict 6-field regex (`simple.ts:141`) reused by fan-out (`fan-out-lenses.ts:40`) and workflow synthesis. Consensus parses DECISION/REASONING (`consensus.ts:122,131`); refuter verdicts (`fan-out-lenses.ts:501-512`). Malformed findings silently yield zero rows.
- **Comment rendering**: Summary injection at `format.ts:717` (`sanitizeMarkdownText(summary, 2000)` + `demoteMarkdownHeadings`). `sanitizeMarkdownText` (`sanitize.ts:44-84`) does NOT touch `*` or `|` — bold and tables in the summary survive; `sanitizeTableCell` (`sanitize.ts:93-98`) escapes pipes/newlines, so bold survives inside finding-table cells but tables cannot. Top-10 visible / 40-in-details caps just shipped (comment-format-signal Fix 1, `format.ts:139-141`).
- **Token measurement**: `GenerateResult.outputTokens` exists (`providers/generate-fn.ts:26-33`, AI SDK v5 usage; gateway reports no split). Metadata carries `outputTokensUsed` (`types.ts:580-583`), but only workflow (`workflow.ts:391-392,416-417`) and consensus (`consensus.ts:391`) aggregate it. **simple, diagnostic, and fan-out record `tokensUsed` total only** (`simple.ts:117`, `diagnostic.ts:227`, `fan-out-lenses.ts:1006`). Cost footer renders three honest split states (`cost-footer.ts:145-153`).
- **Eval infrastructure**: `graph-context-corpus.test.ts` — 6 model-free fixtures (`test/fixtures/graph-context/*/` with `case.json`, `diff.patch`, golden `expected-context.json`, `expected-prompt-{off,on}.txt`), fake `GenerateTextFn` captures system bytes (`:126-150`), regen via env var, and explicitly does NOT assert findings quality ("rides golden prompt determinism plus documented out-of-band model run", `:17-18`). `pipeline-golden.test.ts` freezes pipeline behavior; `compress/index.ts` sets the input-side precedent with `reductionPercent`.

## Affected Areas

- `packages/core/src/agents/prompts.ts` — style directives per voice (simple, workflow specialists + synthesis, consensus stances, diagnostic).
- `packages/core/src/agents/fan-out-lenses.ts` — lens systems, CONTRARIAN_SYSTEM.
- `packages/core/src/agents/{simple,workflow,consensus,diagnostic}.ts` — propagate measured `outputTokens` into metadata (measurement gap).
- `packages/core/src/graph-context-corpus.test.ts` + `test/fixtures/graph-context/` (or sibling corpus) — prompt-byte goldens on/off + parser-level detection asserts.
- `packages/core/src/{format,sanitize}.ts` — verify bold/tables survive; likely no change.
- `openspec/specs/review-prompts/spec.md` — new output-style requirement (deltas land here); `openspec/specs/review-formatting/spec.md` — only if comment bytes change (they should not).

## Approaches

| Approach | Pros | Cons | Effort |
|---|---|---|---|
| **A. Style directives inside the existing format skeleton** (flag-gated appendix per voice: bold key terms, ≤1-line MESSAGE, tables for comparisons, no filler; labeled blocks untouched) | Parser untouched; prompt goldens byte-stable when off (`.filter(Boolean)` contract); reversible; multiplies across workflow (6 calls), consensus (3), fan-out (3+2) — and compressed specialist output also shrinks synthesis INPUT | Directive adherence is model-dependent; true detection-rate needs out-of-band model runs | Low-medium |
| **B. Terser output format redesign** (e.g. single-line findings `SEV|CAT|FILE:LINE|MSG|FIX`) | Deterministic savings per finding | Rewrites `parseFindingsBlock` + every prompt + all goldens; malformed rows silently drop findings (regex has no error path) | High |
| **C. Formatter-only compression** (compress in `formatReviewComment`) | No model risk | Saves zero output tokens (the expensive side) — only comment bytes; misaligned with goal | Low (rejected) |

## Recommendation

**Approach A.** Add a flag-gated `OUTPUT_STYLE_CALIBRATION` block to `prompts.ts`, appended to every voice system prompt exactly like `REVIEW_CALIBRATION`/graph-neighborhood sections (absent → prompts byte-identical, same contract the corpus already enforces). Keep the labeled-block skeleton so `parseFindingsBlock`/consensus/refuter parsers are untouched. In the same change, wire the already-returned `GenerateResult.outputTokens` into metadata for simple/diagnostic/fan-out (workflow/consensus already do) so every voice is measurable via the cost-footer split. Extend the corpus harness with (a) prompt-byte goldens on/off per voice and (b) parser-level "detection" fixtures: known model responses in compressed style must parse to identical findings as verbose-style responses — this is the only detection-rate CI can prove model-free; true model detection-rate rides one documented out-of-band run, exactly as graph-context-retrieval already scopes it.

## Constraints and Coupling

- Regex parsers tolerate no skeleton changes; compression must live inside MESSAGE/SUGGESTION/SUMMARY/REASONING prose.
- Gateway (default provider) reports no token split — measured A/B only works on AI-SDK/CLI-bridge providers today.
- Golden suites (`prompts.test.ts`, `pipeline-golden.test.ts`, corpus `expected-prompt-*.txt`) fail on any byte drift when the flag is off — that is the safety contract, not friction.
- Summary is char-capped at 2000 (`format.ts:717`) and consensus REASONING renders raw into the comment (`consensus.ts:360-370`) — comment size and token count move together for prose fields.

## Risks

- **Finding loss via compression** — the whole point of the eval; parser-level asserts catch format breakage, not model omission.
- **Silent zero-findings parse** on format drift (no parser error path).
- **Multi-voice blast radius**: workflow/consensus/fan-out multiply savings but also multiply prompt-golden updates when on.
- **Directive dilution**: appended style text competes with EXACT-format instructions; may need per-voice phrasing.
- Measurement gap for simple mode (most common) until the split is wired.

## Open Questions

1. Is a `ReviewSettings` flag (like `enableGraphContext`) the right switch, and default-on or opt-in for the first slice?
2. Does the A/B run on Ollama/CLI-bridge only (measured split), or is gateway usage reporting a prerequisite?
3. Detection eval scope: parser-parity fixtures in CI + one documented out-of-band model run — sufficient gate to ship?
4. First slice voices: simple + synthesis + consensus REASONING, or all prompt sites at once?
5. Do compressed MESSAGE/SUGGESTION fields (rendered in the findings table) participate, or prose-only fields?
6. New fixtures: reuse corpus `diff.patch` files with authored compressed/verbose response pairs, or a fresh detection corpus with ground-truth bugs?
7. Should the 2000-char summary cap tighten alongside token targets?
8. Spec deltas: one new requirement in review-prompts only — confirm review-formatting stays untouched (comment bytes unchanged)?
