/**
 * Provider fallback chain.
 *
 * Tries each provider/model pair in order. If one fails with a
 * server error (5xx) or times out, it moves to the next provider.
 * Client errors (4xx) are NOT retried — they indicate misconfiguration.
 */

import type { LLMProvider } from '../types.js';
import { generateTextWithTimeout } from '../utils/llm-timeout.js';
import { createModel } from './index.js';

// ─── Types ──────────────────────────────────────────────────────

export interface FallbackProvider {
  provider: LLMProvider;
  model: string;
  apiKey: string;
}

export interface FallbackOptions {
  /** Ordered list of providers to try */
  providers: FallbackProvider[];

  /** System prompt */
  system: string;

  /** User prompt */
  prompt: string;

  /** Temperature for generation (default: 0.3 for review consistency) */
  temperature?: number;
}

export interface FallbackResult {
  /** Generated text */
  text: string;

  /** Provider that succeeded */
  provider: LLMProvider;

  /** Model that succeeded */
  model: string;

  /** Approximate tokens used (prompt + completion) */
  tokensUsed: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Check if an error is a retryable server-side error (5xx or timeout).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Network/timeout errors
    if (
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused')
    ) {
      return true;
    }

    // Check for HTTP status codes in error (provider SDKs often include them)
    const statusMatch = /status[:\s]*(\d{3})/i.exec(message);
    if (statusMatch) {
      const status = parseInt(statusMatch[1] ?? '0', 10);
      return status >= 500;
    }

    // Rate limit (429) — also retryable with a different provider
    if (message.includes('rate limit') || message.includes('429')) {
      return true;
    }
  }

  return false;
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Generate text with automatic provider fallback.
 *
 * Tries each provider in order. On retryable errors (5xx, timeout,
 * rate limit), moves to the next provider. Throws the last error
 * if all providers fail.
 *
 * @param options - Providers, system prompt, and user prompt
 * @returns Generated text with metadata about which provider succeeded
 * @throws The last encountered error if all providers fail
 */
export async function generateWithFallback(options: FallbackOptions): Promise<FallbackResult> {
  const { providers, system, prompt, temperature = 0.3 } = options;

  if (providers.length === 0) {
    throw new Error('No providers configured for fallback chain');
  }

  let lastError: unknown;

  for (const { provider, model, apiKey } of providers) {
    try {
      const languageModel = createModel(provider, model, apiKey);

      const result = await generateTextWithTimeout(
        {
          model: languageModel,
          system,
          prompt,
          temperature,
        },
        { provider, model },
      );

      // Timeout: treat as a retryable error and try next provider
      if (result === null) {
        lastError = new Error(`LLM call timed out for ${provider}/${model}`);
        console.warn(`[ghagga] Provider ${provider}/${model} timed out, trying next...`);
        continue;
      }

      // Calculate tokens used from the response
      const tokensUsed = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);

      return {
        text: result.text,
        provider,
        model,
        tokensUsed,
      };
    } catch (error) {
      lastError = error;

      if (isRetryableError(error)) {
        // Log and continue to next provider
        console.warn(
          `[ghagga] Provider ${provider}/${model} failed with retryable error, trying next...`,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }

      // Non-retryable error (4xx, auth, etc.) — throw immediately
      throw error;
    }
  }

  // All providers failed with retryable errors
  throw lastError;
}
