/**
 * Embedding serialization tests.
 *
 * The deserializer must accept plain Uint8Array — sql.js (fts5-sql-bundle)
 * returns BLOB columns as Uint8Array, not Node Buffer. Regression coverage
 * for the bug where hybrid search cosine scores were silently always 0.
 */

import { describe, expect, it } from 'vitest';
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from './embed.js';

describe('serializeEmbedding / deserializeEmbedding', () => {
  it('round-trips a float32 vector through a Buffer', () => {
    const vec = [0.25, -1.5, 3.75, 0];
    const buf = serializeEmbedding(vec);
    expect(deserializeEmbedding(buf)).toEqual(vec);
  });

  it('round-trips through a plain Uint8Array (sql.js BLOB shape)', () => {
    const vec = [0.5, -0.5, 2.0];
    const buf = serializeEmbedding(vec);
    // Simulate sql.js: BLOBs come back as Uint8Array, no readFloatLE method
    const uint8 = new Uint8Array(buf);
    expect(Buffer.isBuffer(uint8)).toBe(false);
    expect(deserializeEmbedding(uint8)).toEqual(vec);
  });

  it('respects byteOffset on Uint8Array views over a larger ArrayBuffer', () => {
    const vec = [1.5, -2.25];
    const serialized = serializeEmbedding(vec);
    // Embed the payload at offset 8 of a larger backing buffer
    const backing = new Uint8Array(8 + serialized.length + 4);
    backing.set(serialized, 8);
    const view = new Uint8Array(backing.buffer, 8, serialized.length);
    expect(deserializeEmbedding(view)).toEqual(vec);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors and 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it('returns 0 for zero vectors (no division by zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
