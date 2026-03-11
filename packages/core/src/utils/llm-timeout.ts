/**
 * LLM call timeout utility.
 *
 * Wraps the AI SDK's `generateText` with a configurable timeout
 * (default 60 seconds). When the timeout fires, the call is aborted
 * and the function returns `null` so callers can gracefully fall back
 * to static-analysis-only results.
 */

import { type GenerateTextResult, generateText } from 'ai';

/** Default timeout for LLM calls: 60 seconds. */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * Options accepted by `generateTextWithTimeout`.
 *
 * Same as `generateText` parameters, but `abortSignal` is managed
 * internally (any caller-provided signal is combined via `AbortSignal.any`).
 */
type GenerateTextParams = Parameters<typeof generateText>[0];

/**
 * Call `generateText` with an automatic timeout.
 *
 * - Creates an `AbortController` with a 60-second timeout.
 * - If the caller already provides an `abortSignal`, both signals
 *   are combined so either one can cancel the request.
 * - On timeout (or abort), logs a warning and returns `null`.
 * - On any other error, **re-throws** so the caller's existing
 *   error handling continues to work.
 *
 * @param params - Standard `generateText` parameters
 * @param context - Optional metadata for the warning log (provider, model)
 * @returns The `generateText` result, or `null` if the call timed out
 */
export async function generateTextWithTimeout(
  params: GenerateTextParams,
  context?: { provider?: string; model?: string },
): Promise<GenerateTextResult<any, any> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  // Combine with any caller-provided signal
  let signal: AbortSignal = controller.signal;
  if (params.abortSignal) {
    signal = AbortSignal.any([controller.signal, params.abortSignal]);
  }

  const startTime = Date.now();

  try {
    const result = await generateText({
      ...params,
      abortSignal: signal,
    });
    return result;
  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;

    // Check if this was an abort/timeout
    if (isAbortError(error)) {
      const providerInfo =
        context?.provider && context?.model ? `${context.provider}/${context.model}` : 'unknown';

      console.warn(
        `[ghagga] LLM call timed out after ${(elapsed / 1000).toFixed(1)}s ` +
          `(limit: ${LLM_TIMEOUT_MS / 1000}s) — provider: ${providerInfo}. ` +
          'Falling back to static-analysis-only results.',
      );

      return null;
    }

    // Not a timeout — re-throw for the caller's existing error handling
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect whether an error is an abort/timeout error.
 *
 * The AI SDK and Node.js throw different shapes depending on the
 * runtime, so we check multiple patterns.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    if (error.message.includes('aborted') || error.message.includes('AbortError')) return true;
  }
  return false;
}
