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
 * within a symbol's line range (new-side lines for +, old-side for -).
 *
 * Walks the diff content, tracking the current new-side line number
 * via hunk headers and line prefixes, and collects lines that overlap
 * with the symbol's [startLine, endLine] range.
 *
 * @param diffContent - Raw unified diff content for a single file
 * @param symbol - The symbol whose range to extract lines for
 * @returns Array of raw diff lines (with +/- prefix) within the symbol range
 */
export function extractEntityDiffLines(diffContent: string, symbol: SymbolInfo): string[] {
  const lines = diffContent.split('\n');
  const result: string[] = [];
  let currentNewLine = 0;
  let currentOldLine = 0;
  let inHunk = false;

  const HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

  for (const line of lines) {
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      currentOldLine = Number.parseInt(hunkMatch[1]!, 10);
      currentNewLine = Number.parseInt(hunkMatch[2]!, 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      // Addition — tracked on new-side line number
      if (currentNewLine >= symbol.startLine && currentNewLine <= symbol.endLine) {
        result.push(line);
      }
      currentNewLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deletion — tracked on old-side line number but we include if
      // it maps to the symbol's range (using new-side context position)
      if (currentOldLine >= symbol.startLine && currentOldLine <= symbol.endLine) {
        result.push(line);
      }
      currentOldLine++;
    } else {
      // Context line — advances both counters
      currentNewLine++;
      currentOldLine++;
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
 * Compute similarity ratio between two strings (0.0–1.0).
 * Uses a simple longest-common-subsequence ratio approach.
 * Returns 1.0 for identical strings, 0.0 for completely different.
 */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const maxLen = Math.max(a.length, b.length);

  // For performance, use character-level comparison for short strings
  // and a simplified ratio for longer ones
  let matches = 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;

  // Count matching characters at same positions
  const minLen = shorter.length;
  for (let i = 0; i < minLen; i++) {
    if (shorter[i] === longer[i]) matches++;
  }

  return matches / maxLen;
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

      const similarity = computeSimilarity(oldBody, newBody);

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
