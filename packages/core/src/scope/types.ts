/**
 * Scope Module Types
 *
 * Defines the core data structures for tree-sitter based
 * symbol-level scoping of code reviews.
 */

// ─── Supported Languages ───────────────────────────────────────

/** Languages supported by the tree-sitter scope module. */
export type ScopeLanguage = 'typescript' | 'javascript' | 'python' | 'go';

// ─── Symbol Types ──────────────────────────────────────────────

/** Kind of symbol extracted from source code. */
export type SymbolKind = 'function' | 'class' | 'method' | 'interface';

/** A symbol definition extracted from source code via tree-sitter. */
export interface SymbolInfo {
  /** Symbol name (e.g., "reviewPipeline", "ReviewInput") */
  name: string;

  /** Kind of symbol */
  kind: SymbolKind;

  /** 1-based start line in the source file */
  startLine: number;

  /** 1-based end line in the source file */
  endLine: number;

  /** 0-based start byte offset */
  startByte: number;

  /** 0-based end byte offset */
  endByte: number;

  /** Parent symbol name (for methods inside classes) */
  parent?: string;
}

// ─── Diff Types ────────────────────────────────────────────────

/** A single hunk from a unified diff. */
export interface DiffHunk {
  /** 1-based start line in the OLD file */
  oldStart: number;

  /** Number of lines in the old side */
  oldCount: number;

  /** 1-based start line in the NEW file */
  newStart: number;

  /** Number of lines in the new side */
  newCount: number;
}

// ─── Affected Symbol Types ─────────────────────────────────────

/** A symbol that was affected by a diff change. */
export interface AffectedSymbol {
  /** The symbol that was affected */
  symbol: SymbolInfo;

  /** Which hunks overlap with this symbol */
  overlappingHunks: DiffHunk[];
}

// ─── Scoped Context Types ─────────────────────────────────────

/** A file with its affected symbols and source content, ready for scoped review. */
export interface ScopedFile {
  /** Path to the file (relative or absolute) */
  filePath: string;

  /** Symbols affected by the diff in this file */
  symbols: AffectedSymbol[];

  /** Full source lines of the file (split by newline) */
  sourceLines: string[];
}
