/**
 * Extractor Registry
 *
 * Maps SupportedLanguage to its regex-based extractor.
 * Used by the graph builder to select the right parser for each file.
 */

import type { SupportedLanguage } from '../schema.js';
import { goExtractor } from './go.js';
import { javaExtractor } from './java.js';
import { javascriptExtractor } from './javascript.js';
import { pythonExtractor } from './python.js';
import { rustExtractor } from './rust.js';
import type { Extractor } from './types.js';
import { typescriptExtractor } from './typescript.js';

// ─── Registry ───────────────────────────────────────────────────

const extractorRegistry: Record<SupportedLanguage, Extractor> = {
  typescript: typescriptExtractor,
  javascript: javascriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  java: javaExtractor,
  rust: rustExtractor,
};

/**
 * Get the extractor for a given language.
 * Returns undefined if the language is not supported (should never happen
 * since SupportedLanguage is a closed union).
 */
export function getExtractor(language: SupportedLanguage): Extractor {
  return extractorRegistry[language];
}

// ─── Re-exports ─────────────────────────────────────────────────

export { goExtractor } from './go.js';
export { javaExtractor } from './java.js';
export { javascriptExtractor } from './javascript.js';
export { pythonExtractor } from './python.js';
export { rustExtractor } from './rust.js';
export type { ExportInfo, Extractor, ImportInfo } from './types.js';
export { typescriptExtractor } from './typescript.js';
