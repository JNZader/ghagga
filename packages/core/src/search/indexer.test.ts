import { describe, expect, it } from 'vitest';
import { SearchIndexer, STOP_WORDS, tokenize } from './indexer.js';
import type { SearchDocument } from './types.js';

// ─── Helpers ───────────────────────────────────────────────────

function makeDoc(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id: 'doc-1',
    content: 'memory leak in the connection pool causes timeouts',
    source: 'review-comment',
    createdAt: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

// ─── tokenize ──────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric characters', () => {
    const tokens = tokenize('Memory LEAK in Pool');
    expect(tokens).toContain('memory');
    expect(tokens).toContain('leak');
    expect(tokens).toContain('pool');
  });

  it('removes stop words', () => {
    const tokens = tokenize('the memory is in a pool');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('in');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('memory');
    expect(tokens).toContain('pool');
  });

  it('filters tokens shorter than 2 characters', () => {
    const tokens = tokenize('a b cd efg');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).toContain('cd');
    expect(tokens).toContain('efg');
  });

  it('handles empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles string with only stop words', () => {
    const tokens = tokenize('the a an is in');
    expect(tokens).toEqual([]);
  });

  it('preserves hyphens and underscores in tokens', () => {
    const tokens = tokenize('connection-pool memory_leak');
    expect(tokens).toContain('connection-pool');
    expect(tokens).toContain('memory_leak');
  });

  it('exports STOP_WORDS as a Set', () => {
    expect(STOP_WORDS).toBeInstanceOf(Set);
    expect(STOP_WORDS.has('the')).toBe(true);
    expect(STOP_WORDS.has('memory')).toBe(false);
  });
});

// ─── SearchIndexer ─────────────────────────────────────────────

describe('SearchIndexer', () => {
  it('starts empty', () => {
    const indexer = new SearchIndexer();
    expect(indexer.totalDocs).toBe(0);
    expect(indexer.avgDocLength).toBe(0);
  });

  it('indexes a single document', () => {
    const indexer = new SearchIndexer();
    indexer.addDocument(makeDoc());

    expect(indexer.totalDocs).toBe(1);
    expect(indexer.hasDocument('doc-1')).toBe(true);
    expect(indexer.avgDocLength).toBeGreaterThan(0);
  });

  it('indexes multiple documents', () => {
    const indexer = new SearchIndexer();
    indexer.addDocuments([
      makeDoc({ id: 'doc-1', content: 'memory leak detected' }),
      makeDoc({ id: 'doc-2', content: 'connection pool exhaustion' }),
      makeDoc({ id: 'doc-3', content: 'null pointer dereference' }),
    ]);

    expect(indexer.totalDocs).toBe(3);
  });

  it('replaces document when re-indexing same ID', () => {
    const indexer = new SearchIndexer();
    indexer.addDocument(makeDoc({ id: 'doc-1', content: 'old content' }));
    indexer.addDocument(makeDoc({ id: 'doc-1', content: 'new content entirely different' }));

    expect(indexer.totalDocs).toBe(1);
    const doc = indexer.getDocument('doc-1');
    expect(doc?.content).toBe('new content entirely different');
  });

  it('removes a document', () => {
    const indexer = new SearchIndexer();
    indexer.addDocument(makeDoc({ id: 'doc-1' }));
    indexer.addDocument(makeDoc({ id: 'doc-2', content: 'another review' }));

    const removed = indexer.removeDocument('doc-1');
    expect(removed).toBe(true);
    expect(indexer.totalDocs).toBe(1);
    expect(indexer.hasDocument('doc-1')).toBe(false);
  });

  it('returns false when removing non-existent document', () => {
    const indexer = new SearchIndexer();
    expect(indexer.removeDocument('nonexistent')).toBe(false);
  });

  it('builds correct term stats', () => {
    const indexer = new SearchIndexer();
    indexer.addDocument(makeDoc({ id: 'doc-1', content: 'memory leak memory overflow' }));

    const stats = indexer.getTermStats('memory');
    expect(stats).toBeDefined();
    expect(stats!.df).toBe(1);
    expect(stats!.postings).toHaveLength(1);
    expect(stats!.postings[0]!.tf).toBe(2); // 'memory' appears twice
    expect(stats!.postings[0]!.positions).toEqual([0, 2]);
  });

  it('updates document frequency across multiple documents', () => {
    const indexer = new SearchIndexer();
    indexer.addDocuments([
      makeDoc({ id: 'doc-1', content: 'memory leak detected' }),
      makeDoc({ id: 'doc-2', content: 'memory overflow found' }),
      makeDoc({ id: 'doc-3', content: 'connection pool exhausted' }),
    ]);

    const memoryStats = indexer.getTermStats('memory');
    expect(memoryStats!.df).toBe(2); // appears in doc-1 and doc-2

    const poolStats = indexer.getTermStats('pool');
    expect(poolStats!.df).toBe(1); // only in doc-3
  });

  it('cleans up term entries when last document with that term is removed', () => {
    const indexer = new SearchIndexer();
    indexer.addDocument(makeDoc({ id: 'doc-1', content: 'unique-term-xyz' }));

    expect(indexer.getTermStats('unique-term-xyz')).toBeDefined();

    indexer.removeDocument('doc-1');
    expect(indexer.getTermStats('unique-term-xyz')).toBeUndefined();
  });

  // ── Snapshot round-trip ──────────────────────────────────────

  it('serializes and deserializes via snapshot', () => {
    const indexer = new SearchIndexer();
    indexer.addDocuments([
      makeDoc({ id: 'doc-1', content: 'memory leak in connection pool' }),
      makeDoc({ id: 'doc-2', content: 'race condition in async handler' }),
    ]);

    const snapshot = indexer.toSnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.totalDocs).toBe(2);

    const restored = SearchIndexer.fromSnapshot(snapshot);
    expect(restored.totalDocs).toBe(2);
    expect(restored.hasDocument('doc-1')).toBe(true);
    expect(restored.hasDocument('doc-2')).toBe(true);
    expect(restored.avgDocLength).toBe(indexer.avgDocLength);

    // Verify term stats survived the round-trip
    const originalStats = indexer.getTermStats('memory');
    const restoredStats = restored.getTermStats('memory');
    expect(restoredStats?.df).toBe(originalStats?.df);
  });

  it('snapshot is JSON-serializable', () => {
    const indexer = new SearchIndexer();
    indexer.addDocument(makeDoc());

    const snapshot = indexer.toSnapshot();
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);

    const restored = SearchIndexer.fromSnapshot(parsed);
    expect(restored.totalDocs).toBe(1);
  });
});
