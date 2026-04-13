/**
 * Semantic Search Module
 *
 * BM25-based search over historical review comments and PR descriptions.
 * Enables reviewers to query past reviews using natural language, e.g.,
 * "memory leak in connection pool" → finds related past findings.
 */

export type {
  BM25Params,
  IndexSnapshot,
  SearchDocument,
  SearchDocumentSource,
  SearchOptions,
  SearchResult,
  TermPosting,
  TermStats,
} from './types.js';

export { SearchIndexer, STOP_WORDS, tokenize } from './indexer.js';
export { SearchEngine } from './searcher.js';
