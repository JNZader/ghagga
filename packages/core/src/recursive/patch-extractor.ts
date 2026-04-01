/**
 * Patch Extractor — extracts suggestion patches from review findings
 * and applies them virtually to produce a synthetic diff.
 *
 * No filesystem access — operates purely on diff strings.
 */

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
 * - For each file in the diff, collect patches targeting that file.
 * - Sort patches by line number descending (bottom-up) to avoid offset shifts.
 * - For each patch, find the target line in the diff's added lines (+)
 *   and append a comment showing the suggested replacement.
 *
 * The patched diff is a SYNTHETIC representation — it shows what the code
 * would look like if the suggestions were applied. This is NOT a real
 * git diff; it's a review-friendly format for the LLM to analyze.
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
  const lines = originalDiff.split('\n');
  const result: string[] = [];

  let currentFile: string | null = null;
  let currentFilePatches: SuggestionPatch[] = [];
  let lineCounter = 0; // Tracks the target-side line number in current hunk

  for (const line of lines) {
    // Detect file boundaries
    const fileMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1];
      currentFilePatches = patchesByFile.get(currentFile) ?? [];
      lineCounter = 0;
    }

    // Track hunk line numbers
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch?.[1]) {
      lineCounter = parseInt(hunkMatch[1], 10) - 1;
    }

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
