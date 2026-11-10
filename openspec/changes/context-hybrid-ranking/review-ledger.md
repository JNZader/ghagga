# Review Ledger — context-hybrid-ranking

Full-4R review (diff >400 lines) of `feat/context-hybrid-ranking`, 2026-11-10. Four lenses, one exhaustive sweep each. Zero BLOCKER/CRITICAL candidates → no refutation batch, no fix round.

## Info findings (WARNING — never blocking)

| ID | Lens | Location | Evidence |
|---|---|---|---|
| RES-001 | resilience | 3 change specs modify `Token Budget Management` | context-hybrid-ranking's sequencing note names only #471; review-output-compression's seam note names only graph-context-retrieval. Whichever archives second does wholesale replacement and silently deletes the other's MUSTs (ranking rule or output-token-split scenarios). **Backlog: bidirectional seam notes + archive-order reconciliation.** |
| REL-001 | reliability | call-chain.ts:231 → neighborhood-rank.ts:99 | Ranker's w2 inherits `extractChangedSymbolsFromDiff`'s tail fallback: the LAST diff file with zero declarations inherits the PREVIOUS file's last symbol. EXECUTED on this branch's own fixture: `ranker.ts` maps to `fvarI` (declared in filler-i's hunk) → scores 24 not 19. Root cause pre-existing; this branch makes it order-affecting. Bounded: one file, ≤5 pts. **Backlog: reset the tail symbol on file boundary in extractChangedSymbolsFromDiff.** |
| REL-002 | reliability | graph-context-corpus.test.ts:276-284 | Fixture's documented scoring is wrong: every changed file except ranker.ts has capped importers=10 → ALL get the hub bonus (filler-a=10 not 9, fillers=15 not 14). Assertions still bind order/survivors correctly (bonus uniform within group) but the corpus case does NOT discriminate the hub bonus — deleting HUB_BONUS yields identical output. Unit rows (neighborhood-rank.test.ts:230-288) DO pin it. **Backlog: fixture README/score docs correction (mechanical).** |

## Verified clean (per lens)

- **Risk**: LEDGER empty — archive commit 28b89a5 pure renames verified bidirectionally (every non-empty line exists verbatim in the archived delta; zero dropped requirement content); base-spec fix e672940 header-deletions only + declared Purpose; diffText flows only into Set members for overlapCount (integer scores consumed solely by the comparator — zero output leak, metadata adds only constant `rankingMode: 'lexical'`); determinism structural (insertion-ordered Sets/Maps, integer arithmetic, ES2019 stable sort, no Date/random); echo-chamber guard mathematically held AND pinned (hub 10 pts < symbol-hit 14/19, unit boundary rows at 9/10 importers).
- **Reliability**: stable-sort tie→0 + diff-ordered input confirmed; 3/5/2/1 formula exact with weight-swap discriminating units (3↔5 flips graph-omitted row); budget-cut uses the DEFAULT 1200 budget with real margins (4591/5275 vs 4800 — not tuned-to-pass); truncatedFiles rank-invariant (length-preserving reorder); skip paths return before the ranker (gather-safe.ts:282/290/305) with no rankingMode on skip metadata.
- **Resilience**: no O(n²) intersection (Set.has O(1) per element, single-pass tokenizer); NaN impossible (pure integer arithmetic); 10k-line garbage diff linear; any throw rides the existing catch → failedStep; branch IMPROVES base-spec health (main 10 → branch 8 failed specs, core-engine + review-prompts now pass).
- **Readability**: LEDGER empty — all four weights named constants with per-constant docs + formula-with-why in the file header; archive hygiene clean; 11 discriminating it.each rows + 4 standalone tests (all named by what they discriminate); rankingMode absence documented at type AND write site; fixture rationale in corpus test + design.

## Backlog additions from this review

1. RES-001: three-writer Token Budget Management reconciliation (bidirectional seam notes).
2. REL-001: extractChangedSymbolsFromDiff tail-fallback reset on file boundary.
3. REL-002: budget-cut-ranked fixture score-docs correction.
