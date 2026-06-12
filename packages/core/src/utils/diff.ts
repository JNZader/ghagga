/**
 * Unified diff parsing utilities.
 *
 * Provides functions to extract structured file information from unified
 * diffs, filter out ignored files (e.g., lockfiles, docs), and truncate
 * large diffs to fit within LLM token budgets.
 */

import { minimatch } from 'minimatch';
import { parseUnifiedDiff } from '../diff/index.js';
import { applyPathProtection } from './path-protection.js';

// ─── Types ──────────────────────────────────────────────────────

/** Represents a single file extracted from a unified diff. */
export interface DiffFile {
  /** File path relative to the repository root */
  path: string;

  /** Number of added lines */
  additions: number;

  /** Number of deleted lines */
  deletions: number;

  /** Raw diff content for this file (including headers and hunks) */
  content: string;
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Parse a unified diff string into structured file objects.
 *
 * Thin adapter over the unified parser (`src/diff/parse.ts`). The contract
 * is parity with the historical line-splitting implementation (gated by
 * `diff/__tests__/parity-parse-diff-files.test.ts`):
 *
 *  - `content` is rebuilt from the file's `rawLines` — the EXACT slice of the
 *    input section (header line through the line before the next header),
 *    so `rawLines.join('\n')` is byte-identical to the historical
 *    accumulate-and-join, CRLF and trailing empty line included.
 *  - `additions`/`deletions` use the exact historical predicate over
 *    rawLines (`startsWith('+') && !startsWith('+++')`), NOT the structured
 *    hunks — parity on malformed input where hunks never form (C11/C12).
 *  - `path` parity holds for WELL-FORMED diffs (git/GitHub output, where the
 *    `diff --git ... b/X` capture always equals the `+++ b/X` line). On
 *    MALFORMED sections where they disagree, path authority is the new
 *    parser's: `+++ b/` → `rename to` → header b-side (the baseline trusted
 *    the header regex). Documented divergence, asserted both-sides in the
 *    parity harness (`adv-header-b-mismatch`).
 *  - Documented delta (CORE-M6, changelog): quoted paths
 *    (`diff --git "a/caf\303\251.ts" ...`, core.quotepath escapes, including
 *    consecutive quoted sections and mixed-quoted headers) are now parsed
 *    and unescaped. Previously the file was silently dropped and its diff
 *    lines were absorbed by the preceding file's `content`.
 *
 * @param diff - Full unified diff string
 * @returns Array of DiffFile objects
 */
export function parseDiffFiles(diff: string): DiffFile[] {
  return parseUnifiedDiff(diff).files.map((file) => {
    let additions = 0;
    let deletions = 0;
    for (const line of file.rawLines) {
      // Count additions and deletions (skip hunk headers and --- / +++ lines)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    return {
      path: file.path,
      additions,
      deletions,
      content: file.rawLines.join('\n'),
    };
  });
}

/**
 * Filter out files matching ignore patterns (e.g., lockfiles, docs).
 *
 * Uses minimatch for glob pattern matching, consistent with .gitignore style.
 *
 * @param files - Array of DiffFile objects to filter
 * @param patterns - Glob patterns to exclude (e.g., ["*.md", "*.lock"])
 * @returns Filtered array with ignored files removed
 */
export function filterIgnoredFiles(files: DiffFile[], patterns: string[]): DiffFile[] {
  if (patterns.length === 0) return files;

  return files.filter((file) => {
    // Keep the file if it does NOT match any ignore pattern
    return !patterns.some((pattern) => minimatch(file.path, pattern, { dot: true }));
  });
}

// ─── Three-Tier Filtering ───────────────────────────────────────

/**
 * Result of applying all three filtering tiers to diff files.
 */
export interface FilterDiffResult {
  /** Files that passed all tiers — ready for LLM review. */
  filtered: DiffFile[];

  /** File paths blocked by ZERO_ACCESS tier (for logging). */
  blocked: string[];

  /** File paths redacted by REDACT tier (for logging). */
  redacted: string[];
}

/**
 * Apply all three tiers of file filtering in order:
 *   1. ZERO_ACCESS — hardcoded security patterns (blocked entirely)
 *   2. REDACT — sensitive templates (content replaced, path visible)
 *   3. User ignorePatterns — configurable exclusions
 *
 * This is the recommended entry point for the pipeline. It applies
 * non-overridable security filtering before user-configurable patterns.
 *
 * @param files - Array of DiffFile objects from the parsed diff
 * @param ignorePatterns - User-configurable glob patterns to exclude
 * @returns Object with filtered files, blocked paths, and redacted paths
 */
export function filterDiffFiles(files: DiffFile[], ignorePatterns: string[]): FilterDiffResult {
  // Tier 1 & 2: Security filtering (non-overridable)
  const { allowed, redacted, blocked } = applyPathProtection(files);

  // Tier 3: User ignore patterns (applied to allowed files only)
  const userFiltered = filterIgnoredFiles(allowed, ignorePatterns);

  // Combine user-filtered files with redacted files for final output
  const filtered = [...userFiltered, ...redacted];

  return {
    filtered,
    blocked,
    redacted: redacted.map((f) => f.path),
  };
}

// ─── Truncation ─────────────────────────────────────────────────

/**
 * Truncate a diff string to fit within a token budget.
 *
 * Uses a rough approximation of 1 token ≈ 4 characters, which is
 * a reasonable middle ground across different LLM tokenizers.
 *
 * @param diff - The diff string to truncate
 * @param maxTokens - Maximum number of tokens allowed
 * @returns Object with the (possibly truncated) diff and a flag indicating truncation
 */
export function truncateDiff(
  diff: string,
  maxTokens: number,
): { truncated: string; wasTruncated: boolean } {
  const maxChars = maxTokens * 4;

  if (diff.length <= maxChars) {
    return { truncated: diff, wasTruncated: false };
  }

  // Truncate at the character limit, then trim to the last complete line
  const cutoff = diff.lastIndexOf('\n', maxChars);
  const truncated =
    (cutoff > 0 ? diff.slice(0, cutoff) : diff.slice(0, maxChars)) +
    '\n\n[... diff truncated to fit token budget ...]';

  return { truncated, wasTruncated: true };
}
