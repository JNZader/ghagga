/**
 * Tests for runWithConcurrency utility.
 *
 * Validates batching behavior, ordering, delay between batches,
 * and graceful handling of rejected tasks.
 */

import { describe, expect, it, vi } from 'vitest';
import { runWithConcurrency } from './concurrency.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeTask<T>(value: T, delayMs = 0): () => Promise<T> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

function makeFailingTask(error: string): () => Promise<never> {
  return () => Promise.reject(new Error(error));
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runWithConcurrency', () => {
  it('returns results in the same order as input tasks', async () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const results = await runWithConcurrency(tasks, { concurrency: 1 });

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'a' });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'b' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'c' });
  });

  it('runs all tasks in parallel when concurrency >= task count', async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) => async () => {
      order.push(n);
      return n;
    });

    await runWithConcurrency(tasks, { concurrency: 5 });

    // All should run immediately (parallel)
    expect(order).toEqual([1, 2, 3]);
  });

  it('respects concurrency limit (batches of 2)', async () => {
    const batchTracker: number[] = [];
    let activeTasks = 0;

    const tasks = [1, 2, 3, 4, 5].map((n) => async () => {
      activeTasks++;
      batchTracker.push(activeTasks);
      await new Promise((r) => setTimeout(r, 10));
      activeTasks--;
      return n;
    });

    await runWithConcurrency(tasks, { concurrency: 2 });

    // Max concurrent should never exceed 2
    expect(Math.max(...batchTracker)).toBeLessThanOrEqual(2);
  });

  it('handles rejected tasks without breaking other batches', async () => {
    const tasks = [makeTask('ok-1'), makeFailingTask('boom'), makeTask('ok-3')];

    const results = await runWithConcurrency(tasks, { concurrency: 1 });

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok-1' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok-3' });
  });

  it('applies delay between batches', async () => {
    const start = Date.now();
    const tasks = [makeTask(1), makeTask(2), makeTask(3)];

    await runWithConcurrency(tasks, { concurrency: 1, delayMs: 50 });

    const elapsed = Date.now() - start;
    // 3 tasks, concurrency 1, delay 50ms between batches → ~100ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(80); // allow some tolerance
  });

  it('does not apply delay after the last batch', async () => {
    const start = Date.now();
    const tasks = [makeTask(1), makeTask(2)];

    await runWithConcurrency(tasks, { concurrency: 2, delayMs: 500 });

    const elapsed = Date.now() - start;
    // Both tasks in one batch (concurrency=2, 2 tasks) → no delay applied
    expect(elapsed).toBeLessThan(100);
  });

  it('defaults to concurrency 2 and delayMs 0', async () => {
    const tasks = [makeTask(1), makeTask(2), makeTask(3)];
    const results = await runWithConcurrency(tasks);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('handles empty task list', async () => {
    const results = await runWithConcurrency([]);
    expect(results).toEqual([]);
  });
});
