/**
 * Embedding serialization tests.
 *
 * The deserializer must accept plain Uint8Array — sql.js (fts5-sql-bundle)
 * returns BLOB columns as Uint8Array, not Node Buffer. Regression coverage
 * for the bug where hybrid search cosine scores were silently always 0.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cosineSimilarity,
  createEmbeddingProvider,
  DEFAULT_LOCAL_DIMENSION,
  DEFAULT_LOCAL_MODEL,
  deserializeEmbedding,
  EmbeddingProviderError,
  FakeEmbeddingProvider,
  LocalEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  resolveEmbeddingConfig,
  serializeEmbedding,
} from './embed.js';

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

describe('resolveEmbeddingConfig', () => {
  it('defaults provider to "none" and candidateK to 200 when env is empty', () => {
    const config = resolveEmbeddingConfig({});
    expect(config.provider).toBe('none');
    expect(config.candidateK).toBe(200);
    expect(config.model).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.dimension).toBeUndefined();
  });

  it('parses a fully-configured openai-compatible env', () => {
    const config = resolveEmbeddingConfig({
      EMBEDDING_PROVIDER: 'openai-compatible',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_BASE_URL: 'https://api.openai.com/v1',
      EMBEDDING_API_KEY: 'sk-test',
      EMBEDDING_DIMENSION: '1536',
      EMBEDDING_CANDIDATE_K: '50',
    });
    expect(config).toEqual({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      dimension: 1536,
      candidateK: 50,
    });
  });
});

describe('createEmbeddingProvider', () => {
  it('returns null for provider "none"', () => {
    expect(createEmbeddingProvider(resolveEmbeddingConfig({}))).toBeNull();
  });

  it('falls back to null and warns for an unknown provider id', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = createEmbeddingProvider(
      resolveEmbeddingConfig({ EMBEDDING_PROVIDER: 'totally-unknown' }),
    );
    expect(provider).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('totally-unknown');
    warnSpy.mockRestore();
  });

  it('falls back to null and warns when openai-compatible is missing required fields', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = createEmbeddingProvider(
      resolveEmbeddingConfig({ EMBEDDING_PROVIDER: 'openai-compatible' }),
    );
    expect(provider).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('returns a working provider for a fully-configured openai-compatible env', () => {
    const provider = createEmbeddingProvider(
      resolveEmbeddingConfig({
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'text-embedding-3-small',
        EMBEDDING_BASE_URL: 'https://api.openai.com/v1',
        EMBEDDING_DIMENSION: '1536',
      }),
    );
    expect(provider).toBeInstanceOf(OpenAICompatibleEmbeddingProvider);
    expect(provider?.dimension).toBe(1536);
  });
});

describe('OpenAICompatibleEmbeddingProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('embedBatch issues exactly ONE request for N inputs', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map((_text, i) => ({ embedding: [i, i + 1] })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      dimension: 2,
      apiKey: 'secret',
    });

    const vectors = await provider.embedBatch(['a', 'b', 'c']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vectors).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/embeddings');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    const sentBody = JSON.parse(String(init.body)) as { model: string; input: string[] };
    expect(sentBody).toEqual({ model: 'test-model', input: ['a', 'b', 'c'] });
  });

  it('embed() delegates to a single-item embedBatch request', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      dimension: 3,
    });

    expect(await provider.embed('hello')).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a network failure as EmbeddingProviderError instead of swallowing it', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      dimension: 3,
    });

    await expect(provider.embedBatch(['x'])).rejects.toThrow(EmbeddingProviderError);
  });

  it('surfaces a non-2xx response as EmbeddingProviderError', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    ) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      dimension: 3,
    });

    await expect(provider.embedBatch(['x'])).rejects.toThrow(EmbeddingProviderError);
  });

  it('surfaces a malformed response body as EmbeddingProviderError', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      dimension: 3,
    });

    await expect(provider.embedBatch(['x'])).rejects.toThrow(EmbeddingProviderError);
  });
});

describe('FakeEmbeddingProvider', () => {
  it('is deterministic: same text always yields the same vector', async () => {
    const provider = new FakeEmbeddingProvider(16);
    const first = await provider.embed('hello world semantic memory');
    const second = await provider.embed('hello world semantic memory');
    expect(first).toEqual(second);
  });

  it('produces unit vectors', async () => {
    const provider = new FakeEmbeddingProvider(16);
    const vector = await provider.embed('the quick brown fox jumps over the lazy dog');
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });

  it('produces a valid unit vector for empty/whitespace input (no NaN)', async () => {
    const provider = new FakeEmbeddingProvider(8);
    const vector = await provider.embed('   ');
    expect(vector.some((v) => Number.isNaN(v))).toBe(false);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });

  it('produces vectors of the configured dimension via embedBatch', async () => {
    const provider = new FakeEmbeddingProvider(12);
    const vectors = await provider.embedBatch(['alpha beta', 'gamma delta epsilon']);
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(12);
    }
  });

  it('different texts yield different vectors (not a constant)', async () => {
    const provider = new FakeEmbeddingProvider(16);
    const a = await provider.embed('cats and dogs');
    const b = await provider.embed('quantum entanglement physics');
    expect(a).not.toEqual(b);
  });
});

describe('LocalEmbeddingProvider (design D7, optional @xenova/transformers dependency)', () => {
  it('createEmbeddingProvider("local") returns a LocalEmbeddingProvider using the default model/dimension', () => {
    const provider = createEmbeddingProvider(
      resolveEmbeddingConfig({ EMBEDDING_PROVIDER: 'local' }),
    );
    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.dimension).toBe(DEFAULT_LOCAL_DIMENSION);
    expect(DEFAULT_LOCAL_MODEL).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('createEmbeddingProvider("local") honors an explicit EMBEDDING_MODEL/EMBEDDING_DIMENSION', () => {
    const provider = createEmbeddingProvider(
      resolveEmbeddingConfig({
        EMBEDDING_PROVIDER: 'local',
        EMBEDDING_MODEL: 'Xenova/custom-model',
        EMBEDDING_DIMENSION: '128',
      }),
    );
    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.dimension).toBe(128);
  });

  it('(a) import succeeds: embeds via an injected pipeline loader, returning the mocked vector', async () => {
    const fakeVector = [0.1, 0.2, 0.3];
    const loadPipeline = vi.fn(async () => async (texts: string[]) => ({
      tolist: () => texts.map(() => fakeVector),
    }));
    const provider = new LocalEmbeddingProvider(
      { model: 'test-model', dimension: 3 },
      loadPipeline,
    );

    const vector = await provider.embed('hello world');

    expect(vector).toEqual(fakeVector);
    expect(loadPipeline).toHaveBeenCalledTimes(1);
    expect(loadPipeline).toHaveBeenCalledWith('test-model');
  });

  it('embedBatch issues one pipeline call for N inputs and returns N vectors', async () => {
    const loadPipeline = vi.fn(async () => async (texts: string[]) => ({
      tolist: () => texts.map((_text, i) => [i, i + 1]),
    }));
    const provider = new LocalEmbeddingProvider({ model: 'm', dimension: 2 }, loadPipeline);

    const vectors = await provider.embedBatch(['a', 'b', 'c']);

    expect(vectors).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('memoizes the loaded pipeline across multiple embed calls (loader invoked once)', async () => {
    const loadPipeline = vi.fn(async () => async (texts: string[]) => ({
      tolist: () => texts.map(() => [1, 1]),
    }));
    const provider = new LocalEmbeddingProvider({ model: 'm', dimension: 2 }, loadPipeline);

    await provider.embed('a');
    await provider.embed('b');

    expect(loadPipeline).toHaveBeenCalledTimes(1);
  });

  it('(b) import fails: throws EmbeddingProviderError (never zero vectors), warns once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadPipeline = vi.fn(async () => {
      throw new Error('Cannot find module "@xenova/transformers"');
    });
    const provider = new LocalEmbeddingProvider(
      { model: 'missing-dep-model', dimension: 4 },
      loadPipeline,
    );

    await expect(provider.embed('hello')).rejects.toBeInstanceOf(EmbeddingProviderError);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('missing-dep-model');
    warnSpy.mockRestore();
  });

  it('(c) import succeeds but pipeline init throws: embed/embedBatch throw, warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadPipeline = vi.fn(async () => {
      throw new Error('pipeline init failed: unsupported model architecture');
    });
    const provider = new LocalEmbeddingProvider({ model: 'bad-model', dimension: 4 }, loadPipeline);

    await expect(provider.embed('hello')).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(provider.embedBatch(['x', 'y'])).rejects.toBeInstanceOf(EmbeddingProviderError);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('permanently degrades after the first failure — never retries the loader, warns once, keeps throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadPipeline = vi.fn(async () => {
      throw new Error('boom');
    });
    const provider = new LocalEmbeddingProvider({ model: 'm', dimension: 2 }, loadPipeline);

    await expect(provider.embed('a')).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(provider.embed('b')).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(provider.embedBatch(['c', 'd'])).rejects.toBeInstanceOf(EmbeddingProviderError);

    // loader tried once, warn fired once — subsequent throws are silent
    expect(loadPipeline).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('a degraded provider NEVER returns a persistable zero vector — it throws so save stores NULL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadPipeline = vi.fn(async () => {
      throw new Error('boom');
    });
    const provider = new LocalEmbeddingProvider({ model: 'm', dimension: 4 }, loadPipeline);

    await expect(provider.embed('anything')).rejects.toBeInstanceOf(EmbeddingProviderError);
    warnSpy.mockRestore();
  });
});
