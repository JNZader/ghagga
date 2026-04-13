import { describe, expect, it } from 'vitest';
import { SearchIndexer } from './indexer.js';
import { SearchEngine } from './searcher.js';
import type { SearchDocument } from './types.js';

// ─── Helpers ───────────────────────────────────────────────────

function makeDoc(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id: 'doc-1',
    content: 'placeholder content',
    source: 'review-comment',
    createdAt: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

function buildSearchEngine(docs: SearchDocument[]): SearchEngine {
  const indexer = new SearchIndexer();
  indexer.addDocuments(docs);
  return new SearchEngine(indexer);
}

// ─── Corpus for integration tests ──────────────────────────────

const CORPUS: SearchDocument[] = [
  makeDoc({
    id: 'review-1',
    content: 'Found a memory leak in the database connection pool. The connections are never released back when the query times out, causing pool exhaustion under load.',
    source: 'review-comment',
    prNumber: 42,
    createdAt: '2025-01-10T10:00:00Z',
  }),
  makeDoc({
    id: 'review-2',
    content: 'The authentication middleware does not properly validate JWT tokens. Missing expiration check allows expired tokens to be used indefinitely.',
    source: 'review-comment',
    prNumber: 43,
    createdAt: '2025-01-11T10:00:00Z',
  }),
  makeDoc({
    id: 'review-3',
    content: 'Race condition in the async event handler. Multiple concurrent requests modify shared state without synchronization, causing data corruption.',
    source: 'review-comment',
    prNumber: 44,
    createdAt: '2025-01-12T10:00:00Z',
  }),
  makeDoc({
    id: 'pr-desc-1',
    content: 'Fix connection pool memory leak by adding proper cleanup on timeout. Also adds connection health checks and idle connection pruning.',
    source: 'pr-description',
    prNumber: 45,
    createdAt: '2025-01-13T10:00:00Z',
  }),
  makeDoc({
    id: 'review-4',
    content: 'SQL injection vulnerability in the user search endpoint. User input is concatenated directly into the query string without parameterization.',
    source: 'review-comment',
    prNumber: 46,
    createdAt: '2025-01-14T10:00:00Z',
  }),
  makeDoc({
    id: 'review-5',
    content: 'The retry logic uses exponential backoff but has no jitter, causing thundering herd problems when the upstream service recovers.',
    source: 'review-comment',
    prNumber: 47,
    createdAt: '2025-01-15T10:00:00Z',
  }),
];

// ─── SearchEngine ──────────────────────────────────────────────

describe('SearchEngine', () => {
  it('returns empty array for empty query', () => {
    const engine = buildSearchEngine(CORPUS);
    expect(engine.search('')).toEqual([]);
  });

  it('returns empty array for query with only stop words', () => {
    const engine = buildSearchEngine(CORPUS);
    expect(engine.search('the a an is in')).toEqual([]);
  });

  it('returns empty array when index is empty', () => {
    const engine = buildSearchEngine([]);
    expect(engine.search('memory leak')).toEqual([]);
  });

  // ── Relevance tests ──────────────────────────────────────────

  it('finds documents matching "memory leak connection pool"', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('memory leak in connection pool');

    expect(results.length).toBeGreaterThan(0);

    // The two documents about connection pool memory leaks should rank highest
    const topIds = results.slice(0, 2).map((r) => r.document.id);
    expect(topIds).toContain('review-1');
    expect(topIds).toContain('pr-desc-1');
  });

  it('finds documents matching "JWT token authentication"', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('JWT token authentication');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.document.id).toBe('review-2');
  });

  it('finds documents matching "race condition async"', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('race condition async');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.document.id).toBe('review-3');
  });

  it('finds documents matching "SQL injection"', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('SQL injection vulnerability');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.document.id).toBe('review-4');
  });

  // ── Scoring properties ───────────────────────────────────────

  it('returns results sorted by score descending', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('memory leak pool');

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it('includes matched terms in results', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('memory leak');

    const first = results[0]!;
    expect(first.matchedTerms).toContain('memory');
    expect(first.matchedTerms).toContain('leak');
  });

  it('returns positive scores', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('connection pool');

    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
    }
  });

  // ── Options ──────────────────────────────────────────────────

  it('respects limit option', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('connection', { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters by source when specified', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('connection pool memory', { source: 'pr-description' });

    for (const result of results) {
      expect(result.document.source).toBe('pr-description');
    }
    // pr-desc-1 should be in the results
    expect(results.some((r) => r.document.id === 'pr-desc-1')).toBe(true);
  });

  it('excludes results below minScore', () => {
    const engine = buildSearchEngine(CORPUS);
    const allResults = engine.search('memory leak pool');
    const highScoreOnly = engine.search('memory leak pool', { minScore: 2.0 });

    expect(highScoreOnly.length).toBeLessThanOrEqual(allResults.length);
    for (const result of highScoreOnly) {
      expect(result.score).toBeGreaterThanOrEqual(2.0);
    }
  });

  // ── BM25 parameters ──────────────────────────────────────────

  it('accepts custom BM25 parameters', () => {
    const indexer = new SearchIndexer();
    indexer.addDocuments(CORPUS);

    const defaultEngine = new SearchEngine(indexer);
    const customEngine = new SearchEngine(indexer, { k1: 2.0, b: 0.5 });

    const defaultResults = defaultEngine.search('memory leak');
    const customResults = customEngine.search('memory leak');

    // Both should return results but potentially with different scores
    expect(defaultResults.length).toBeGreaterThan(0);
    expect(customResults.length).toBeGreaterThan(0);

    // The scores should differ due to different parameters
    // (unless the corpus is trivially small)
    if (defaultResults.length > 0 && customResults.length > 0) {
      expect(defaultResults[0]!.score).not.toBe(customResults[0]!.score);
    }
  });

  // ── Edge cases ───────────────────────────────────────────────

  it('handles query with no matching terms', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('xyzzyplugh quux');

    expect(results).toEqual([]);
  });

  it('handles single-term query', () => {
    const engine = buildSearchEngine(CORPUS);
    const results = engine.search('memory');

    expect(results.length).toBeGreaterThan(0);
  });

  it('handles documents with identical content', () => {
    const engine = buildSearchEngine([
      makeDoc({ id: 'dup-1', content: 'memory leak detected' }),
      makeDoc({ id: 'dup-2', content: 'memory leak detected' }),
    ]);

    const results = engine.search('memory leak');
    expect(results).toHaveLength(2);
  });
});
