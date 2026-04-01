/**
 * Scope module barrel export.
 *
 * Tree-sitter based symbol-level scoping for code reviews.
 * Extracts symbol definitions, maps diff changes to affected symbols,
 * and builds focused review context.
 */

// ─── Types ─────────────────────────────────────────────────────

export type {
  AffectedSymbol,
  DiffHunk,
  ScopeLanguage,
  ScopedFile,
  SymbolInfo,
  SymbolKind,
} from './types.js';

// ─── Context Builder ───────────────────────────────────────────

export { buildScopedContext } from './context-builder.js';

// ─── Diff Mapper ───────────────────────────────────────────────

export { mapDiffToSymbols, parseHunks } from './diff-mapper.js';

// ─── Symbol Extractor ──────────────────────────────────────────

export { extractSymbolsFromTree } from './extractor.js';

// ─── Parser ────────────────────────────────────────────────────

export {
  initParser,
  loadLanguage,
  parseSource,
  resetParser,
  resolveGrammarPath,
} from './parser.js';
