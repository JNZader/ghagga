/**
 * Search Engine — BM25 ranked retrieval over the inverted index.
 *
 * Implements the Okapi BM25 scoring function for ranking documents
 * by relevance to a free-text query. No external dependencies.
 *
 * BM25 formula:
 *   score(D, Q) = SUM_i IDF(qi) * (tf(qi, D) * (k1 + 1)) / (tf(qi, D) + k1 * (1 - b + b * |D| / avgdl))
 *
 * Where:
 *   - IDF(qi) = ln((N - df(qi) + 0.5) / (df(qi) + 0.5) + 1)
 *   - tf(qi, D) = frequency of term qi in document D
 *   - |D| = document length in terms
 *   - avgdl = average document length
 *   - k1 = term frequency saturation (default 1.2)
 *   - b = document length normalization (default 0.75)
 */

import type { SearchIndexer } from './indexer.js';
import { tokenize } from './indexer.js';
import type { BM25Params, SearchOptions, SearchResult } from './types.js';

// ─── Default BM25 Parameters ──────────────────────────────────

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

// ─── SearchEngine ──────────────────────────────────────────────

export class SearchEngine {
  private indexer: SearchIndexer;
  private k1: number;
  private b: number;

  constructor(indexer: SearchIndexer, params: BM25Params = {}) {
    this.indexer = indexer;
    this.k1 = params.k1 ?? DEFAULT_K1;
    this.b = params.b ?? DEFAULT_B;
  }

  /**
   * Search the index with a free-text query using BM25 scoring.
   *
   * @param query - Natural language search query (e.g., "memory leak in connection pool").
   * @param options - Search options (limit, source filter, min score).
   * @returns Ranked array of search results, highest score first.
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 10, source, minScore = 0 } = options;

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const totalDocs = this.indexer.totalDocs;
    if (totalDocs === 0) return [];

    const avgDocLength = this.indexer.avgDocLength;

    // Collect scores for each document that matches at least one query term
    const docScores = new Map<string, { score: number; matchedTerms: Set<string> }>();

    for (const term of queryTerms) {
      const termStats = this.indexer.getTermStats(term);
      if (!termStats) continue;

      // IDF: inverse document frequency with BM25 smoothing
      const idf = Math.log((totalDocs - termStats.df + 0.5) / (termStats.df + 0.5) + 1);

      for (const posting of termStats.postings) {
        const docLength = this.indexer.getDocLength(posting.docId);

        // BM25 term score
        const tfNorm =
          (posting.tf * (this.k1 + 1)) /
          (posting.tf + this.k1 * (1 - this.b + this.b * (docLength / avgDocLength)));

        const termScore = idf * tfNorm;

        const existing = docScores.get(posting.docId);
        if (existing) {
          existing.score += termScore;
          existing.matchedTerms.add(term);
        } else {
          docScores.set(posting.docId, {
            score: termScore,
            matchedTerms: new Set([term]),
          });
        }
      }
    }

    // Build results, applying filters
    const results: SearchResult[] = [];
    for (const [docId, { score, matchedTerms }] of docScores) {
      if (score < minScore) continue;

      const document = this.indexer.getDocument(docId);
      if (!document) continue;

      if (source && document.source !== source) continue;

      results.push({
        document,
        score,
        matchedTerms: [...matchedTerms],
      });
    }

    // Sort by score descending, then by recency (newer first) as tiebreaker
    results.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      return b.document.createdAt.localeCompare(a.document.createdAt);
    });

    return results.slice(0, limit);
  }
}
