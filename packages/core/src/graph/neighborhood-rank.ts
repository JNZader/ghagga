/**
 * Lexical+structural ranking of file neighborhoods (context-hybrid-ranking
 * Phase 1).
 *
 * Pure, synchronous, deterministic reorder inserted at the gather seam
 * between `collectFileNeighborhoods` and `formatGraphNeighborhood` — the
 * first-fit token cut then favors lexically relevant neighborhoods over
 * whoever appeared earliest in the diff. Entry rendering, budget math, and
 * fencing are untouched: ranking changes ORDER only.
 *
 * Score (fixed integer weights, design §Score Formula):
 *
 *   score = 3·|pathTokens ∩ diffTokens|        // w1 — path segments
 *         + 5·|symPool ∩ diffTokens|           // w2 — changed syms ∪ exports
 *         + 2·|impSymTokens ∩ diffTokens|      // w3 — graph importSymbols
 *         + (importers.length >= 10 ? 1 : 0)   // hub bonus (tiebreak only)
 *
 * Symbol hits weigh most (cross-file export mention is the anti-echo
 * differentiator); structure contributes at most 1 point — enough to break
 * exact ties, never enough to dominate a lexical hit. All intersections run
 * over UNIQUE token sets: repetition in the diff or the paths cannot
 * inflate any term. Sort is stable: equal scores keep diff (collect) order.
 */

import { tokenize } from '../search/indexer.js';
import { extractChangedSymbolsFromDiff } from './call-chain.js';
import { type FileNeighborhood, MAX_NEIGHBORS_PER_FILE } from './neighbors.js';
import type { DependencyGraph } from './schema.js';

// ─── Constants ──────────────────────────────────────────────────

/** w1 — weight of a diff-token hit on a neighborhood path segment. */
const PATH_TOKEN_WEIGHT = 3;

/** w2 — weight of a diff-token hit on a changed/exported symbol name. */
const SYMBOL_TOKEN_WEIGHT = 5;

/** w3 — weight of a diff-token hit on an `importSymbols` name. */
const IMPORT_SYMBOL_WEIGHT = 2;

/**
 * Hub bonus: an importer list at the per-file cap (raw length = degree,
 * since `collectFileNeighborhoods` caps importers at MAX_NEIGHBORS_PER_FILE)
 * earns exactly 1 point — a tiebreak, never a dominant term (max structural
 * influence 1 < any symbol hit 5).
 */
const HUB_BONUS = 1;

// ─── Ranking ────────────────────────────────────────────────────

/**
 * Segment a file path for path-token matching: split on `/` and `.` FIRST,
 * then tokenize each segment with the search tokenizer (stop-word filtered;
 * keeps `-`/`_` intact so segments match how they appear in diff headers).
 * No camelCase splitting — identifiers match verbatim (exact-name semantic).
 */
function pathTokensOf(path: string, into: Set<string>): void {
  for (const segment of path.split(/[/.]/)) {
    for (const token of tokenize(segment)) into.add(token);
  }
}

/** Tokenize a pool of raw symbol names into their unique token set. */
function symbolTokensOf(names: Iterable<string>, into: Set<string>): void {
  for (const name of names) {
    for (const token of tokenize(name)) into.add(token);
  }
}

/** Count members of `tokens` present in `diffTokens` (unique-set overlap). */
function overlapCount(tokens: Set<string>, diffTokens: Set<string>): number {
  let hits = 0;
  for (const token of tokens) {
    if (diffTokens.has(token)) hits += 1;
  }
  return hits;
}

/**
 * Rank neighborhoods by lexical overlap with the diff plus a structural hub
 * tiebreak, score-DESC via stable sort (ties keep input/diff order).
 *
 * - Never mutates `neighborhoods`; returns a NEW array holding the SAME
 *   element references.
 * - `graph` is optional: without it (or without `importSymbols` data on the
 *   node — Python/Rust-shaped, symbol-sparse) the w3 term scores 0 while
 *   w1/w2 keep scoring.
 * - No I/O, no settings, no kill-switch: the existing `enableGraphContext`
 *   gate owns whether gathering (and thus ranking) runs at all.
 */
export function rankNeighborhoods(
  neighborhoods: FileNeighborhood[],
  diffText: string,
  graph?: DependencyGraph,
): FileNeighborhood[] {
  if (neighborhoods.length === 0) return [];

  const diffTokens = new Set(tokenize(diffText));
  const changedSyms = extractChangedSymbolsFromDiff(diffText);

  const scores = new Map<FileNeighborhood, number>();
  for (const neighborhood of neighborhoods) {
    // w1 — own path plus importer/importee paths (segments, then tokens).
    const pathTokens = new Set<string>();
    pathTokensOf(neighborhood.file, pathTokens);
    for (const importer of neighborhood.importers) pathTokensOf(importer, pathTokens);
    for (const importee of neighborhood.importees) pathTokensOf(importee, pathTokens);

    // w2 — this file's changed symbols (regex lower bound; files absent from
    // the diff simply contribute nothing) unioned with its exported symbols.
    const symPoolTokens = new Set<string>();
    symbolTokensOf(changedSyms.get(neighborhood.file) ?? [], symPoolTokens);
    symbolTokensOf(neighborhood.exportedSymbols, symPoolTokens);

    // w3 — named imports of this file, only when the graph (and the node's
    // `importSymbols` advisory data) is available.
    const impSymTokens = new Set<string>();
    const importSymbols = graph?.nodes[neighborhood.file]?.importSymbols;
    if (importSymbols) {
      for (const names of Object.values(importSymbols)) {
        symbolTokensOf(names, impSymTokens);
      }
    }

    const score =
      PATH_TOKEN_WEIGHT * overlapCount(pathTokens, diffTokens) +
      SYMBOL_TOKEN_WEIGHT * overlapCount(symPoolTokens, diffTokens) +
      IMPORT_SYMBOL_WEIGHT * overlapCount(impSymTokens, diffTokens) +
      (neighborhood.importers.length >= MAX_NEIGHBORS_PER_FILE ? HUB_BONUS : 0);

    scores.set(neighborhood, score);
  }

  // Array.prototype.sort is stable (ES2019+): equal scores keep input order.
  return [...neighborhoods].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
}
