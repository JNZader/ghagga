/**
 * Embedding abstraction layer for GHAGGA intelligence features.
 *
 * Provides the shared EmbeddingProvider interface used by:
 *   - Feature #4: Hybrid search (BM25 + semantic vector search)
 *   - Feature #12: Semantic ranking of findings
 *   - Feature #13: Negative example filtering
 */

// ─── Embedding Provider ────────────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimension: number;
}

export type EmbeddingProviderFactory = () => EmbeddingProvider | null;

// ─── Vector Math ───────────────────────────────────────────────

/**
 * Cosine similarity between two vectors of equal length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── SQLite Serialization ──────────────────────────────────────

/**
 * Serialize a float32 embedding vector to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i]!, i * 4);
  }
  return buf;
}

/**
 * Deserialize a Buffer from SQLite BLOB back to a float32 embedding vector.
 */
export function deserializeEmbedding(buf: Buffer): number[] {
  const len = buf.length / 4;
  const vec: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    vec[i] = buf.readFloatLE(i * 4);
  }
  return vec;
}
