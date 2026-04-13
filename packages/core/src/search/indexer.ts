/**
 * Search Indexer — builds and maintains an inverted index for BM25 search.
 *
 * Tokenizes documents, builds an inverted index with positional data,
 * and supports incremental indexing (add/remove documents).
 * No external dependencies — pure TypeScript implementation.
 */

import type { IndexSnapshot, SearchDocument, TermPosting, TermStats } from './types.js';

// ─── Tokenizer ─────────────────────────────────────────────────

/**
 * Common English stop words to exclude from indexing.
 * Keeps the index lean and improves search relevance.
 */
export const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
  'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of',
  'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'will', 'with',
]);

/** Minimum token length to index. */
const MIN_TOKEN_LENGTH = 2;

/**
 * Tokenize text into lowercase terms, filtering stop words and short tokens.
 *
 * @param text - Raw text to tokenize.
 * @returns Array of normalized tokens in order of appearance.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token));
}

// ─── SearchIndexer ─────────────────────────────────────────────

export class SearchIndexer {
  /** Inverted index: term -> posting list with positions. */
  private terms = new Map<string, TermStats>();

  /** Per-document term counts for BM25 length normalization. */
  private docLengths = new Map<string, number>();

  /** Stored documents for retrieval. */
  private documents = new Map<string, SearchDocument>();

  /** Running sum of all document lengths for avgDocLength. */
  private totalTerms = 0;

  // ── Public API ──────────────────────────────────────────────

  /** Number of indexed documents. */
  get totalDocs(): number {
    return this.documents.size;
  }

  /** Average document length in terms. Returns 0 when empty. */
  get avgDocLength(): number {
    return this.documents.size === 0 ? 0 : this.totalTerms / this.documents.size;
  }

  /**
   * Index a single document.
   * If the document ID already exists, it is replaced (remove + add).
   */
  addDocument(doc: SearchDocument): void {
    // Replace if exists
    if (this.documents.has(doc.id)) {
      this.removeDocument(doc.id);
    }

    this.documents.set(doc.id, doc);

    const tokens = tokenize(doc.content);
    this.docLengths.set(doc.id, tokens.length);
    this.totalTerms += tokens.length;

    // Build term frequency and position maps for this document
    const termPositions = new Map<string, number[]>();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const positions = termPositions.get(token);
      if (positions) {
        positions.push(i);
      } else {
        termPositions.set(token, [i]);
      }
    }

    // Update the inverted index
    for (const [term, positions] of termPositions) {
      const posting: TermPosting = {
        docId: doc.id,
        tf: positions.length,
        positions,
      };

      const existing = this.terms.get(term);
      if (existing) {
        existing.df += 1;
        existing.postings.push(posting);
      } else {
        this.terms.set(term, { df: 1, postings: [posting] });
      }
    }
  }

  /**
   * Index multiple documents at once.
   */
  addDocuments(docs: SearchDocument[]): void {
    for (const doc of docs) {
      this.addDocument(doc);
    }
  }

  /**
   * Remove a document from the index by ID.
   * Returns true if the document was found and removed.
   */
  removeDocument(docId: string): boolean {
    const doc = this.documents.get(docId);
    if (!doc) return false;

    const docLength = this.docLengths.get(docId) ?? 0;
    this.totalTerms -= docLength;
    this.docLengths.delete(docId);
    this.documents.delete(docId);

    // Remove postings for this document from every term
    for (const [term, stats] of this.terms) {
      const idx = stats.postings.findIndex((p) => p.docId === docId);
      if (idx !== -1) {
        stats.postings.splice(idx, 1);
        stats.df -= 1;

        // Clean up empty term entries
        if (stats.postings.length === 0) {
          this.terms.delete(term);
        }
      }
    }

    return true;
  }

  /** Check if a document ID is already indexed. */
  hasDocument(docId: string): boolean {
    return this.documents.has(docId);
  }

  /** Get a stored document by ID. */
  getDocument(docId: string): SearchDocument | undefined {
    return this.documents.get(docId);
  }

  // ── Snapshot (serialization) ─────────────────────────────────

  /**
   * Export the full index as a JSON-serializable snapshot.
   * Use this for persistence (save to disk / SQLite / etc.).
   */
  toSnapshot(): IndexSnapshot {
    const termsObj: Record<string, TermStats> = {};
    for (const [term, stats] of this.terms) {
      termsObj[term] = stats;
    }

    const docLengthsObj: Record<string, number> = {};
    for (const [docId, length] of this.docLengths) {
      docLengthsObj[docId] = length;
    }

    const documentsObj: Record<string, SearchDocument> = {};
    for (const [docId, doc] of this.documents) {
      documentsObj[docId] = doc;
    }

    return {
      version: 1,
      totalDocs: this.documents.size,
      avgDocLength: this.avgDocLength,
      docLengths: docLengthsObj,
      terms: termsObj,
      documents: documentsObj,
    };
  }

  /**
   * Restore the index from a snapshot.
   * Clears any existing state before loading.
   */
  static fromSnapshot(snapshot: IndexSnapshot): SearchIndexer {
    const indexer = new SearchIndexer();

    for (const [term, stats] of Object.entries(snapshot.terms)) {
      indexer.terms.set(term, stats);
    }

    for (const [docId, length] of Object.entries(snapshot.docLengths)) {
      indexer.docLengths.set(docId, length);
    }

    for (const [docId, doc] of Object.entries(snapshot.documents)) {
      indexer.documents.set(docId, doc);
    }

    // Recompute totalTerms from docLengths
    indexer.totalTerms = 0;
    for (const length of indexer.docLengths.values()) {
      indexer.totalTerms += length;
    }

    return indexer;
  }

  // ── Internal accessors (used by SearchEngine) ────────────────

  /** Get term stats from the inverted index. */
  getTermStats(term: string): TermStats | undefined {
    return this.terms.get(term);
  }

  /** Get the term count for a specific document. */
  getDocLength(docId: string): number {
    return this.docLengths.get(docId) ?? 0;
  }
}
