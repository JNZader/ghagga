/**
 * Complete Changed-Symbol Detection (scip-symbol-ranges, D3/D4/D7)
 *
 * Unlike `call-chain.ts`'s `extractChangedSymbolsFromDiff` (a regex-based
 * DECLARATION-LEVEL lower bound — it only sees hunk-header context and
 * top-level declaration lines, so a body-only change to an unchanged
 * signature is invisible to it), `computeChangedSymbolsComplete` maps
 * EVERY changed diff line to the innermost SCIP `symbolRanges` entry that
 * contains it. This is the fix for the symbol-precise-context no-op: a
 * function body edit now shows up as a real "changed" symbol instead of
 * silently vanishing.
 *
 * Requires `GraphNode.symbolRanges` (graph/scip/builder.ts, SCIP-only —
 * the regex-based `buildGraph()` never populates it). Files/graphs without
 * `symbolRanges` degrade to `hasUnattributedChanges: true` — callers MUST
 * fall back to the declaration-level extractor for those (see D5,
 * pipeline/prepare-graph.ts `buildSymbolImpactBlock`).
 */

import { parseUnifiedDiff } from '../diff/parse.js';
import type { DependencyGraph } from './schema.js';

export interface ChangedSymbolsResult {
  /** Every symbol whose `symbolRanges` entry overlaps a changed line. */
  changedSymbols: Set<string>;
  /**
   * `true` when at least one changed line in this file could NOT be
   * attributed to a known symbol range — a top-level statement, an
   * import, a line in a file with no `symbolRanges` data, a deletion in a
   * fully-removed symbol, a deleted/binary file with no addressable
   * post-image content, or a renamed file (the path move itself is a
   * structural change that affects importers via the path, not a symbol
   * range — set regardless of whether the rename also carries a content
   * hunk) (D7). Callers MUST treat this as "insufficient data" and fall
   * back to conservative reporting — NEVER claim a symbol/file is
   * unaffected when this is `true`.
   */
  hasUnattributedChanges: boolean;
}

/**
 * D3: among all symbols whose range contains `line`, pick the one with
 * the SMALLEST span (`end - start`) — the innermost enclosing symbol.
 * Ties (identical span) break on smallest `start`. A line inside a class
 * but between two methods (i.e. inside the class range but no nested
 * method range) attributes to the class — the only container left.
 */
export function findInnermostSymbol(
  ranges: Record<string, [number, number]> | undefined,
  line: number,
): string | undefined {
  if (!ranges) return undefined;

  let best: string | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  let bestStart = Number.POSITIVE_INFINITY;

  for (const [name, [start, end]] of Object.entries(ranges)) {
    if (line < start || line > end) continue;
    const span = end - start;
    if (span < bestSpan || (span === bestSpan && start < bestStart)) {
      best = name;
      bestSpan = span;
      bestStart = start;
    }
  }

  return best;
}

/**
 * D4: walk the diff's NEW-side line cursor per hunk. `+`/` ` lines occupy
 * the cursor then advance it; `-` lines attribute to whatever symbol
 * currently owns the cursor position (the point where the deleted line
 * used to sit) WITHOUT advancing it — deleting a line from inside a
 * still-existing symbol correctly attributes to that symbol; deleting an
 * entire symbol leaves the cursor between symbols → unattributed (D7,
 * conservative by construction). Context (` `) lines are never attributed
 * (they didn't change), only occupy+advance the cursor so later lines in
 * the hunk land on the right line number.
 */
export function computeChangedSymbolsComplete(
  diff: string,
  graph: DependencyGraph,
): Map<string, ChangedSymbolsResult> {
  const parsed = parseUnifiedDiff(diff);
  const result = new Map<string, ChangedSymbolsResult>();

  for (const file of parsed.files) {
    const path = file.path;
    if (!path) continue;

    const entry: ChangedSymbolsResult = result.get(path) ?? {
      changedSymbols: new Set(),
      hasUnattributedChanges: false,
    };
    result.set(path, entry);

    // D7 (LANDMINE): deleted/binary file, or no `+++ b/` at all (newPath
    // resolved to null, i.e. /dev/null) — no addressable post-image
    // ranges to attribute against. Conservative, no silent omission.
    if (file.isDeleted || file.isBinary || file.newPath === null) {
      entry.hasUnattributedChanges = true;
      continue;
    }

    // D7 (LANDMINE): a rename. The path move itself is a structural change
    // that is NOT symbol-attributable (it affects importers via the path,
    // not a symbol range) — mark conservative REGARDLESS of whether the
    // rename also carries a content hunk (still fall through below so any
    // hunk is processed normally; the rename flag alone forces the
    // conservative "unattributed" signal).
    if (file.isRename) {
      entry.hasUnattributedChanges = true;
    }

    const node = graph.nodes[path];
    const ranges = node?.symbolRanges;

    for (const hunk of file.hunks) {
      // D7 (LANDMINE): pure-deletion hunk — the new side is empty at this
      // hunk, so there is no new-side cursor to locate the deletion
      // against. Cannot attribute; conservative.
      if (hunk.newCount === 0) {
        entry.hasUnattributedChanges = true;
        continue;
      }

      let cursor = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.prefix === '\\') continue; // "\ No newline at end of file"

        if (line.prefix === ' ') {
          cursor++;
          continue;
        }

        if (line.prefix === '+') {
          const symbol = findInnermostSymbol(ranges, cursor);
          if (symbol) entry.changedSymbols.add(symbol);
          else entry.hasUnattributedChanges = true;
          cursor++;
          continue;
        }

        // '-' deletion: attribute at the current cursor position, do not
        // advance (the old-side line has no new-side position of its own).
        const symbol = findInnermostSymbol(ranges, cursor);
        if (symbol) entry.changedSymbols.add(symbol);
        else entry.hasUnattributedChanges = true;
      }
    }
  }

  return result;
}
