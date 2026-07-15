/**
 * Extractor Types
 *
 * Shared interfaces for language-specific import/export extractors.
 * Extractors are pure functions that parse file content using regex
 * patterns — no native dependencies (no tree-sitter).
 */

import type { SupportedLanguage } from '../schema.js';

// ─── Extracted Data ─────────────────────────────────────────────

export interface ImportInfo {
  /** Module path (e.g., './utils', 'lodash', 'fmt') */
  source: string;

  /** Imported symbol names (empty array for namespace/default imports) */
  symbols: string[];
}

export interface ExportInfo {
  /** Exported symbol name (sentinel `'*'` for wildcard re-exports) */
  name: string;

  /** Kind of export */
  kind: 'function' | 'class' | 'variable' | 'type' | 'default';

  /**
   * Present ⇒ this is a re-export (`export ... from './source'`), not a
   * locally-defined declaration. `source` is the raw (unresolved) module
   * specifier. Additive/optional — absent for genuine local exports.
   */
  source?: string;
}

// ─── Extractor Interface ────────────────────────────────────────

export interface Extractor {
  /** Language this extractor handles */
  language: SupportedLanguage;

  /** File extensions this extractor applies to (e.g., ['.ts', '.tsx']) */
  extensions: string[];

  /** Extract import statements from file content */
  extractImports(content: string): ImportInfo[];

  /** Extract export declarations from file content */
  extractExports(content: string): ExportInfo[];
}
