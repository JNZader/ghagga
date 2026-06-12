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
 * Result of applying virtual patches: the synthetic diff plus the OUT-OF-BAND
 * record of which output lines are injected `[SUGGESTED FIX]` markers.
 *
 * `injectedLineIndices` holds 0-based indices into `diff.split('\n')`. Identity
 * comes from "the walker put it there" — recorded at the injection site — NOT
 * from scanning the `[SUGGESTED FIX]` text prefix, which would collide with any
 * genuine source line beginning `[SUGGESTED FIX]`. Collision-immune by
 * construction.
 */
export interface VirtualPatchResult {
  /** The synthetic diff string (the historical return value). */
  diff: string;
  /** 0-based indices into `diff.split('\n')` that are injected markers. */
  injectedLineIndices: number[];
}

/** Hunk-header grammar: `@@ -oldStart,oldCount +newStart,newCount @@ <suffix>`. */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Rebuild a hunk header from the old-side captures (verbatim), the corrected
 * new-side start/count, and the verbatim section-heading suffix preserved from
 * the original header. `oldStart`/`oldCount` are NEVER touched — a marker is a
 * pure NEW-SIDE addition, so the old (pre-image) accounting is unchanged.
 *
 * Mirrors git's unified-diff convention: a count of 1 MAY be omitted, but to
 * stay byte-stable we re-emit exactly the shape the original used (we only
 * rewrite the numbers that changed). When the original omitted a count, we keep
 * it omitted unless the corrected count is no longer 1.
 */
function rebuildHunkHeader(
  oldStart: string,
  oldCount: string | undefined,
  newStart: number,
  newCount: number,
  newCountOmitted: boolean,
  suffix: string,
): string {
  const oldPart = oldCount === undefined ? `-${oldStart}` : `-${oldStart},${oldCount}`;
  const newPart = newCountOmitted && newCount === 1 ? `+${newStart}` : `+${newStart},${newCount}`;
  return `@@ ${oldPart} ${newPart} @@${suffix}`;
}

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
 * COORDINATE CONTRACT (Design B — recursive-coordinate-contract):
 * the synthetic diff is a VALID unified diff. When a marker is injected, the
 * hunk's `newCount` is incremented and every LATER hunk in the SAME file gets
 * its `newStart` shifted by the markers injected above it, so the declared
 * `@@ +N` tells the truth: physical position == declared `@@ +N` == real
 * new-file line == whatever any sane LLM reports. On iteration 2+ the marker is
 * therefore a REAL counted `+` line (its position is already reflected in later
 * headers), which is why later patches no longer drift (the off-by-N is closed).
 *
 * Marker IDENTITY is tracked OUT-OF-BAND: the output index of each injected
 * marker is recorded at the injection site (`injectedLineIndices`), never by
 * scanning the `[SUGGESTED FIX]` text — collision-immune by construction.
 *
 * ⚠️ STILL-FROZEN LEGACY BEHAVIOR (spec R7) — the renumber ONLY touches the
 * marker path; everything else reproduces the historical accounting, bugs
 * included. Do NOT "fix" any of these here (separate tickets):
 * - Quoted headers (`diff --git "a/x" "b/y"`, core.quotepath) are NOT
 *   recognized as file boundaries: the previous file's patch scope + line
 *   counter keep running through the quoted section (`headerQuoted` gate
 *   below). A marker can still land there if a leaked counter coincides with a
 *   leaked patch line — frozen legacy behavior, pinned by the parity suite.
 * - The counter counts metadata lines its exclusion list never covered
 *   (`similarity index`, `rename from/to`, `Binary files`, `new file mode`,
 *   mode lines) and genuine empty lines. That is why counting walks `rawLines`
 *   (every input line), NOT `hunks`.
 * - The file-boundary path authority is the `diff --git` header b-side
 *   capture (`headerNewPath`), NOT the `+++ b/` / `rename to` resolved `path`.
 * - Patches without a `line` never match the counter and are silently dropped.
 * The only INTENTIONAL behavior change vs the pre-Design-B walker is the
 * marker path: hunk headers are now renumbered and markers count on iteration
 * 2+. The non-recursive divergences (loose-hunk-header, mixed-quoted-malformed,
 * partial-@@) are unaffected and stay pinned in
 * diff/__tests__/parity-apply-virtual-patches.test.ts.
 *
 * @param originalDiff - The original unified diff string
 * @param patches - Suggestion patches to apply
 * @returns `VirtualPatchResult` — the synthetic diff plus injected marker indices
 */
export function applyVirtualPatches(
  originalDiff: string,
  patches: SuggestionPatch[],
): VirtualPatchResult {
  if (patches.length === 0) return { diff: originalDiff, injectedLineIndices: [] };

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
  const injectedLineIndices: number[] = [];

  let currentFile: string | null = null;
  let currentFilePatches: SuggestionPatch[] = [];
  let lineCounter = 0; // Tracks the target-side line number in current hunk

  // Inject every `+[SUGGESTED FIX]` marker whose patch `line` matches the given
  // counter value, recording each marker's output index out-of-band. Mirrors the
  // legacy walker's post-line patch-match (which ran after EVERY emitted line,
  // header included). Returns the number of markers injected.
  const injectAfter = (counter: number): number => {
    if (!currentFile || currentFilePatches.length === 0) return 0;
    let injected = 0;
    for (const patch of currentFilePatches.filter((p) => p.line === counter)) {
      // Record the index BEFORE pushing — identity is positional, not textual.
      injectedLineIndices.push(result.length);
      result.push(`+[SUGGESTED FIX] ${patch.suggestion}`);
      injected++;
    }
    return injected;
  };

  // Emit one input line, advancing the counter and injecting any matching
  // `+[SUGGESTED FIX]` markers after it. Returns the number of markers injected
  // (so the per-hunk renumber pass can tally `markersInThisHunk`). The injected
  // marker's output index is recorded out-of-band in `injectedLineIndices`.
  const visit = (line: string): number => {
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
    return injectAfter(lineCounter);
  };

  for (const line of parsed.preamble) visit(line);

  for (const file of parsed.files) {
    // File boundary — legacy gate: quoted headers were never recognized, so
    // the previous file's patch scope and counter deliberately leak into
    // this section (see STILL-FROZEN LEGACY BEHAVIOR above). `injectedBefore`
    // is declared per parsed file section (below), so the header-shift math
    // never crosses a file boundary. NOTE: for a quoted-header section the
    // leaked `currentFilePatches` CAN still cause a marker to be injected if a
    // leaked counter value coincides with a leaked patch line — the renumber
    // then runs on that section's hunks like any other. That coincidence is
    // frozen legacy behavior (spec R7), not a guarantee that quoted sections
    // never get markers; the parity/golden suites pin whatever it produces.
    if (!file.headerQuoted) {
      currentFile = file.headerNewPath;
      currentFilePatches = patchesByFile.get(currentFile) ?? [];
      lineCounter = 0;
    }
    let injectedBefore = 0; // markers injected in EARLIER hunks of THIS file

    // Hunk headers reset the counter to the new-side start AND are rewritten so
    // the declared `@@ +N` accounts for markers injected above (Design B).
    //
    // The reset scan keys on STRING-EQUALITY `line === hunk.header`. We rewrite
    // both the emitted string AND `hunk.header` (in lockstep) so the scan keeps
    // pairing the i-th rawLines occurrence with hunks[i]. The new-side start is
    // shifted by `injectedBefore`; the counter then resets to the shifted start
    // minus 1 — still correct because the markers sit INSIDE already-counted
    // earlier hunks, never double-counted across the boundary.
    let nextHunk = 0;
    for (let rawIdx = 0; rawIdx < file.rawLines.length; rawIdx++) {
      const line = file.rawLines[rawIdx] ?? '';
      const hunk = file.hunks[nextHunk];
      if (hunk && line === hunk.header) {
        const m = HUNK_HEADER_RE.exec(hunk.header);
        if (m?.[1] && m?.[3]) {
          const oldStart = m[1];
          const oldCount = m[2]; // may be undefined (omitted → 1)
          const newCountOmitted = m[4] === undefined;
          const suffix = m[5] ?? '';
          const markersInThisHunk = countMarkersInHunk(
            file.rawLines,
            rawIdx,
            file.hunks[nextHunk + 1]?.header,
            currentFilePatches,
            hunk.newStart,
          );
          const newStartShifted = hunk.newStart + injectedBefore;
          const newCountShifted = hunk.newCount + markersInThisHunk;
          const rewritten = rebuildHunkHeader(
            oldStart,
            oldCount,
            newStartShifted,
            newCountShifted,
            newCountOmitted,
            suffix,
          );
          // Keep model and emitted string in sync for the string-eq scan.
          hunk.header = rewritten;
          // CRITICAL coordinate frame: `lineCounter` is matched against patch
          // `line` values, which reference the CURRENT diff's new-side line
          // numbers — i.e. the UNSHIFTED coordinates the LLM numbered against.
          // The `injectedBefore` shift belongs ONLY to the emitted header, not
          // to the matching counter. Resetting to the shifted start would move
          // every patch match in this hunk by `injectedBefore` lines (wrong
          // landing + duplicate/missed injections). `countMarkersInHunk` uses
          // the same unshifted anchor, so the precomputed tally agrees with
          // what `visit` actually injects.
          lineCounter = hunk.newStart - 1;
          result.push(rewritten);
          // LEGACY-FAITHFUL header-position injection: the old walker ran its
          // patch-match check after EVERY line, the `@@` header included, with
          // the counter already reset to `newStart - 1`. So a patch whose `line`
          // equals `newStart - 1` injects a marker IMMEDIATELY after the header.
          // We must reproduce that (it is frozen R7 behavior, NOT the renumber
          // change) — `countMarkersInHunk` likewise counts this header-position
          // match, so it is already budgeted into `markersInThisHunk` above.
          injectAfter(lineCounter);
          nextHunk++;
          injectedBefore += markersInThisHunk;
          continue;
        }
        // Header didn't match the strict grammar — fall back to legacy reset.
        // The `visit(line)` below then pushes the header (no counter increment —
        // it starts with `@@`) and runs the header-position patch-match at the
        // reset counter, exactly as the legacy flat loop did.
        lineCounter = hunk.newStart - 1;
        nextHunk++;
      }
      visit(line);
    }
  }

  return { diff: result.join('\n'), injectedLineIndices };
}

/**
 * Count how many markers a hunk will receive, WITHOUT mutating output. Replays
 * the same counter logic `visit` uses over just this hunk's body lines (from
 * `headerPos + 1` up to the next header / file end), so the per-hunk `newCount`
 * bump is known BEFORE the header is emitted. `headerPos` is the EXACT rawLines
 * index of this hunk's header (handed in by the main loop), so duplicate
 * identical headers are paired correctly — no `indexOf` re-scan.
 */
function countMarkersInHunk(
  rawLines: string[],
  headerPos: number,
  nextHeader: string | undefined,
  filePatches: SuggestionPatch[],
  newStart: number,
): number {
  if (filePatches.length === 0) return 0;

  let counter = newStart - 1;
  // Header-position match: the legacy walker ran its patch-match after the `@@`
  // header line with the counter already at `newStart - 1`, so a patch at that
  // line injects a marker INSIDE this hunk. `injectAfter(newStart - 1)` in the
  // main loop reproduces it; budget it here so `newCount` accounts for it.
  let markers = filePatches.filter((p) => p.line === counter).length;
  for (let i = headerPos + 1; i < rawLines.length; i++) {
    const line = rawLines[i] ?? '';
    if (nextHeader !== undefined && line === nextHeader) break;
    // Counter advance: MUST mirror `visit` exactly (additions + context lines
    // increment; removals and meta lines do not).
    if (line.startsWith('+') && !line.startsWith('+++')) {
      counter++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // removal — no advance
    } else if (
      !line.startsWith('\\') &&
      !line.startsWith('diff ') &&
      !line.startsWith('index ') &&
      !line.startsWith('---') &&
      !line.startsWith('+++') &&
      !line.startsWith('@@')
    ) {
      counter++;
    }
    // Patch-match check: ALSO mirror `visit` — it runs after EVERY emitted line
    // (outside the counter branch), including removals and meta lines, with the
    // unchanged counter. Do NOT skip meta lines here, or the tally would
    // under-count vs what `visit` injects (e.g. a patch landing where a
    // `\ No newline at end of file` line sits).
    markers += filePatches.filter((p) => p.line === counter).length;
  }
  return markers;
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
