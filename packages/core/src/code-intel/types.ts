/**
 * Code Intelligence Types
 *
 * Defines the provider interface and data structures for
 * structural code queries via MCP (Model Context Protocol).
 * Follows the same injection pattern as GraphLoader.
 */

// ─── Symbol Reference ──────────────────────────────────────────

/** A reference to a symbol in a specific file. */
export interface SymbolReference {
  /** Relative file path */
  file: string;

  /** Symbol name (function, class, variable) */
  symbol: string;

  /** Line number in the file (if available) */
  line?: number;
}

// ─── Query Results ─────────────────────────────────────────────

/** Structural data for a single file gathered from the code intelligence server. */
export interface CodeIntelResult {
  /** The file these results relate to */
  file: string;

  /** Symbols in other files that call into this file's exports */
  callers: SymbolReference[];

  /** Symbols in other files that this file calls */
  callees: SymbolReference[];

  /** Files imported by this file */
  imports: string[];

  /** Symbols exported by this file */
  exports: string[];
}

// ─── Provider Interface ────────────────────────────────────────

/**
 * Abstract interface for code intelligence backends.
 *
 * Implementations connect to an MCP-compatible server (codedb, repoforge graph)
 * and translate responses into a uniform format.
 *
 * Injected into ReviewInput — when undefined, code intelligence is skipped.
 */
export interface CodeIntelProvider {
  /** Get symbols that call into a given symbol. */
  getCallers(symbol: string, file: string): Promise<SymbolReference[]>;

  /** Get symbols that a given symbol calls. */
  getCallees(symbol: string, file: string): Promise<SymbolReference[]>;

  /** Get the import list for a file. */
  getFileImports(file: string): Promise<string[]>;

  /** Get the export list for a file. */
  getFileExports(file: string): Promise<string[]>;
}

// ─── Metadata ──────────────────────────────────────────────────

/** Metadata about the code intelligence step, attached to ReviewResult. */
export interface CodeIntelMetadata {
  /** Whether code intelligence was enabled for this review */
  enabled: boolean;

  /** Whether a provider was available and responded */
  providerAvailable: boolean;

  /** Number of files queried */
  filesQueried: number;

  /** Number of files with structural data returned */
  filesWithData: number;

  /** Query duration in milliseconds */
  queryDurationMs: number;

  /** Reason for fallback (when provider failed) */
  fallbackReason?: string;
}
