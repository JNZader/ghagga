/**
 * Unified diff parser — barrel.
 *
 * NOT yet wired to consumers nor re-exported from core's top-level index:
 * adapters in utils/diff.ts, recursive/patch-extractor.ts, scope/* and
 * semantic-diff/* migrate onto this module in later phases of the
 * unify-diff-parsers change (each phase gated by golden-corpus parity).
 */

export { parseUnifiedDiff } from './parse.js';
export type { DiffHunk, HunkLine, ParsedDiff, ParsedFileDiff } from './types.js';
