/**
 * Entity-Level Semantic Diff
 *
 * Classifies affected symbols into cosmetic (whitespace/comments/formatting),
 * logic (actual behavior change), or renamed (name changed, body equivalent).
 *
 * Operates as a post-processing step on top of diff-mapper output.
 * Uses regex heuristics — no AST required for v1.
 *
 * Pure functions with no side effects.
 */

import { matchHunkHeader, parseUnifiedDiff } from '../diff/index.js';
import type {
  AffectedSymbol,
  EntityChange,
  EntityDiffOptions,
  RenameMatch,
  SymbolInfo,
} from './types.js';
import { ENTITY_CHANGE_KIND } from './types.js';

// ─── Constants ────────────────────────────────────────────────

const DEFAULT_SIMILARITY_THRESHOLD = 0.9;

/**
 * Patterns that indicate a line is cosmetic (not a logic change).
 * Applied to the content portion of a diff line (after the +/- prefix).
 */
const COSMETIC_LINE_PATTERNS: RegExp[] = [
  /^\s*$/, // blank / whitespace-only
  /^\s*\/\//, // single-line comment (JS/TS/Go/Java/C)
  /^\s*#/, // comment (Python/Ruby/Shell)
  /^\s*\/?\*/, // block comment line (/* ... */ or * continuation)
  /^\s*\*\/\s*$/, // block comment end
  /^\s*"""/, // Python docstring delimiter
  /^\s*'''/, // Python docstring delimiter (single-quote)
];

// ─── Extract Diff Lines ───────────────────────────────────────

/**
 * Extract the actual addition/deletion lines from a diff that fall
 * within a symbol's line range. Symbol ranges are NEW-side line numbers
 * (contract of mapDiffToSymbols: symbols come from the NEW version of the
 * file), so BOTH additions and deletions are attributed by the live
 * new-side position — for a deletion, the new-side line where the removal
 * happened (CORE-M9 fix; previously deletions were compared by their
 * OLD-side line number against the new-side ranges, mis-attributing them
 * whenever earlier hunks made old/new drift apart).
 *
 * Thin adapter over the unified parser (`src/diff/parse.ts`): the walk runs
 * over the byte-exact line stream `[...preamble, ...files[].rawLines]`
 * (≡ `diffContent.split('\n')` by the model's R2 reconstruction invariant),
 * NOT over `hunk.lines` — preserving the historical behaviors the structured
 * hunks do not carry: bare hunk fragments without a `diff --git` header
 * (kept in `preamble`), orphan +/- tails after a genuine empty line
 * mid-hunk, and metadata lines counted as context. Hunk headers are
 * detected with the shared `matchHunkHeader` (THE single hunk-header regex
 * of core, spec R8).
 *
 * KNOWN synthetic-only divergence vs the pre-adapter `\s+` regex: hunk
 * headers with tabs/multiple spaces no longer reset the position counter
 * (git only emits the single-space form); pinned in
 * `src/diff/__tests__/parity-extract-entity-diff-lines.test.ts`.
 *
 * @param diffContent - Raw unified diff content for a single file
 * @param symbol - The symbol whose range to extract lines for
 * @returns Array of raw diff lines (with +/- prefix) within the symbol range
 */
export function extractEntityDiffLines(diffContent: string, symbol: SymbolInfo): string[] {
  const { preamble, files } = parseUnifiedDiff(diffContent);
  const stream = [...preamble, ...files.flatMap((f) => f.rawLines)];
  const result: string[] = [];
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of stream) {
    const hunk = matchHunkHeader(line);
    if (hunk) {
      currentNewLine = hunk.newStart;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      // Addition — lives at the current new-side line, then advances it.
      if (currentNewLine >= symbol.startLine && currentNewLine <= symbol.endLine) {
        result.push(line);
      }
      currentNewLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deletion — attributed to the new-side position where the removal
      // happened (CORE-M9). A deletion does NOT advance the new side.
      if (currentNewLine >= symbol.startLine && currentNewLine <= symbol.endLine) {
        result.push(line);
      }
    } else {
      // Context (or any other) line — advances the new-side position.
      currentNewLine++;
    }
  }

  return result;
}

// ─── Classification ───────────────────────────────────────────

/**
 * Check if a diff line (after removing the +/- prefix) is cosmetic.
 * A line is cosmetic if it's whitespace-only, a comment, or formatting.
 */
function isCosmeticLine(diffLine: string): boolean {
  // Strip the leading +/- prefix to get the actual content
  const content = diffLine.slice(1);
  return COSMETIC_LINE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Classify affected symbols into cosmetic or logic changes based on
 * their diff lines.
 *
 * A change is `cosmetic` if ALL diff lines within the entity are cosmetic
 * (whitespace, comments, formatting). Otherwise it's `logic`.
 *
 * @param affectedSymbols - Symbols affected by the diff (from mapDiffToSymbols)
 * @param diffContent - Raw unified diff content for the file
 * @returns Array of EntityChange with classification
 */
export function classifyEntityChanges(
  affectedSymbols: AffectedSymbol[],
  diffContent: string,
): EntityChange[] {
  return affectedSymbols.map((affected) => {
    const diffLines = extractEntityDiffLines(diffContent, affected.symbol);

    // No diff lines within range → default to logic (conservative)
    if (diffLines.length === 0) {
      return {
        symbol: affected.symbol,
        kind: ENTITY_CHANGE_KIND.LOGIC,
        diffLines,
      };
    }

    const allCosmetic = diffLines.every(isCosmeticLine);

    return {
      symbol: affected.symbol,
      kind: allCosmetic ? ENTITY_CHANGE_KIND.COSMETIC : ENTITY_CHANGE_KIND.LOGIC,
      diffLines,
    };
  });
}

// ─── Rename Detection ─────────────────────────────────────────

/**
 * Normalize a source body for comparison: strip comments, collapse
 * whitespace, remove blank lines.
 */
function normalizeBody(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !COSMETIC_LINE_PATTERNS.some((p) => p.test(line)))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Defensive cap on LCS input size (CORE-M8). Inputs are normalized entity
 * bodies from a diff, typically well under this. The DP below is O(n*m)
 * time, so two pathological ~100 KB bodies (e.g. a class spanning a whole
 * generated file) would cost ~10^10 cell updates. Beyond the cap the DP
 * compares the first MAX chars of each body only, but the similarity
 * denominator keeps the ORIGINAL lengths — so two giant bodies identical
 * only within the capped prefix score at most `cap / max(original lens)`
 * (e.g. two 15k bodies sharing only their first 10k score ≤ 0.67), never a
 * false 1.0. Trade-off: similarity living past the cap is invisible to the
 * DP, so genuinely-similar giant pairs may be under-scored and missed —
 * degraded detection on pathological inputs, never unbounded CPU.
 */
const MAX_SIMILARITY_INPUT_LENGTH = 10_000;

/**
 * Default total LCS DP work budget for one detectRenames call (CORE-M8
 * fix-forward). detectRenames compares every removed×added pair and each
 * pair that reaches the DP costs n*m cell updates (n, m ≤ the 10k input
 * cap, so a single worst-case pair is 10^8 cells ≈ a few hundred ms).
 * 200M cells keeps the absolute worst case at low single-digit seconds on
 * commodity hardware while covering thousands of realistic pairs (~2000
 * pairs of 300×300-char bodies). Trade-off (same spirit as the input cap):
 * once the budget is exhausted, remaining pairs are reported as
 * not-similar (no rename) — renames can go undetected on pathological
 * diffs, CPU is never unbounded. Overridable per call via
 * `EntityDiffOptions.lcsDpCellBudget`.
 */
const DEFAULT_LCS_DP_CELL_BUDGET = 200_000_000;

/** Mutable per-detectRenames-call accumulator of remaining LCS DP work. */
interface LcsDpBudget {
  cellsRemaining: number;
}

/**
 * Compute similarity ratio between two strings (0.0–1.0) as
 * `LCS(a, b) / max(len(a), len(b))` — a real longest-common-subsequence
 * ratio (CORE-M8; the previous implementation claimed LCS but compared
 * characters at the same positions, so a one-char shift like "Xabcde" vs
 * "abcde" scored near 0 instead of high).
 *
 * Classic two-row dynamic programming: O(n*m) time, O(min(n, m)) memory.
 * Returns 1.0 for identical strings, 0.0 for completely different.
 *
 * Guards, in evaluation order (CORE-M8 fix-forward):
 * 1. Identity fast-path on the ORIGINAL strings → exact 1.0 (never on the
 *    capped slices — equal capped prefixes of differing bodies are NOT 1.0).
 * 2. Free prefilter: LCS(a, b) ≤ min(len(a), len(b), cap), so when that
 *    bound over `max(len)` is already below `threshold` the pair cannot
 *    match — skip the O(n*m) DP entirely. Returns 0.0; the caller only
 *    compares the result against `threshold`, so any sub-threshold value
 *    is equivalent (reported similarities of accepted matches are exact).
 * 3. Capped-identity shortcut: equal capped prefixes have LCS exactly
 *    equal to the capped length — score `cap / max(original lens)` with
 *    no DP.
 * 4. DP cell budget: each DP run consumes n*m cells from `budget`; a pair
 *    that would exceed what remains returns 0.0 (treated as not similar)
 *    instead of running.
 */
function computeSimilarity(a: string, b: string, threshold: number, budget: LcsDpBudget): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Denominator over ORIGINAL lengths: a post-cap denominator let two >10k
  // bodies with identical capped prefixes score a false 1.0.
  const maxLen = Math.max(a.length, b.length);

  const lcsUpperBound = Math.min(a.length, b.length, MAX_SIMILARITY_INPUT_LENGTH);
  if (lcsUpperBound / maxLen < threshold) return 0.0;

  const s = a.length > MAX_SIMILARITY_INPUT_LENGTH ? a.slice(0, MAX_SIMILARITY_INPUT_LENGTH) : a;
  const t = b.length > MAX_SIMILARITY_INPUT_LENGTH ? b.slice(0, MAX_SIMILARITY_INPUT_LENGTH) : b;
  if (s === t) return s.length / maxLen;

  const cells = s.length * t.length;
  if (cells > budget.cellsRemaining) return 0.0;
  budget.cellsRemaining -= cells;

  return lcsLength(s, t) / maxLen;
}

/**
 * Length of the longest common subsequence of two strings.
 * Two-row DP over the shorter string to keep memory at O(min(n, m)).
 */
function lcsLength(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const cols = shorter.length;

  let prev = new Uint32Array(cols + 1);
  let curr = new Uint32Array(cols + 1);

  for (let i = 1; i <= longer.length; i++) {
    const charCode = longer.charCodeAt(i - 1);
    for (let j = 1; j <= cols; j++) {
      if (charCode === shorter.charCodeAt(j - 1)) {
        curr[j] = prev[j - 1] + 1;
      } else {
        const fromTop = prev[j];
        const fromLeft = curr[j - 1];
        curr[j] = fromTop >= fromLeft ? fromTop : fromLeft;
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[cols];
}

/**
 * Detect renamed entities by matching removed symbols with added symbols
 * that have similar bodies.
 *
 * @param removedSymbols - Symbols present in old version but not in new
 * @param addedSymbols - Symbols present in new version but not in old
 * @param oldSource - Full source of the old file version
 * @param newSource - Full source of the new file version
 * @param options - Configuration options
 * @returns Array of rename matches
 */
export function detectRenames(
  removedSymbols: SymbolInfo[],
  addedSymbols: SymbolInfo[],
  oldSource: string,
  newSource: string,
  options?: EntityDiffOptions,
): RenameMatch[] {
  const threshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  // Shared across ALL removed×added pairs of this call (CORE-M8 fix-forward):
  // bounds total DP work so a pathological diff (many large bodies) degrades
  // to missed renames instead of unbounded CPU.
  const budget: LcsDpBudget = {
    cellsRemaining: options?.lcsDpCellBudget ?? DEFAULT_LCS_DP_CELL_BUDGET,
  };
  const renames: RenameMatch[] = [];
  const matchedAdded = new Set<number>();

  const oldLines = oldSource.split('\n');
  const newLines = newSource.split('\n');

  for (const removed of removedSymbols) {
    // Skip the first line (declaration/signature contains the name) to compare body only
    const oldBodyStart = Math.min(removed.startLine, removed.endLine);
    const oldBody = normalizeBody(oldLines.slice(oldBodyStart, removed.endLine).join('\n'));

    if (oldBody.length === 0) continue;

    let bestMatch: { index: number; similarity: number; symbol: SymbolInfo } | undefined;

    for (let i = 0; i < addedSymbols.length; i++) {
      if (matchedAdded.has(i)) continue;
      const added = addedSymbols[i]!;

      // Must be same kind (function→function, class→class)
      if (added.kind !== removed.kind) continue;

      // Skip the first line (declaration/signature contains the name) to compare body only
      const newBodyStart = Math.min(added.startLine, added.endLine);
      const newBody = normalizeBody(newLines.slice(newBodyStart, added.endLine).join('\n'));

      if (newBody.length === 0) continue;

      const similarity = computeSimilarity(oldBody, newBody, threshold, budget);

      if (similarity >= threshold && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { index: i, similarity, symbol: added };
      }
    }

    if (bestMatch) {
      matchedAdded.add(bestMatch.index);
      renames.push({
        oldName: removed.name,
        newName: bestMatch.symbol.name,
        similarity: bestMatch.similarity,
        symbol: bestMatch.symbol,
      });
    }
  }

  return renames;
}

// ─── Filtering ────────────────────────────────────────────────

/**
 * Filter entity changes to only those with logic changes.
 * Cosmetic and renamed entities are excluded.
 *
 * @param changes - Classified entity changes
 * @returns Only entities with `logic` classification
 */
export function filterLogicChanges(changes: EntityChange[]): EntityChange[] {
  return changes.filter((c) => c.kind === ENTITY_CHANGE_KIND.LOGIC);
}
