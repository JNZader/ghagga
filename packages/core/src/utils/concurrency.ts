/**
 * Concurrency limiter for LLM calls.
 *
 * Instead of firing all N calls at once via Promise.allSettled,
 * this utility processes them in batches of `concurrency` with
 * an optional delay between batches. This prevents exceeding
 * TPM (Tokens Per Minute) limits on free-tier providers.
 *
 * Example: 5 tasks with concurrency=2, delayMs=500
 *   Batch 1: [task1, task2]  → run in parallel
 *   wait 500ms
 *   Batch 2: [task3, task4]  → run in parallel
 *   wait 500ms
 *   Batch 3: [task5]         → run alone
 */

export interface ConcurrencyOptions {
  /** Max concurrent tasks (default: 2) */
  concurrency?: number;

  /** Delay in ms between batches (default: 0) */
  delayMs?: number;
}

/**
 * Coerce a caller-supplied concurrency into a finite integer >= 1.
 *
 * Returns the default (2) for `undefined`. Any non-finite value (NaN,
 * Infinity), or anything below 1, is clamped to 1 with a warning — this is
 * the last line of defence against the `i += concurrency` infinite loop.
 */
function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isFinite(value) || value < 1) {
    console.warn(
      `[ghagga] runWithConcurrency received invalid concurrency (${value}); clamping to 1`,
    );
    return 1;
  }
  return Math.floor(value);
}

/**
 * Coerce a caller-supplied delay into a finite, non-negative integer (ms).
 * Non-finite or negative values are clamped to 0.
 */
function normalizeDelayMs(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`[ghagga] runWithConcurrency received invalid delayMs (${value}); clamping to 0`);
    return 0;
  }
  return Math.floor(value);
}

/**
 * Run async tasks with bounded concurrency and optional inter-batch delay.
 *
 * Returns PromiseSettledResult[] in the same order as the input tasks,
 * matching the Promise.allSettled contract for easy migration.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  options: ConcurrencyOptions = {},
): Promise<PromiseSettledResult<T>[]> {
  // Defensive normalization — the settings boundary rejects invalid values,
  // but this helper is also called directly (fan-out, workflow, consensus).
  // A non-finite or < 1 concurrency would make `i += concurrency` stall on
  // empty batches forever (0) or walk backwards (negatives), so clamp to a
  // value that always makes forward progress. A negative/non-finite delay is
  // coerced to 0 rather than passed to setTimeout.
  const concurrency = normalizeConcurrency(options.concurrency);
  const delayMs = normalizeDelayMs(options.delayMs);

  // Fast path: if concurrency >= task count, run all at once (original behavior)
  if (concurrency >= tasks.length) {
    return Promise.allSettled(tasks.map((fn) => fn()));
  }

  const results: PromiseSettledResult<T>[] = [];

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    results.push(...batchResults);

    // Delay between batches (skip after the last batch)
    if (delayMs > 0 && i + concurrency < tasks.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}
