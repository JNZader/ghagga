/**
 * Doc-Validation module barrel export.
 *
 * Bidirectional code-doc validation that detects stale
 * documentation references when code symbols change.
 */

// ─── Types ────────────────────────────────────────────────────

export type { DocReference, DocValidationResult } from './types.js';

// ─── Scanner ──────────────────────────────────────────────────

export { extractChangedSymbols, isDocFile, scanDocsForSymbols } from './scanner.js';
