/**
 * Unified diff parser — barrel.
 *
 * Wired consumers (adapters, migrated phase by phase under golden-corpus
 * parity gates): utils/diff.ts (Phase 3), recursive/patch-extractor.ts
 * (Phase 4), scope/diff-mapper.ts, scope/entity-diff.ts and
 * semantic-diff/index.ts (Phases 5–7). Not re-exported from core's
 * top-level index: consumers keep their historical public signatures.
 */

export { matchHunkHeader, parseUnifiedDiff } from './parse.js';
export type { DiffHunk, HunkLine, ParsedDiff, ParsedFileDiff } from './types.js';
