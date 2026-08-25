/**
 * Circuit breaker integration tests.
 *
 * Verifies that GitHub API client functions route through the shared
 * circuit breaker, and that the breaker opens/fail-fasts correctly
 * when GitHub returns repeated 5xx errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubCircuitBreaker } from '../lib/circuit-breaker.js';
import {
  addCommentReaction,
  fetchPRDetails,
  fetchPRDiff,
  getPRCommitMessages,
  getPRFileList,
  postComment,
  searchCode,
} from './client.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Stub fetch to return a 500 error for every call. */
function stubFetch500(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    }),
  );
}

/** Stub fetch to return a successful JSON response. */
function stubFetchOk(body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    }),
  );
}

// ─── Reset the shared breaker between tests ─────────────────────
// The shared singleton accumulates state. We reset it by calling
// execute() with a success after forcing the breaker back to closed
// via the time-based recovery path.

/**
 * Force-reset the shared githubCircuitBreaker to closed state.
 * We use the class internals through the public API: advance time
 * past the reset timeout, then run a successful probe.
 */
async function resetBreaker(): Promise<void> {
  if (githubCircuitBreaker.getState() !== 'closed') {
    // Advance time past the 30s reset timeout so breaker enters half-open
    vi.advanceTimersByTime(31_000);
    // Run a successful call to transition half-open → closed
    try {
      await githubCircuitBreaker.execute(() => Promise.resolve());
    } catch {
      // If it somehow still fails, try once more
      vi.advanceTimersByTime(31_000);
      await githubCircuitBreaker.execute(() => Promise.resolve());
    }
  }
}

describe('GitHub client circuit breaker integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await resetBreaker();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── Verify calls go through the breaker ─────────────────────

  it('fetchPRDetails routes through the circuit breaker', async () => {
    const executeSpy = vi.spyOn(githubCircuitBreaker, 'execute');

    stubFetchOk({ head: { sha: 'abc123' }, base: { ref: 'main' }, user: { login: 'pr-author' } });

    const result = await fetchPRDetails('owner', 'repo', 1, 'token');

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({ headSha: 'abc123', baseBranch: 'main', prAuthor: 'pr-author' });
  });

  it('fetchPRDiff routes through the circuit breaker', async () => {
    const executeSpy = vi.spyOn(githubCircuitBreaker, 'execute');

    stubFetchOk('diff content here');

    const result = await fetchPRDiff('owner', 'repo', 1, 'token');

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(result).toBe('diff content here');
  });

  it('postComment routes through the circuit breaker', async () => {
    const executeSpy = vi.spyOn(githubCircuitBreaker, 'execute');

    stubFetchOk({ id: 42 });

    const result = await postComment('owner', 'repo', 1, 'body', 'token');

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({ id: 42 });
  });

  it('getPRCommitMessages routes through the circuit breaker', async () => {
    const executeSpy = vi.spyOn(githubCircuitBreaker, 'execute');

    stubFetchOk([{ commit: { message: 'fix: something' } }]);

    const result = await getPRCommitMessages('owner', 'repo', 1, 'token');

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(result).toEqual(['fix: something']);
  });

  it('getPRFileList routes through the circuit breaker', async () => {
    const executeSpy = vi.spyOn(githubCircuitBreaker, 'execute');

    stubFetchOk([{ filename: 'src/index.ts' }]);

    const result = await getPRFileList('owner', 'repo', 1, 'token');

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(result).toEqual(['src/index.ts']);
  });

  it('addCommentReaction routes through the circuit breaker', async () => {
    const executeSpy = vi.spyOn(githubCircuitBreaker, 'execute');

    stubFetchOk();

    await addCommentReaction('owner', 'repo', 1, 'rocket', 'token');

    expect(executeSpy).toHaveBeenCalledOnce();
  });

  // ── Circuit opens after repeated 5xx errors ─────────────────

  it('circuit opens after 5 consecutive GitHub 5xx errors', async () => {
    stubFetch500();

    // The shared breaker has threshold=5. Trip it with 5 failures.
    for (let i = 0; i < 5; i++) {
      await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow(
        'GitHub API error fetching diff',
      );
    }

    expect(githubCircuitBreaker.getState()).toBe('open');
  });

  // ── Open circuit fails fast without hitting the API ──────────

  it('open circuit rejects immediately without calling fetch', async () => {
    stubFetch500();

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow();
    }
    expect(githubCircuitBreaker.getState()).toBe('open');

    // Clear the mock call count
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockClear();

    // Next call should fail fast with "Circuit breaker is open" — no fetch
    await expect(fetchPRDetails('owner', 'repo', 1, 'token')).rejects.toThrow(
      'Circuit breaker is open',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Circuit recovers after reset timeout ─────────────────────

  it('circuit recovers after reset timeout and successful probe', async () => {
    stubFetch500();

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow();
    }
    expect(githubCircuitBreaker.getState()).toBe('open');

    // Advance past 30s reset timeout
    vi.advanceTimersByTime(31_000);

    // Stub a successful response for the probe
    stubFetchOk([{ filename: 'recovered.ts' }]);

    const files = await getPRFileList('owner', 'repo', 1, 'token');
    expect(files).toEqual(['recovered.ts']);
    expect(githubCircuitBreaker.getState()).toBe('closed');
  });

  // ── addCommentReaction swallows circuit breaker errors ────────

  it('addCommentReaction does not throw when circuit is open', async () => {
    stubFetch500();

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow();
    }
    expect(githubCircuitBreaker.getState()).toBe('open');

    // addCommentReaction should swallow the "Circuit breaker is open" error
    await expect(
      addCommentReaction('owner', 'repo', 1, 'rocket', 'token'),
    ).resolves.toBeUndefined();
  });

  // ── Mixed functions share the same breaker ───────────────────

  it('failures from different functions accumulate on the same breaker', async () => {
    stubFetch500();

    // 2 failures from fetchPRDiff
    await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow();
    await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow();

    // 2 failures from postComment
    await expect(postComment('owner', 'repo', 1, 'body', 'token')).rejects.toThrow();
    await expect(postComment('owner', 'repo', 1, 'body', 'token')).rejects.toThrow();

    // Still closed (4 < 5)
    expect(githubCircuitBreaker.getState()).toBe('closed');

    // 1 more failure from getPRFileList trips it
    await expect(getPRFileList('owner', 'repo', 1, 'token')).rejects.toThrow();
    expect(githubCircuitBreaker.getState()).toBe('open');
  });

  // ── searchCode: throttled responses never open the breaker ───

  /** Stub fetch to return a 429 (rate-limited) for every call. */
  function stubFetch429(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: () => null },
        json: () => Promise.resolve({}),
      }),
    );
  }

  it('BREAKER ISOLATION: N throttled (429) searchCode calls never open the shared breaker', async () => {
    stubFetch429();

    // Well over the threshold (5) — a throttle degrades to [] and is fetched
    // OUTSIDE the breaker, so neither onFailure() nor onSuccess() fires and the
    // breaker must stay closed the whole time.
    for (let i = 0; i < 8; i++) {
      await expect(searchCode('owner', 'repo', 'fetchGraph', 5, 'token')).resolves.toEqual([]);
    }
    expect(githubCircuitBreaker.getState()).toBe('closed');

    // Prove the breaker is genuinely still usable: a DIFFERENT function's
    // success still routes through the SAME breaker instance.
    stubFetchOk([{ filename: 'still-works.ts' }]);
    const files = await getPRFileList('owner', 'repo', 1, 'token');
    expect(files).toEqual(['still-works.ts']);
    expect(githubCircuitBreaker.getState()).toBe('closed');
  });

  it('BREAKER RESET ISOLATION: a throttled searchCode does NOT reset accrued failures', async () => {
    stubFetch500();
    // 4 genuine failures via fetchPRDiff (threshold is 5) → breaker at 4, still closed.
    for (let i = 0; i < 4; i++) {
      await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow();
    }
    expect(githubCircuitBreaker.getState()).toBe('closed');

    // A throttled searchCode must be a NO-OP for the shared breaker — it must not
    // zero the accrued failure count (the F1 fix: throttle is neither success nor
    // failure; routing it through onSuccess would reset fetchFileContents's count).
    stubFetch429();
    await expect(searchCode('owner', 'repo', 'fetchGraph', 5, 'token')).resolves.toEqual([]);
    expect(githubCircuitBreaker.getState()).toBe('closed');

    // The 5th genuine failure now OPENS it — proving the throttle did not reset the 4.
    stubFetch500();
    await expect(fetchPRDiff('owner', 'repo', 1, 'token')).rejects.toThrow();
    expect(githubCircuitBreaker.getState()).toBe('open');
  });
});
