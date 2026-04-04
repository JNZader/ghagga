import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FallbackOptions } from './fallback.js';
import { generateWithFallback } from './fallback.js';

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

// Mock the provider factory
vi.mock('./index.js', () => ({
  createModel: vi.fn(() => ({ modelId: 'mock-model' })),
}));

// Import the mocked generateText so we can control its behavior
import { generateText } from 'ai';

const mockGenerateText = vi.mocked(generateText);

// ─── Helpers ────────────────────────────────────────────────────

function makeOptions(overrides: Partial<FallbackOptions> = {}): FallbackOptions {
  return {
    providers: [
      { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'key-1' },
      { provider: 'openai', model: 'gpt-4o', apiKey: 'key-2' },
    ],
    system: 'You are a code reviewer.',
    prompt: 'Review this code.',
    temperature: 0.3,
    ...overrides,
  };
}

function successResult(text = 'review result') {
  return {
    text,
    usage: { inputTokens: 100, outputTokens: 50 },
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
  } as any;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('generateWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws "No providers configured" for empty providers array', async () => {
    const options = makeOptions({ providers: [] });

    await expect(generateWithFallback(options)).rejects.toThrow('No providers configured');
  });

  it('returns result from first provider when it succeeds', async () => {
    mockGenerateText.mockResolvedValueOnce(successResult('first provider result'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('first provider result');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.tokensUsed).toBe(150); // 100 + 50
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('falls back to second provider on 5xx error from first', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('status: 500 Internal Server Error'));
    mockGenerateText.mockResolvedValueOnce(successResult('fallback result'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('fallback result');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('falls back to second provider on timeout from first', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Request timeout'));
    mockGenerateText.mockResolvedValueOnce(successResult('timeout fallback'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('timeout fallback');
    expect(result.provider).toBe('openai');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('falls back to second provider on rate limit (429) from first', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('429 rate limit exceeded'));
    mockGenerateText.mockResolvedValueOnce(successResult('rate limit fallback'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('rate limit fallback');
    expect(result.provider).toBe('openai');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('falls back on ECONNRESET error', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('ECONNRESET'));
    mockGenerateText.mockResolvedValueOnce(successResult('conn reset fallback'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('conn reset fallback');
    expect(result.provider).toBe('openai');
  });

  it('falls back on ECONNREFUSED error', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockGenerateText.mockResolvedValueOnce(successResult('conn refused fallback'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('conn refused fallback');
    expect(result.provider).toBe('openai');
  });

  it('throws immediately on 4xx error (non-retryable)', async () => {
    const clientError = new Error('status: 401 Unauthorized');
    mockGenerateText.mockRejectedValueOnce(clientError);

    const options = makeOptions();

    await expect(generateWithFallback(options)).rejects.toThrow('status: 401 Unauthorized');
    // Should NOT have tried the second provider
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on 400 Bad Request (non-retryable)', async () => {
    const clientError = new Error('status: 400 Bad Request');
    mockGenerateText.mockRejectedValueOnce(clientError);

    const options = makeOptions();

    await expect(generateWithFallback(options)).rejects.toThrow('status: 400 Bad Request');
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('falls back to second provider on 413 status code', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('status: 413 Request Entity Too Large'));
    mockGenerateText.mockResolvedValueOnce(successResult('413 fallback result'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('413 fallback result');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('falls back on "request too large" error message', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Request too large for model context'));
    mockGenerateText.mockResolvedValueOnce(successResult('request too large fallback'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('request too large fallback');
    expect(result.provider).toBe('openai');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('falls back on "413" in error message', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Groq error: 413 payload exceeded'));
    mockGenerateText.mockResolvedValueOnce(successResult('groq 413 fallback'));

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.text).toBe('groq 413 fallback');
    expect(result.provider).toBe('openai');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('throws the last error when all providers fail with retryable errors', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('status: 500 Internal Server Error'));
    mockGenerateText.mockRejectedValueOnce(new Error('status: 503 Service Unavailable'));

    const options = makeOptions();

    await expect(generateWithFallback(options)).rejects.toThrow('status: 503 Service Unavailable');
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it('calculates tokensUsed from usage', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'result',
      usage: { inputTokens: 200, outputTokens: 100 },
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
    } as any);

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.tokensUsed).toBe(300);
  });

  it('handles missing usage gracefully (defaults to 0)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'result',
      usage: {},
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
    } as any);

    const options = makeOptions();
    const result = await generateWithFallback(options);

    expect(result.tokensUsed).toBe(0);
  });

  it('works with a single provider', async () => {
    mockGenerateText.mockResolvedValueOnce(successResult('single provider'));

    const options = makeOptions({
      providers: [{ provider: 'google', model: 'gemini-2.0-flash', apiKey: 'key-g' }],
    });
    const result = await generateWithFallback(options);

    expect(result.text).toBe('single provider');
    expect(result.provider).toBe('google');
    expect(result.model).toBe('gemini-2.0-flash');
  });
});
