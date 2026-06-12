/**
 * Diff-to-Symbol Mapper
 *
 * Maps unified diff hunks to symbol definitions, identifying
 * which symbols were affected by code changes.
 *
 * Pure functions with no side effects.
 */

import { matchHunkHeader, parseUnifiedDiff } from '../diff/index.js';
import type { AffectedSymbol, DiffHunk, SymbolInfo } from './types.js';

// ─── Hunk Parsing ──────────────────────────────────────────────

/**
 * Parse unified diff content to extract hunk line ranges.
 *
 * Thin adapter over the unified parser (`src/diff/parse.ts`): model hunks
 * are mapped down to the 4 captures this module has always returned. Bare
 * hunk fragments WITHOUT any `diff --git` header (a documented input shape —
 * "raw unified diff content for a single file") land in the model's
 * `preamble`, so those lines are scanned with the shared `matchHunkHeader`
 * (THE single hunk-header regex of core, spec R8).
 *
 * KNOWN synthetic-only divergence vs the pre-adapter regex (`\s+`
 * separators): headers with tabs or multiple spaces (`@@  -1,2  +3,4  @@`)
 * no longer match. git only ever emits the single-space form; pinned in
 * `src/diff/__tests__/parity-parse-hunks.test.ts`.
 *
 * @param diffContent - Raw unified diff content for a single file
 * @returns Array of DiffHunk objects with line ranges
 */
export function parseHunks(diffContent: string): DiffHunk[] {
  const { preamble, files } = parseUnifiedDiff(diffContent);
  const hunks: DiffHunk[] = [];

  for (const line of preamble) {
    const match = matchHunkHeader(line);
    if (match) hunks.push(match);
  }

  for (const file of files) {
    for (const hunk of file.hunks) {
      hunks.push({
        oldStart: hunk.oldStart,
        oldCount: hunk.oldCount,
        newStart: hunk.newStart,
        newCount: hunk.newCount,
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
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
