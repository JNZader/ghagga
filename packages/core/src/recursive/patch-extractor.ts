/**
 * Patch Extractor — extracts suggestion patches from review findings
 * and applies them virtually to produce a synthetic diff.
 *
 * No filesystem access — operates purely on diff strings.
 */

import { parseUnifiedDiff } from '../diff/index.js';
import type { ReviewFinding } from '../types.js';
import type { SuggestionPatch } from './types.js';

// ─── Patch Extraction ──────────────────────────────────────────

/**
 * Extract actionable patches from review findings.
 *
 * Only findings with both a `suggestion` and a `file` are included.
 * Findings without a line number are included but marked as file-level.
 *
 * @param findings - Review findings from the AI agent
 * @returns Array of suggestion patches ready for virtual application
 */
export function extractPatches(findings: ReviewFinding[]): SuggestionPatch[] {
  const patches: SuggestionPatch[] = [];

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    if (!finding) continue;
    if (!finding.suggestion || !finding.file) continue;

    // Skip empty/whitespace-only suggestions
    if (finding.suggestion.trim().length === 0) continue;

    patches.push({
      file: finding.file,
      line: finding.line,
      originalMessage: finding.message,
      suggestion: finding.suggestion,
      findingIndex: i,
    });
  }

  return patches;
}

// ─── Virtual Patch Application ─────────────────────────────────

/**
 * Apply suggestion patches to an original diff, producing a synthetic
 * patched diff for re-review.
 *
 * Strategy:
 * - Parse the diff with the unified parser and walk it in input order
 *   (preamble first, then each file's `rawLines`) — output is byte-identical
 *   to the input plus the injected marker lines (spec R2 reconstruction).
 * - For each file, collect patches targeting that file; a single-pass line
 *   counter tracks the target-side position and every patch whose `line`
 *   matches the counter emits a `+[SUGGESTED FIX]` marker after that line.
 *
 * The patched diff is a SYNTHETIC representation — it shows what the code
 * would look like if the suggestions were applied. This is NOT a real
 * git diff; it's a review-friendly format for the LLM to analyze.
 *
 * ⚠️ FROZEN LEGACY BEHAVIOR (spec R7 — golden recursive-golden.test.ts):
 * this walker intentionally reproduces the historical line accounting,
 * bugs included. Do NOT "fix" any of these here (separate ticket):
 * - Quoted headers (`diff --git "a/x" "b/y"`, core.quotepath) are NOT
 *   recognized as file boundaries, even though the unified parser handles
 *   them: patches against such files never apply, and the previous file's
 *   patch scope + line counter keep running through the quoted section
 *   (`headerQuoted` gate below). The historical regex only matched the
 *   unquoted form.
 * - The counter counts metadata lines its exclusion list never covered
 *   (`similarity index`, `rename from/to`, `Binary files`, `new file mode`,
 *   mode lines) and genuine empty lines — including lines a strict parser
 *   would consider orphaned after an empty line cut a hunk short. That is
 *   why counting walks `rawLines` (every input line), NOT `hunks`.
 * - On iteration 2+ of the recursive loop, previously injected
 *   `+[SUGGESTED FIX]` lines are counted like any other `+` line, shifting
 *   later patches (the frozen off-by-N).
 * - The file-boundary path authority is the `diff --git` header b-side
 *   capture (`headerNewPath`), NOT the `+++ b/` / `rename to` resolved
 *   `path` — they only diverge on malformed input, where the header must
 *   keep winning for parity.
 * - Patches without a `line` never match the counter and are silently
 *   dropped (golden pins this).
 * Known narrowing vs the historical loose regexes, documented per design:
 * a partial hunk header (e.g. `@@ -1,2 +3` cut mid-line) no longer resets
 * the counter, and a hand-crafted `diff --git a/old-with b/inside "b/x"`
 * mixed-quoted header is treated as quoted (no boundary) instead of
 * matching the historical greedy capture. Neither form occurs in git or
 * `truncateDiff` output (it cuts at line boundaries).
 *
 * @param originalDiff - The original unified diff string
 * @param patches - Suggestion patches to apply
 * @returns Synthetic diff with suggestions applied
 */
export function applyVirtualPatches(originalDiff: string, patches: SuggestionPatch[]): string {
  if (patches.length === 0) return originalDiff;

  // Group patches by file
  const patchesByFile = new Map<string, SuggestionPatch[]>();
  for (const patch of patches) {
    const existing = patchesByFile.get(patch.file) ?? [];
    existing.push(patch);
    patchesByFile.set(patch.file, existing);
  }

  // Build the synthetic diff
  const parsed = parseUnifiedDiff(originalDiff);
  const result: string[] = [];

  let currentFile: string | null = null;
  let currentFilePatches: SuggestionPatch[] = [];
  let lineCounter = 0; // Tracks the target-side line number in current hunk

  // Emit one input line, advancing the legacy counter and injecting any
  // matching `+[SUGGESTED FIX]` markers after it.
  const visit = (line: string): void => {
    // Count lines for position tracking (added or context lines increment target counter)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineCounter++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed lines don't increment target counter
    } else if (
      !line.startsWith('\\') &&
      !line.startsWith('diff ') &&
      !line.startsWith('index ') &&
      !line.startsWith('---') &&
      !line.startsWith('+++') &&
      !line.startsWith('@@')
    ) {
      lineCounter++;
    }

    result.push(line);

    // Check if any patch targets this line
    if (currentFile && currentFilePatches.length > 0) {
      const matchingPatches = currentFilePatches.filter((p) => p.line === lineCounter);
      for (const patch of matchingPatches) {
        // Insert the suggestion as a synthetic replacement block
        result.push(`+[SUGGESTED FIX] ${patch.suggestion}`);
      }
    }
  };

  for (const line of parsed.preamble) visit(line);

  for (const file of parsed.files) {
    // File boundary — legacy gate: quoted headers were never recognized, so
    // the previous file's patch scope and counter deliberately leak into
    // this section (see FROZEN LEGACY BEHAVIOR above).
    if (!file.headerQuoted) {
      currentFile = file.headerNewPath;
      currentFilePatches = patchesByFile.get(currentFile) ?? [];
      lineCounter = 0;
    }

    // Hunk headers reset the counter to the new-side start. Every line that
    // parses as a hunk header appears in rawLines verbatim and in order, so
    // an index pointer + string equality identifies them without re-parsing.
    let nextHunk = 0;
    for (const line of file.rawLines) {
      const hunk = file.hunks[nextHunk];
      if (hunk && line === hunk.header) {
        lineCounter = hunk.newStart - 1;
        nextHunk++;
      }
      visit(line);
    }
  }

  return result.join('\n');
}

/**
 * Build a focused review context for re-review.
 *
 * Instead of passing the entire diff, build a summary of what
 * suggestions were applied and where, so the re-review LLM
 * can focus on validating those specific changes.
 *
 * @param patches - The patches that were applied
 * @returns Context string for the re-review prompt
 */
export function buildPatchContext(patches: SuggestionPatch[]): string {
  if (patches.length === 0) return '';

  const lines = ['## Applied Suggestions (validate these for regressions)', ''];

  for (const patch of patches) {
    lines.push(`- **${patch.file}${patch.line ? `:${patch.line}` : ''}**: ${patch.suggestion}`);
    lines.push(`  (Original issue: ${patch.originalMessage})`);
  }

  return lines.join('\n');
}
