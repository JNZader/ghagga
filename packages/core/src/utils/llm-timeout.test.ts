/**
 * Tests for LLM timeout utility.
 *
 * Verifies that generateTextWithTimeout:
 *   - Returns the result on success
 *   - Returns null on timeout (abort)
 *   - Re-throws non-abort errors
 *   - Logs a warning with provider/model info on timeout
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the 'ai' module before importing our utility
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { generateTextWithTimeout, LLM_TIMEOUT_MS } from './llm-timeout.js';

const mockGenerateText = vi.mocked(generateText);

describe('generateTextWithTimeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result when generateText succeeds', async () => {
    const mockResult = {
      text: 'STATUS: PASSED\nSUMMARY: Looks good.',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    mockGenerateText.mockResolvedValue(mockResult as ReturnType<typeof generateText> extends Promise<infer T> ? T : never);

    const promise = generateTextWithTimeout(
      { model: {} as Parameters<typeof generateText>[0]['model'], prompt: 'test' },
      { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    );

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toBe(mockResult);
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it('passes abortSignal to generateText', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 0, outputTokens: 0 },
    } as ReturnType<typeof generateText> extends Promise<infer T> ? T : never);

    const promise = generateTextWithTimeout(
      { model: {} as Parameters<typeof generateText>[0]['model'], prompt: 'test' },
    );

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // Verify that abortSignal was passed to generateText
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('returns null when the call times out', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Simulate a call that never resolves until aborted
    mockGenerateText.mockImplementation(async (params) => {
      return new Promise((_resolve, reject) => {
        // Listen for abort
        if (params.abortSignal) {
          params.abortSignal.addEventListener('abort', () => {
            const error = new DOMException('The operation was aborted', 'AbortError');
            reject(error);
          });
        }
      });
    });

    const promise = generateTextWithTimeout(
      { model: {} as Parameters<typeof generateText>[0]['model'], prompt: 'test' },
      { provider: 'google', model: 'gemini-2.5-flash' },
    );

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS + 100);

    const result = await promise;

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('LLM call timed out'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('google/gemini-2.5-flash'),
    );

    warnSpy.mockRestore();
  });

  it('re-throws non-abort errors', async () => {
    vi.useRealTimers(); // Use real timers for this test to avoid unhandled rejection timing issues
    mockGenerateText.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(
      generateTextWithTimeout(
        { model: {} as Parameters<typeof generateText>[0]['model'], prompt: 'test' },
        { provider: 'openai', model: 'gpt-4o' },
      ),
    ).rejects.toThrow('API rate limit exceeded');
  });

  it('logs provider info as "unknown" when context is not provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockGenerateText.mockImplementation(async (params) => {
      return new Promise((_resolve, reject) => {
        if (params.abortSignal) {
          params.abortSignal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }
      });
    });

    const promise = generateTextWithTimeout(
      { model: {} as Parameters<typeof generateText>[0]['model'], prompt: 'test' },
    );

    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS + 100);

    const result = await promise;
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown'),
    );

    warnSpy.mockRestore();
  });

  it('exports the timeout constant as 60 seconds', () => {
    expect(LLM_TIMEOUT_MS).toBe(60_000);
  });
});
