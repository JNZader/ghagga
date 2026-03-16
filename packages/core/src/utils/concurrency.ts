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
 * Run async tasks with bounded concurrency and optional inter-batch delay.
 *
 * Returns PromiseSettledResult[] in the same order as the input tasks,
 * matching the Promise.allSettled contract for easy migration.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  options: ConcurrencyOptions = {},
): Promise<PromiseSettledResult<T>[]> {
  const { concurrency = 2, delayMs = 0 } = options;

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
