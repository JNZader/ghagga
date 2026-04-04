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
  EntityChange,
  EntityChangeKind,
  EntityDiffOptions,
  RenameMatch,
  ScopedFile,
  ScopeLanguage,
  SymbolInfo,
  SymbolKind,
} from './types.js';

export { ENTITY_CHANGE_KIND } from './types.js';

// ─── Context Builder ───────────────────────────────────────────

export { buildScopedContext } from './context-builder.js';

// ─── Diff Mapper ───────────────────────────────────────────────

export { mapDiffToSymbols, parseHunks } from './diff-mapper.js';

// ─── Entity Diff ──────────────────────────────────────────────

export {
  classifyEntityChanges,
  detectRenames,
  extractEntityDiffLines,
  filterLogicChanges,
} from './entity-diff.js';

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
