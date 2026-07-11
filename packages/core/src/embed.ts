/**
 * Embedding abstraction layer for GHAGGA intelligence features.
 *
 * Provides the shared EmbeddingProvider interface used by:
 *   - Feature #4: Hybrid search (BM25 + semantic vector search)
 *   - Feature #12: Semantic ranking of findings
 *   - Feature #13: Negative example filtering
 *
 * Also provides config resolution + a provider registry/factory
 * (`resolveEmbeddingConfig` / `createEmbeddingProvider`) so every
 * construction site (server, CLI, Action) can share one config surface.
 * Default provider is `none` — no behavior change until a context opts in.
 */

import { z } from 'zod';

// ─── Embedding Provider ────────────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimension: number;
}

export type EmbeddingProviderFactory = () => EmbeddingProvider | null;

/**
 * Thrown by provider implementations when an embed/embedBatch call fails
 * (network error, non-2xx response, unparseable body). Callers at the
 * search/save layer are responsible for catching this and degrading
 * gracefully (spec: "Graceful Degradation on Provider/API Failure") —
 * this module never swallows the failure itself.
 */
export class EmbeddingProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmbeddingProviderError';
  }
}

// ─── Config Resolution ─────────────────────────────────────────

const embeddingConfigSchema = z.object({
  /** Provider id, e.g. `none` | `openai-compatible` | `local`. Not enum-restricted here — unknown ids are handled (fallback + warn) by createEmbeddingProvider, not by config parsing. */
  provider: z.string().trim().min(1).default('none'),
  model: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  dimension: z.coerce.number().int().positive().optional(),
  /** Bounded cosine candidate set size (design D4). Read by later PRs. */
  candidateK: z.coerce.number().int().positive().default(200),
});

export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;

/**
 * Resolve embedding config from an env-like record (design D2).
 * Server reads `process.env` directly; CLI/Action map their own
 * config/inputs onto these same keys before calling this.
 */
export function resolveEmbeddingConfig(env: Record<string, string | undefined>): EmbeddingConfig {
  return embeddingConfigSchema.parse({
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    baseUrl: env.EMBEDDING_BASE_URL,
    apiKey: env.EMBEDDING_API_KEY,
    dimension: env.EMBEDDING_DIMENSION,
    candidateK: env.EMBEDDING_CANDIDATE_K,
  });
}

// ─── Provider Registry / Factory ───────────────────────────────

type ProviderBuilder = (config: EmbeddingConfig) => EmbeddingProvider | null;

/**
 * Registry of known provider ids. `local` is intentionally absent until
 * PR7 (design D7 — optional dependency, lazy-imported); selecting it
 * before then degrades to `none` via the "unknown provider id" path below.
 */
const providerRegistry: Record<string, ProviderBuilder> = {
  none: () => null,
  'openai-compatible': (config) => {
    if (!config.baseUrl || !config.model || !config.dimension) {
      console.warn(
        '[ghagga] embedding provider "openai-compatible" requires baseUrl, model, and dimension — falling back to none.',
      );
      return null;
    }
    return new OpenAICompatibleEmbeddingProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      dimension: config.dimension,
      apiKey: config.apiKey,
    });
  },
};

/**
 * Resolve a concrete EmbeddingProvider from config (spec: "Provider
 * Selection via Registry/Factory"). Unknown provider ids fall back to
 * `none` and log a warning instead of throwing.
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider | null {
  const build = providerRegistry[config.provider];
  if (!build) {
    console.warn(
      `[ghagga] Unknown embedding provider id "${config.provider}" — falling back to none.`,
    );
    return null;
  }
  return build(config);
}

// ─── OpenAI-Compatible HTTP Provider ───────────────────────────

interface OpenAICompatibleProviderConfig {
  baseUrl: string;
  model: string;
  dimension: number;
  apiKey?: string;
}

interface EmbeddingsResponseBody {
  data?: Array<{ embedding?: number[] }>;
}

/**
 * Generic `/v1/embeddings`-shaped HTTP provider (design D1). Covers
 * OpenAI, Voyage-compatible endpoints, and self-hosted servers (Ollama,
 * LM Studio, text-embeddings-inference) by base URL alone.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
    this.dimension = config.dimension;
    this.apiKey = config.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedBatch([text]);
    const [vector] = vectors as [number[]];
    return vector;
  }

  /** Issues ONE request for all inputs (spec: "Batched Embedding Calls"). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (error) {
      throw new EmbeddingProviderError(
        `Embedding request to ${this.baseUrl}/embeddings failed: ${(error as Error).message}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new EmbeddingProviderError(
        `Embedding API returned ${response.status} ${response.statusText}`,
      );
    }

    let body: EmbeddingsResponseBody;
    try {
      body = (await response.json()) as EmbeddingsResponseBody;
    } catch (error) {
      throw new EmbeddingProviderError(
        `Failed to parse embedding API response: ${(error as Error).message}`,
        { cause: error },
      );
    }

    if (!Array.isArray(body.data)) {
      throw new EmbeddingProviderError('Embedding API response is missing a "data" array');
    }

    return body.data.map((item, index) => {
      if (!Array.isArray(item.embedding)) {
        throw new EmbeddingProviderError(
          `Embedding API response is missing "embedding" at data[${index}]`,
        );
      }
      return item.embedding;
    });
  }
}

// ─── Fake Provider (Testing) ───────────────────────────────────

/**
 * Deterministic hash-of-tokens provider for tests (design D8). No network
 * calls, no randomness: the same text always yields the same unit vector,
 * enabling reproducible cosine-similarity assertions across suites.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;

  constructor(dimension = 8) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    return hashTokensToUnitVector(text, this.dimension);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashTokensToUnitVector(text, this.dimension));
  }
}

function hashTokensToUnitVector(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
    }
    vector[hash % dimension] += 1;
  }

  // Degenerate input (empty string / all-whitespace) still needs a valid
  // unit vector rather than a NaN-producing zero-norm division.
  // Note: a manual loop (not `.every(x => x === 0)`) avoids TS's inferred
  // array-literal-type narrowing, which would otherwise narrow `vector` to
  // `0[]` inside the branch and reject the `vector[0] = 1` assignment.
  let hasNonZeroComponent = false;
  for (const component of vector) {
    if (component !== 0) {
      hasNonZeroComponent = true;
      break;
    }
  }
  if (!hasNonZeroComponent) {
    vector[0] = 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  return vector.map((component) => component / norm);
}

// ─── Vector Math ───────────────────────────────────────────────

/**
 * Cosine similarity between two vectors of equal length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
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
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

/**
 * Deserialize a BLOB from SQLite back to a float32 embedding vector.
 *
 * Accepts both Buffer and plain Uint8Array: sql.js (fts5-sql-bundle) returns
 * BLOB columns as Uint8Array, which has no readFloatLE method.
 */
export function deserializeEmbedding(buf: Buffer | Uint8Array): number[] {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = b.length / 4;
  const vec: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    vec[i] = b.readFloatLE(i * 4);
  }
  return vec;
}
