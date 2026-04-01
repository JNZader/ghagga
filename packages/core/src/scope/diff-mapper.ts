/**
 * Diff-to-Symbol Mapper
 *
 * Maps unified diff hunks to symbol definitions, identifying
 * which symbols were affected by code changes.
 *
 * Pure functions with no side effects.
 */

import type { AffectedSymbol, DiffHunk, SymbolInfo } from './types.js';

// ─── Hunk Parsing ──────────────────────────────────────────────

/**
 * Regex to match unified diff hunk headers.
 * Format: @@ -oldStart[,oldCount] +newStart[,newCount] @@
 *
 * Examples:
 *   @@ -10,5 +10,7 @@
 *   @@ -1 +1,3 @@
 *   @@ -0,0 +1,20 @@
 */
const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse unified diff content to extract hunk line ranges.
 *
 * @param diffContent - Raw unified diff content for a single file
 * @returns Array of DiffHunk objects with line ranges
 */
export function parseHunks(diffContent: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffContent.split('\n');

  for (const line of lines) {
    const match = HUNK_HEADER_RE.exec(line);
    if (match) {
      hunks.push({
        oldStart: Number.parseInt(match[1]!, 10),
        oldCount: match[2] !== undefined ? Number.parseInt(match[2], 10) : 1,
        newStart: Number.parseInt(match[3]!, 10),
        newCount: match[4] !== undefined ? Number.parseInt(match[4], 10) : 1,
      });
    }
  }

  return hunks;
}

// ─── Symbol Mapping ────────────────────────────────────────────

/**
 * Map diff hunks to affected symbols.
 *
 * A symbol is considered "affected" if any hunk's NEW side line range
 * overlaps with the symbol's line range. We use the new side because
 * we're analyzing the post-change source code.
 *
 * @param hunks - Parsed diff hunks
 * @param symbols - Extracted symbols from the NEW version of the file
 * @returns Array of affected symbols with their overlapping hunks
 */
export function mapDiffToSymbols(hunks: DiffHunk[], symbols: SymbolInfo[]): AffectedSymbol[] {
  if (hunks.length === 0 || symbols.length === 0) return [];

  const affected: AffectedSymbol[] = [];

  for (const symbol of symbols) {
    const overlapping = hunks.filter((hunk) =>
      rangesOverlap(
        hunk.newStart,
        hunk.newStart + Math.max(hunk.newCount - 1, 0),
        symbol.startLine,
        symbol.endLine,
      ),
    );

    if (overlapping.length > 0) {
      affected.push({ symbol, overlappingHunks: overlapping });
    }
  }

  return affected;
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Check if two 1-based line ranges overlap.
 *
 * Two ranges [a1, a2] and [b1, b2] overlap when:
 *   a1 <= b2 AND b1 <= a2
 */
function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
