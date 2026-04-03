/**
 * Doc-Validation Types
 *
 * Types for the bidirectional code-doc validation module.
 * Detects stale documentation references when code symbols change.
 */

// ─── Doc Reference ────────────────────────────────────────────

/** A reference to a code symbol found in a documentation file. */
export interface DocReference {
  /** Path to the documentation file */
  file: string;

  /** 1-based line number where the reference was found */
  line: number;

  /** The matched symbol name */
  symbol: string;

  /** Surrounding text snippet for context */
  context: string;
}

// ─── Validation Result ────────────────────────────────────────

/** Result of the code-doc validation step. */
export interface DocValidationResult {
  /** Symbol names extracted from the diff as changed */
  changedSymbols: string[];

  /** Doc references to changed symbols where the doc was NOT updated */
  staleReferences: DocReference[];

  /** Number of documentation files scanned */
  docsScanned: number;
}
