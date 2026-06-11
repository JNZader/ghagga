/**
 * Unified diff parser — type contracts.
 *
 * Single source of truth for parsed unified diffs in core. The model is
 * READ-ONLY: consumers reconstruct text exclusively from `preamble` and
 * `rawLines` slices (never by re-serializing the structured model), which is
 * what guarantees byte-exact reconstruction (spec R2):
 *
 *   [...preamble, ...files.flatMap((f) => f.rawLines)].join('\n') === raw
 *
 * OQ1 resolution (2026-06-11): `rawLines` is EAGER (plain string[] from the
 * input split), not lazy index ranges over a shared array. Measured with
 * --expose-gc (retained heap delta of keeping the full ParsedDiff alive):
 *   - golden corpus (16 fixtures, 8.6 KB, 338 lines)  →   88.6 KB retained
 *   - real repo diff (13.85 MB, 374,932 lines, 845 files) → 43.9 MB retained
 *     (~3.2x input, ~123 bytes/line: sliced strings + array slots + HunkLine)
 * No real memory pressure: review-scale diffs are truncated to token budgets
 * upstream (truncateDiff) long before reaching MB scale, and even the 14 MB
 * stress input stays far below Node heap defaults. Lazy indices would
 * complicate every consumer for no measurable win. Decision per task 2.4.
 */

/** A single line inside a hunk body. */
export interface HunkLine {
  /**
   * `+` addition, `-` deletion, ` ` context, `\` marker line
   * (`\ No newline at end of file`).
   */
  prefix: '+' | '-' | ' ' | '\\';

  /** Line content WITHOUT the prefix character. */
  content: string;

  /** The exact raw line, prefix included. */
  raw: string;
}

/** A hunk with the 4 captures of its `@@` header plus its body lines. */
export interface DiffHunk {
  /** 1-based start line on the old side (0 for pure additions). */
  oldStart: number;

  /** Line count on the old side. Omitted in the header → 1. */
  oldCount: number;

  /** 1-based start line on the new side (0 for pure deletions). */
  newStart: number;

  /** Line count on the new side. Omitted in the header → 1. */
  newCount: number;

  /** The raw `@@` header line, verbatim (includes any section heading). */
  header: string;

  /** Body lines attributed to this hunk (markers included). */
  lines: HunkLine[];
}

/** One file section of a unified diff. */
export interface ParsedFileDiff {
  /** Old path, unquoted/unescaped. `null` when `/dev/null` (new files). */
  oldPath: string | null;

  /** New path, unquoted/unescaped. `null` when `/dev/null` (deleted files). */
  newPath: string | null;

  /**
   * Resolved display path. Authority order: `+++ b/` (when not /dev/null) →
   * `rename to` → `diff --git` header capture → old path.
   */
  path: string;

  /** `new file mode` present. */
  isNew: boolean;

  /** `deleted file mode` present. */
  isDeleted: boolean;

  /** `rename from`/`rename to` present. */
  isRename: boolean;

  /** `Binary files … differ` or `GIT binary patch` present. */
  isBinary: boolean;

  /** From `old mode`/`deleted file mode` lines, when present. */
  oldMode?: string;

  /** From `new mode`/`new file mode` lines, when present. */
  newMode?: string;

  /** Structured hunks (empty for binary/mode-only/rename-only sections). */
  hunks: DiffHunk[];

  /**
   * The EXACT lines of this file section: from its `diff --git` header up to
   * (not including) the next file header. Metadata, garbage, truncation
   * markers and unparseable lines are all retained here even when they do not
   * contribute to `hunks`.
   */
  rawLines: string[];
}

/** A fully parsed unified diff. Defensive: ANY input produces a value. */
export interface ParsedDiff {
  /**
   * Lines before the first `diff --git` header (PR prose, ACP garbage,
   * whole non-diff inputs). Empty array when the input starts at a header.
   */
  preamble: string[];

  /** File sections in input order. Empty for non-diff or empty input. */
  files: ParsedFileDiff[];
}
