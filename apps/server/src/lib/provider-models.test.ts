/**
 * Provider validation and model listing tests.
 *
 * Tests validateProviderKey for all providers (OpenAI, Anthropic, Google, GitHub)
 * with mocked global fetch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ─── Import after mocks ─────────────────────────────────────────

import { CURATED_MODELS, validateProviderKey } from './provider-models.js';

// ─── Setup ──────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

// ─── CURATED_MODELS ─────────────────────────────────────────────

describe('CURATED_MODELS', () => {
  it('has all 9 SaaS providers', () => {
    expect(Object.keys(CURATED_MODELS)).toEqual(
      expect.arrayContaining([
        'anthropic',
        'openai',
        'google',
        'github',
        'qwen',
        'groq',
        'cerebras',
        'deepseek',
        'openrouter',
      ]),
    );
    expect(Object.keys(CURATED_MODELS)).toHaveLength(9);
  });

  it('each provider has at least one model', () => {
    for (const [provider, models] of Object.entries(CURATED_MODELS)) {
      expect(models.length, `${provider} should have models`).toBeGreaterThan(0);
    }
  });

  it('anthropic models include claude variants', () => {
    expect(CURATED_MODELS.anthropic.some((m) => m.includes('claude'))).toBe(true);
  });

  it('openai models include gpt variants', () => {
    expect(CURATED_MODELS.openai.some((m) => m.includes('gpt'))).toBe(true);
  });

  it('google models include gemini variants', () => {
    expect(CURATED_MODELS.google.some((m) => m.includes('gemini'))).toBe(true);
  });
});

// ─── OpenAI Validation ──────────────────────────────────────────

describe('validateProviderKey — openai', () => {
  it('returns valid with filtered chat models on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o', owned_by: 'openai' },
          { id: 'gpt-4o-mini', owned_by: 'openai' },
          { id: 'text-embedding-3-small', owned_by: 'openai' },
          { id: 'tts-1', owned_by: 'openai' },
          { id: 'dall-e-3', owned_by: 'openai' },
          { id: 'whisper-1', owned_by: 'openai' },
          { id: 'text-davinci-003', owned_by: 'openai' },
          { id: 'babbage-002', owned_by: 'openai' },
          { id: 'text-moderation-latest', owned_by: 'openai' },
          { id: 'o3-mini', owned_by: 'openai' },
        ],
      }),
    });

    const result = await validateProviderKey('openai', 'sk-valid-key');

    expect(result.valid).toBe(true);
    // Only chat models should remain (gpt-4o, gpt-4o-mini, o3-mini)
    expect(result.models).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3-mini']);
    // Non-chat models filtered out
    expect(result.models).not.toContain('text-embedding-3-small');
    expect(result.models).not.toContain('tts-1');
    expect(result.models).not.toContain('dall-e-3');
    expect(result.models).not.toContain('whisper-1');
    expect(result.models).not.toContain('text-davinci-003');
    expect(result.models).not.toContain('babbage-002');
    expect(result.models).not.toContain('text-moderation-latest');

    // Verify correct URL and headers
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-valid-key' },
      }),
    );
  });

  it('returns curated models when API returns empty list', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const result = await validateProviderKey('openai', 'sk-valid-key');

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.openai);
  });

  it('returns invalid for 401 status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await validateProviderKey('openai', 'sk-bad-key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
    expect(result.models).toEqual([]);
  });

  it('returns invalid for 403 status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    const result = await validateProviderKey('openai', 'sk-bad-key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('returns error for other error statuses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const result = await validateProviderKey('openai', 'sk-valid-key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('API error 500');
  });

  it('handles text() failure gracefully on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('text failed');
      },
    });

    const result = await validateProviderKey('openai', 'sk-key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('API error 500');
  });

  it('models are sorted alphabetically', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4' }, { id: 'gpt-4o' }],
      }),
    });

    const result = await validateProviderKey('openai', 'sk-key');

    expect(result.models).toEqual(['gpt-4', 'gpt-4o', 'gpt-4o-mini']);
  });
});

// ─── GitHub Validation ──────────────────────────────────────────

describe('validateProviderKey — github', () => {
  it('uses Azure inference base URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o-mini' }],
      }),
    });

    await validateProviderKey('github', 'ghp-token');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://models.inference.ai.azure.com/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer ghp-token' },
      }),
    );
  });

  it('returns valid models from GitHub Models endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o' }, { id: 'Phi-4' }, { id: 'DeepSeek-R1' }],
      }),
    });

    const result = await validateProviderKey('github', 'ghp-token');

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(['DeepSeek-R1', 'Phi-4', 'gpt-4o']);
  });
});

// ─── Anthropic Validation ───────────────────────────────────────

describe('validateProviderKey — anthropic', () => {
  it('returns valid with curated models for 200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const result = await validateProviderKey('anthropic', 'sk-ant-valid');

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.anthropic);

    // Verify correct Anthropic-specific headers
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-valid',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('returns valid for 400 response (bad request but key works)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 400 });

    const result = await validateProviderKey('anthropic', 'sk-ant-valid');

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
  });

  it('returns valid for 429 response (rate limited but key works)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 429 });

    const result = await validateProviderKey('anthropic', 'sk-ant-valid');

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.anthropic);
  });

  it('returns invalid for 401 response', async () => {
    mockFetch.mockResolvedValueOnce({ status: 401 });

    const result = await validateProviderKey('anthropic', 'sk-ant-bad');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
    expect(result.models).toEqual([]);
  });

  it('returns invalid for 403 response', async () => {
    mockFetch.mockResolvedValueOnce({ status: 403 });

    const result = await validateProviderKey('anthropic', 'sk-ant-bad');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});

// ─── Google Validation ──────────────────────────────────────────

describe('validateProviderKey — google', () => {
  it('returns valid with curated models for 200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const result = await validateProviderKey('google', 'AIza-valid-key');

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.google);

    // Verify the API key is passed as query param
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('key=AIza-valid-key'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns valid for 429 response (rate limited but key works)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 429 });

    const result = await validateProviderKey('google', 'AIza-valid-key');

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.google);
  });

  it('returns invalid for 401 response', async () => {
    mockFetch.mockResolvedValueOnce({ status: 401 });

    const result = await validateProviderKey('google', 'AIza-bad-key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('returns invalid for 400 with "api key" error message', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      json: async () => ({
        error: { message: 'API key not valid. Please pass a valid API key.' },
      }),
    });

    const result = await validateProviderKey('google', 'AIza-bad-key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('returns invalid for 403 with "api key" error message', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 403,
      json: async () => ({
        error: { message: 'API key expired or invalid API key provided.' },
      }),
    });

    const result = await validateProviderKey('google', 'AIza-bad-key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('returns valid for 400 without "api key" in message (other error)', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      json: async () => ({
        error: { message: 'Request payload is too large' },
      }),
    });

    const result = await validateProviderKey('google', 'AIza-valid-key');

    // 400 without "api key" in message → falls through to valid
    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.google);
  });

  it('handles json() failure on 400/403 gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 403,
      json: async () => {
        throw new Error('json failed');
      },
    });

    const result = await validateProviderKey('google', 'AIza-key');

    // json() fails → msg defaults to "Invalid API key" but doesn't include "api key" lowercase match
    // Actually: data.error?.message is undefined, msg = "Invalid API key", which does include "api key"
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});

// ─── New OpenAI-Compatible Providers (Groq, Cerebras, DeepSeek, OpenRouter) ───

describe('validateProviderKey — groq', () => {
  it('returns models from /models endpoint on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'mixtral-8x7b-32768' }],
        }),
    });

    const result = await validateProviderKey('groq', 'gsk-key');

    expect(result.valid).toBe(true);
    expect(result.models).toContain('llama-3.3-70b-versatile');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer gsk-key' } }),
    );
  });

  it('returns 401 as invalid key', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve('') });

    const result = await validateProviderKey('groq', 'bad-key');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});

describe('validateProviderKey — cerebras', () => {
  it('returns models from /models endpoint on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'llama-3.3-70b' }] }),
    });

    const result = await validateProviderKey('cerebras', 'csk-key');

    expect(result.valid).toBe(true);
    expect(result.models).toContain('llama-3.3-70b');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cerebras.ai/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer csk-key' } }),
    );
  });

  it('falls back to curated list when /models returns non-auth error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Error'),
    });

    const result = await validateProviderKey('cerebras', 'csk-key');
    expect(result.valid).toBe(true);
    expect(result.models).toEqual(CURATED_MODELS.cerebras);
  });
});

describe('validateProviderKey — deepseek', () => {
  it('returns models on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
    });

    const result = await validateProviderKey('deepseek', 'dsk-key');

    expect(result.valid).toBe(true);
    expect(result.models).toContain('deepseek-chat');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer dsk-key' } }),
    );
  });
});

describe('validateProviderKey — openrouter', () => {
  it('returns models on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ data: [{ id: 'deepseek/deepseek-chat' }, { id: 'openai/gpt-4o' }] }),
    });

    const result = await validateProviderKey('openrouter', 'sk-or-key');

    expect(result.valid).toBe(true);
    expect(result.models).toContain('deepseek/deepseek-chat');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-or-key' } }),
    );
  });

  it('returns 403 as invalid key', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: () => Promise.resolve('') });

    const result = await validateProviderKey('openrouter', 'bad-key');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});

// ─── Error Handling ─────────────────────────────────────────────

describe('validateProviderKey — error handling', () => {
  it('returns error result when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await validateProviderKey('openai', 'sk-key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Network error');
    expect(result.models).toEqual([]);
  });

  it('returns string error when fetch throws non-Error', async () => {
    mockFetch.mockRejectedValueOnce('some string error');

    const result = await validateProviderKey('anthropic', 'sk-key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('some string error');
  });
});
