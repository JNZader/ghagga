/**
 * Semantic Search Types
 *
 * Types for searching over historical review comments and PR descriptions.
 * Uses BM25 text scoring — no external embedding dependencies required.
 */

// ─── Document Types ────────────────────────────────────────────

/** A searchable document representing a review comment or PR description. */
export interface SearchDocument {
  /** Unique identifier for this document. */
  id: string;

  /** The full text content to index and search. */
  content: string;

  /** Source of the document (review comment, PR description, etc.). */
  source: SearchDocumentSource;

  /** Associated PR number, if applicable. */
  prNumber?: number;

  /** File paths related to this document. */
  filePaths?: string[];

  /** ISO timestamp when the document was created. */
  createdAt: string;

  /** Optional metadata for filtering or display. */
  metadata?: Record<string, unknown>;
}

export type SearchDocumentSource = 'review-comment' | 'pr-description' | 'review-summary';

// ─── Index Types ───────────────────────────────────────────────

/** A single term entry in the inverted index. */
export interface TermPosting {
  /** Document ID. */
  docId: string;

  /** Term frequency in this document. */
  tf: number;

  /** Positions of the term in the document (for phrase queries). */
  positions: number[];
}

/** Statistics for a single term across the corpus. */
export interface TermStats {
  /** Number of documents containing this term (document frequency). */
  df: number;

  /** Postings list for this term. */
  postings: TermPosting[];
}

/** Serializable snapshot of the inverted index. */
export interface IndexSnapshot {
  /** Version tag for forward-compatible deserialization. */
  version: 1;

  /** Total number of indexed documents. */
  totalDocs: number;

  /** Average document length (in terms). */
  avgDocLength: number;

  /** Per-document term counts (docId -> number of terms). */
  docLengths: Record<string, number>;

  /** The inverted index: term -> stats. */
  terms: Record<string, TermStats>;

  /** Stored documents for retrieval. */
  documents: Record<string, SearchDocument>;
}

// ─── Search Types ──────────────────────────────────────────────

/** A single search result with its relevance score. */
export interface SearchResult {
  /** The matched document. */
  document: SearchDocument;

  /** BM25 relevance score (higher = more relevant). */
  score: number;

  /** Matched terms from the query that appeared in this document. */
  matchedTerms: string[];
}

/** Options for configuring search behavior. */
export interface SearchOptions {
  /** Maximum number of results to return. Defaults to 10. */
  limit?: number;

  /** Filter results by document source. */
  source?: SearchDocumentSource;

  /** Minimum BM25 score threshold. Results below this are excluded. Defaults to 0. */
  minScore?: number;
}

/** BM25 tuning parameters. */
export interface BM25Params {
  /** Term frequency saturation parameter. Higher values give more weight to term frequency. Defaults to 1.2. */
  k1?: number;

  /** Document length normalization parameter (0 = no normalization, 1 = full). Defaults to 0.75. */
  b?: number;
}
