# Review Ledger — graph-context-retrieval

Full-4R review (diff >400 lines) of `feat/graph-context-retrieval` @ 7856d0d0, 2026-11-10. Four lenses, one exhaustive sweep each. Adversarial verification: **not required — zero BLOCKER/CRITICAL candidates survived the lenses' internal precision gates.** No fix round needed.

## Findings

| ID | Lens | Severity | Status | Location | Evidence |
|---|---|---|---|---|---|
| REL-001 | reliability | WARNING | info | packages/core/src/pipeline/prepare.ts:258 | Step 2.5b retries `graphLoader.load()` when `blast.graph` undefined — including when load returned null (oversize/malformed). FilesystemGraphLoader has no cache → with CLI defaults (blast-radius + graph-context both auto-ON), repos with oversize/malformed graphs get duplicate `onOversize`/`onMalformed` TUI warnings and doubled graph.json read+parse per review. Outcome unaffected (fail-closed holds). |
| RES-001 | resilience | WARNING | info | packages/core/src/graph/schema.ts:405; gather-safe.ts:304,317 | Staleness rung fails OPEN on unparseable `lastIndexedAt`: `new Date('garbage')` → NaN → `NaN > 7 === false` → not stale. A crafted metadata.json with matching `lastIndexedCommit` bypasses the >7d skip and grants the exact-fresh symbol tier. PRE-EXISTING function; this diff adds the consumption surface. Fenced advisory-only output bounds the impact. Fix-between-SDDs candidate. |
| RES-002 | resilience | WARNING | info | packages/core/src/graph/loader.ts:37-58 | MAX_GRAPH_SIZE_BYTES (20MB) enforced only in FilesystemGraphLoader (:141); GitHubApiGraphLoader fetches+parses unbounded (raw allows 100MB) — memory spike on SaaS from repo-controlled graph.json. PRE-EXISTING (loader unchanged in this diff); auto-on ladder raises engagement frequency. Fix-between-SDDs candidate. |
| REA-001 | readability | WARNING | info | packages/core/src/pipeline/gather-safe.ts:307 | Staleness message hardcodes `beyond ${7}d` while the rule is `GRAPH_STALE_DAYS` (schema.ts:245, already exported) — drift trap when the constant changes. |
| REA-002 | readability | SUGGESTION | info | packages/core/src/graph/neighbors.ts:76-77 | Doc claims the caller compares input vs result length for `filesCovered`; caller reports post-budget `renderedFiles` instead. Misleading contract comment. |
| REA-003 | readability | SUGGESTION | info | packages/core/src/cost-footer.ts:81-82,133-134 | `splitMeasured` true when EITHER token field supplied; half-measured splits (input only) drop the "estimated" label while output remains the 70/30 heuristic. |
| REA-004 | readability | SUGGESTION | info | packages/core/src/pipeline/state.ts:103-108 | One feature, two interface dialects (`graphNeighborhoodContext` data vs `graphContextMetadata` telemetry) — code-intel precedent uses one prefix end-to-end. |

## Verified clean (per lens)

- **Risk**: fencing on all 5 runners via `buildGraphNeighborhoodSection` → `wrapUntrusted`; forged-closer defang pinned by tests; migration 0006 additive/nullable, prevId==0005.id exactly two columns; settings numeric-only; fixtures pure JSON/TXT, no credentials/abs paths.
- **Reliability**: staleness ladder truth table correct in all 4 states + overlaps; budget join-aware ≤ cap, diff budget untouchable by construction (prepare order); `tokens_used = in + out` invariant in every reachable configuration; gateway honestly labeled estimated; 5 golden snapshots purely additive (46/0), off-path goldens untouched pinning byte-identity; frozen-clock corpus deterministic.
- **Resilience**: 4th Promise.all leg cannot reject (all throws inside gatherGraphContextSafe try/catch); malformed graphs null-out at loader; self-imports filtered; caps enforced in collectors not callers; 500-file PRs break at 30; null-token consumers NaN-free; migration safe with existing rows and concurrent old-server writes; CLI flag precedence mirrors blast-radius, auto-off in Action env.
- **Readability**: staleness/caps logic written once and reused; corpus/degradation/CLI/DB tests assert real behavior; no tautology tests; no >60-line mixed-concern functions beyond house style.

## Follow-ups (fix-between-SDDs backlog)

1. RES-001: NaN-fail-open staleness check (also benefits blast-radius).
2. RES-002: bound GitHubApiGraphLoader fetch.
3. Pre-existing unfenced `stackHints`/`codeIntelContext`/`callChainContext` (flagged in design phase).
4. REL-001 double-load + REA-001 hardcoded 7: one small prepare/loader pass.
