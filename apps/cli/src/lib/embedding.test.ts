/**
 * Tests for CLI embedding provider resolution (design D2, task 5.2/5.4).
 *
 * Mocks `./config.js` (loadConfig) to isolate the merge-precedence logic:
 * config-file keys override the matching `EMBEDDING_*` env vars.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
}));

vi.mock('./config.js', () => ({
  loadConfig: () => mockLoadConfig(),
}));

import { resolveCliEmbeddingConfig, resolveCliEmbeddingProvider } from './embedding.js';

const ENV_KEYS = [
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_DIMENSION',
  'EMBEDDING_CANDIDATE_K',
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({});
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe('resolveCliEmbeddingConfig', () => {
  it('resolves to "none" when neither config file nor env is set', () => {
    const config = resolveCliEmbeddingConfig();

    expect(config.provider).toBe('none');
    expect(config.candidateK).toBe(200);
    expect(config.model).toBeUndefined();
  });

  it('falls back to env when the config file has no embedding keys', () => {
    process.env.EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_DIMENSION = '1536';

    const config = resolveCliEmbeddingConfig();

    expect(config.provider).toBe('openai-compatible');
    expect(config.model).toBe('text-embedding-3-small');
    expect(config.dimension).toBe(1536);
  });

  it('prefers config-file values over env (design D2 precedence)', () => {
    process.env.EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.EMBEDDING_MODEL = 'env-model';
    mockLoadConfig.mockReturnValue({
      embeddingProvider: 'openai-compatible',
      embeddingModel: 'config-file-model',
      embeddingBaseUrl: 'https://api.example.com/v1',
      embeddingDimension: 768,
      embeddingCandidateK: 42,
    });

    const config = resolveCliEmbeddingConfig();

    expect(config.model).toBe('config-file-model');
    expect(config.baseUrl).toBe('https://api.example.com/v1');
    expect(config.dimension).toBe(768);
    expect(config.candidateK).toBe(42);
  });
});

describe('resolveCliEmbeddingProvider', () => {
  it('returns provider: undefined when unconfigured (none-default parity)', () => {
    const { provider, config } = resolveCliEmbeddingProvider();

    expect(provider).toBeUndefined();
    expect(config.provider).toBe('none');
  });

  it('returns a concrete provider when fully configured', () => {
    mockLoadConfig.mockReturnValue({
      embeddingProvider: 'openai-compatible',
      embeddingModel: 'text-embedding-3-small',
      embeddingBaseUrl: 'https://api.openai.com/v1',
      embeddingDimension: 1536,
    });

    const { provider, config } = resolveCliEmbeddingProvider();

    expect(provider).toBeDefined();
    expect(provider?.dimension).toBe(1536);
    expect(config.model).toBe('text-embedding-3-small');
  });

  it('an unknown provider id falls back to undefined (never throws)', () => {
    mockLoadConfig.mockReturnValue({ embeddingProvider: 'totally-unknown' });

    const { provider } = resolveCliEmbeddingProvider();

    expect(provider).toBeUndefined();
  });
});
