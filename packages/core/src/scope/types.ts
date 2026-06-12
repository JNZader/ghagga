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

// ─── Entity Change Types ──────────────────────────────────────

/** Classification of how an entity was changed. */
export const ENTITY_CHANGE_KIND = {
  COSMETIC: 'cosmetic',
  LOGIC: 'logic',
  RENAMED: 'renamed',
} as const;

export type EntityChangeKind = (typeof ENTITY_CHANGE_KIND)[keyof typeof ENTITY_CHANGE_KIND];

/** An entity with its classified change type and relevant diff lines. */
export interface EntityChange {
  /** The affected symbol */
  symbol: SymbolInfo;

  /** Classification of the change */
  kind: EntityChangeKind;

  /** Raw diff lines (+/-) within this entity's range */
  diffLines: string[];
}

/** A detected rename: old name removed, new name added, body similar. */
export interface RenameMatch {
  /** Original entity name */
  oldName: string;

  /** New entity name */
  newName: string;

  /** Body similarity ratio (0.0–1.0) */
  similarity: number;

  /** The new symbol (post-rename) */
  symbol: SymbolInfo;
}

/** Options for entity diff classification. */
export interface EntityDiffOptions {
  /** Minimum body similarity to consider a rename (0.0–1.0). Default: 0.9 */
  similarityThreshold?: number;

  /**
   * Total LCS dynamic-programming cell budget (n*m per compared pair of
   * normalized bodies) for one `detectRenames` call. Once exhausted,
   * remaining pairs are treated as not similar (no rename) instead of
   * running the O(n*m) DP — bounds CPU on pathological diffs with many
   * large removed/added bodies. Identity matches and pairs resolved by
   * the cheap prefilter consume no budget. Default: 200_000_000
   * (~low single-digit seconds worst case).
   */
  lcsDpCellBudget?: number;
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
