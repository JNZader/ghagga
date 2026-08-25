import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.js';
import {
  fetchFileContents,
  fetchGraphFromBranch,
  fetchGraphMetadata,
  findExistingComment,
  getIssue,
  getPRCommitMessages,
  getPRFileList,
  listIssueComments,
  verifyWebhookSignature,
} from './client.js';

/**
 * Helper: compute a valid sha256 HMAC signature in GitHub's format.
 */
function computeSignature(payload: string, secret: string): string {
  const hash = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${hash}`;
}

describe('verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"action":"opened"}';

  it('returns true for a valid signature', async () => {
    const signature = computeSignature(payload, secret);
    expect(await verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it('returns false for null signature', async () => {
    expect(await verifyWebhookSignature(payload, null, secret)).toBe(false);
  });

  it('returns false for signature without sha256= prefix', async () => {
    const hash = createHmac('sha256', secret).update(payload).digest('hex');
    // No prefix — just the raw hex
    expect(await verifyWebhookSignature(payload, hash, secret)).toBe(false);
    // Wrong prefix
    expect(await verifyWebhookSignature(payload, `sha1=${hash}`, secret)).toBe(false);
  });

  it('returns false for tampered payload', async () => {
    const signature = computeSignature(payload, secret);
    const tampered = '{"action":"closed"}';
    expect(await verifyWebhookSignature(tampered, signature, secret)).toBe(false);
  });

  it('returns false for wrong secret', async () => {
    const signature = computeSignature(payload, secret);
    expect(await verifyWebhookSignature(payload, signature, 'wrong-secret')).toBe(false);
  });

  it('returns false for empty signature string', async () => {
    expect(await verifyWebhookSignature(payload, '', secret)).toBe(false);
  });

  it('handles UTF-8 payloads correctly', async () => {
    const utf8Payload = '{"title":"Revisión de código — ñ, ü, 日本語"}';
    const signature = computeSignature(utf8Payload, secret);
    expect(await verifyWebhookSignature(utf8Payload, signature, secret)).toBe(true);
  });

  it('handles large payloads', async () => {
    const largePayload = `{"data":"${'x'.repeat(100_000)}"}`;
    const signature = computeSignature(largePayload, secret);
    expect(await verifyWebhookSignature(largePayload, signature, secret)).toBe(true);
  });

  it('returns false for non-hex signature content', async () => {
    expect(await verifyWebhookSignature(payload, 'sha256=not-valid-hex!', secret)).toBe(false);
  });
});

// ─── Pagination Tests ───────────────────────────────────────────

// Mock the circuit breaker to pass through (we're testing pagination, not the breaker)
vi.mock('../lib/circuit-breaker.js', () => ({
  githubCircuitBreaker: {
    execute: <T>(fn: () => Promise<T>) => fn(),
    getState: () => 'closed' as const,
  },
  SimpleCircuitBreaker: vi.fn(),
}));

/**
 * Create N fake file objects for pagination testing.
 */
function makeFakeFiles(count: number, startIndex = 0): Array<{ filename: string }> {
  return Array.from({ length: count }, (_, i) => ({
    filename: `file-${startIndex + i}.ts`,
  }));
}

/**
 * Create N fake commit objects for pagination testing.
 */
function makeFakeCommits(count: number, startIndex = 0): Array<{ commit: { message: string } }> {
  return Array.from({ length: count }, (_, i) => ({
    commit: { message: `commit ${startIndex + i}` },
  }));
}

describe('getPRFileList — pagination', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('single page — fewer than 100 files', async () => {
    const files = makeFakeFiles(30);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(files),
    });

    const result = await getPRFileList('owner', 'repo', 1, 'token');

    expect(result).toHaveLength(30);
    expect(result[0]).toBe('file-0.ts');
    expect(result[29]).toBe('file-29.ts');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Verify page=1 in the URL
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
  });

  it('multi-page — 100 files on first page, fewer on second', async () => {
    const page1 = makeFakeFiles(100, 0);
    const page2 = makeFakeFiles(42, 100);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(page1),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(page2),
      });

    const result = await getPRFileList('owner', 'repo', 1, 'token');

    expect(result).toHaveLength(142);
    expect(result[0]).toBe('file-0.ts');
    expect(result[99]).toBe('file-99.ts');
    expect(result[100]).toBe('file-100.ts');
    expect(result[141]).toBe('file-141.ts');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
    expect(mockFetch.mock.calls[1][0]).toContain('page=2');
  });

  it('safety limit — stops at 10 pages (1000 files max)', async () => {
    // Return exactly 100 files on every page (simulating infinite pages)
    for (let page = 0; page < 10; page++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeFakeFiles(100, page * 100)),
      });
    }

    const result = await getPRFileList('owner', 'repo', 1, 'token');

    expect(result).toHaveLength(1000);
    expect(mockFetch).toHaveBeenCalledTimes(10);
    // Verify it stopped — no 11th page request
    expect(mockFetch.mock.calls[9][0]).toContain('page=10');
  });

  it('includes AbortSignal.timeout on each page request', async () => {
    const files = makeFakeFiles(5);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(files),
    });

    await getPRFileList('owner', 'repo', 1, 'token');

    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
  });

  it('propagates API errors correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(getPRFileList('owner', 'repo', 1, 'token')).rejects.toThrow(
      'GitHub API error fetching files: 403 Forbidden',
    );
  });
});

describe('getPRCommitMessages — pagination', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('single page — fewer than 100 commits', async () => {
    const commits = makeFakeCommits(15);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(commits),
    });

    const result = await getPRCommitMessages('owner', 'repo', 1, 'token');

    expect(result).toHaveLength(15);
    expect(result[0]).toBe('commit 0');
    expect(result[14]).toBe('commit 14');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
  });

  it('multi-page — 100 commits on first page, fewer on second', async () => {
    const page1 = makeFakeCommits(100, 0);
    const page2 = makeFakeCommits(25, 100);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(page1),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(page2),
      });

    const result = await getPRCommitMessages('owner', 'repo', 1, 'token');

    expect(result).toHaveLength(125);
    expect(result[0]).toBe('commit 0');
    expect(result[99]).toBe('commit 99');
    expect(result[100]).toBe('commit 100');
    expect(result[124]).toBe('commit 124');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
    expect(mockFetch.mock.calls[1][0]).toContain('page=2');
  });

  it('safety limit — stops at 5 pages (500 commits max)', async () => {
    // Return exactly 100 commits on every page (simulating infinite pages)
    for (let page = 0; page < 5; page++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeFakeCommits(100, page * 100)),
      });
    }

    const result = await getPRCommitMessages('owner', 'repo', 1, 'token');

    expect(result).toHaveLength(500);
    expect(mockFetch).toHaveBeenCalledTimes(5);
    // Verify it stopped — no 6th page request
    expect(mockFetch.mock.calls[4][0]).toContain('page=5');
  });

  it('includes AbortSignal.timeout on each page request', async () => {
    const commits = makeFakeCommits(3);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(commits),
    });

    await getPRCommitMessages('owner', 'repo', 1, 'token');

    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.signal).toBeDefined();
  });

  it('propagates API errors correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(getPRCommitMessages('owner', 'repo', 1, 'token')).rejects.toThrow(
      'GitHub API error fetching commits: 500 Internal Server Error',
    );
  });
});

// ─── fetchGraphFromBranch ───────────────────────────────────────

describe('fetchGraphFromBranch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const VALID_GRAPH = {
    version: 1,
    rootDir: '.',
    nodes: {
      'src/index.ts': {
        hash: 'abc123',
        language: 'typescript',
        imports: [],
        exports: ['main'],
        calls: [],
        isTest: false,
      },
    },
  };

  it('returns graph on 200 with valid JSON', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(VALID_GRAPH),
      }),
    );

    const result = await fetchGraphFromBranch('owner', 'repo', 'token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
  });

  it('returns null on 404', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 404 }));

    const result = await fetchGraphFromBranch('owner', 'repo', 'token');
    expect(result).toBeNull();
  });

  it('returns null on timeout/network error', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('network timeout')));

    const result = await fetchGraphFromBranch('owner', 'repo', 'token');
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ invalid: true }),
      }),
    );

    const result = await fetchGraphFromBranch('owner', 'repo', 'token');
    expect(result).toBeNull();
  });
});

// ─── fetchGraphMetadata ─────────────────────────────────────────

describe('fetchGraphMetadata', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const VALID_METADATA = {
    lastIndexedCommit: 'abc123def456',
    lastIndexedAt: new Date().toISOString(),
    schemaVersion: 1,
    fileCount: 1,
    languages: ['typescript'],
    indexDurationMs: 500,
  };

  it('returns metadata on 200 with valid JSON', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(VALID_METADATA),
      }),
    );

    const result = await fetchGraphMetadata('owner', 'repo', 'token');
    expect(result).not.toBeNull();
    expect(result?.lastIndexedCommit).toBe('abc123def456');
  });

  it('returns null on 404', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 404 }));

    const result = await fetchGraphMetadata('owner', 'repo', 'token');
    expect(result).toBeNull();
  });
});

// ─── findExistingComment — pagination (backlog #6) ──────────────

const MARKER = '<!-- ghagga-review -->';

/**
 * Create N fake issue-comment objects. `markerAt` (optional) is an index that
 * carries the ghagga-review MARKER; all others are unrelated bodies.
 */
function makeFakeComments(
  count: number,
  startId = 0,
  markerAt?: number,
): Array<{ id: number; body: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    body: i === markerAt ? `summary ${startId + i}\n${MARKER}` : `noise ${startId + i}`,
  }));
}

describe('findExistingComment — pagination', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('single page (< 100 comments) — exactly one list call, no extra fetch', async () => {
    const page1 = makeFakeComments(30, 0, 5); // marker on this single page
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) });

    const result = await findExistingComment('owner', 'repo', 1, 'token');

    expect(result).toEqual({ latestId: 5, staleIds: [] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
  });

  it('multi-page — full page 1 (no marker), stale marker on page 2 IS found', async () => {
    const page1 = makeFakeComments(100, 0); // 100 items, NO marker → must fetch page 2
    const page2 = makeFakeComments(20, 100, 7); // marker at index 7 → id 107
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2) });

    const result = await findExistingComment('owner', 'repo', 1, 'token');

    // The (only) marker found on page 2 is the latest; no stale duplicates.
    expect(result).toEqual({ latestId: 107, staleIds: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
    expect(mockFetch.mock.calls[1][0]).toContain('page=2');
  });

  it('multi-page — markers on BOTH pages → newest kept, older flagged stale', async () => {
    const page1 = makeFakeComments(100, 0, 3); // stale marker id 3
    const page2 = makeFakeComments(20, 100, 9); // latest marker id 109
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2) });

    const result = await findExistingComment('owner', 'repo', 1, 'token');

    expect(result).toEqual({ latestId: 109, staleIds: [3] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('safety bound — stops at MAX_PAGES (50) and warns instead of looping forever', async () => {
    // Every page is full (100 items) → would loop forever without the bound.
    for (let page = 0; page < 50; page++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeFakeComments(100, page * 100)),
      });
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await findExistingComment('owner', 'repo', 1, 'token');

    expect(result).toBeNull(); // no marker anywhere in the scanned range
    expect(mockFetch).toHaveBeenCalledTimes(50);
    expect(mockFetch.mock.calls[49][0]).toContain('page=50');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MAX_PAGES (50)'));
  });

  it('time budget — truncates paging once the wall-clock budget is exhausted, warns, returns what was found', async () => {
    // Page 1 is full (no marker) → loop wants to fetch page 2. We advance the
    // mocked clock past the 90s budget so the page-2 guard trips: the loop must
    // STOP (not blow the 5-min worker lock) and proceed with page-1 results.
    const page1 = makeFakeComments(100, 0, 4); // marker at id 4 on the first page
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) });
    // Any later page (should never be fetched once truncated).
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeFakeComments(100, 100)),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Clock: deadline is captured as `Date.now() + 90_000` BEFORE the loop.
    // 1st call (deadline capture) = 0; page-1 guard is skipped (page === 1);
    // 2nd call (page-2 guard) = past the deadline → truncate.
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0); // deadline = 90_000
    nowSpy.mockReturnValue(90_001); // every subsequent Date.now() is past it

    const result = await findExistingComment('owner', 'repo', 1, 'token');

    // Only page 1 was fetched; the budget guard stopped before page 2.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
    // We still return what we found on page 1.
    expect(result).toEqual({ latestId: 4, staleIds: [] });
    // Non-silent truncation, distinct from the MAX_PAGES warn.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pagination budget'));

    nowSpy.mockRestore();
  });
});

describe('listIssueComments — newest-first fetch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Build a mock fetch Response with a `Link` header and a JSON comment array. */
  function res(comments: Array<{ author: string; body: string }>, link?: string) {
    return {
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'link' ? (link ?? null) : null) },
      json: () =>
        Promise.resolve(comments.map((c) => ({ user: { login: c.author }, body: c.body }))),
    };
  }

  it('returns 0 fetches and empty array for maxCount <= 0', async () => {
    const result = await listIssueComments('owner', 'repo', 1, 'token', 0);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('single page (no Link): keeps the most-recent maxCount', async () => {
    // 5 comments oldest→newest; ask for 3 → keep c2,c3,c4 (the newest).
    const comments = Array.from({ length: 5 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
    mockFetch.mockResolvedValueOnce(res(comments));

    const result = await listIssueComments('owner', 'repo', 1, 'token', 3);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.map((c) => c.body)).toEqual(['c2', 'c3', 'c4']);
  });

  it('always requests per_page=100 (max) regardless of maxCount', async () => {
    mockFetch.mockResolvedValueOnce(res([{ author: 'a', body: 'x' }]));
    await listIssueComments('owner', 'repo', 1, 'token', 20);
    expect(mockFetch.mock.calls[0][0]).toContain('per_page=100');
  });

  it('many pages, full last page: jumps straight to the LAST page — 2 fetches', async () => {
    // Page 1 (oldest) advertises rel="last" page=9. The fix must NOT page 1..9;
    // it reads page 1 (for the Link header) then jumps to page 9. The last page
    // is FULL (≥ maxCount), so no previous page is needed.
    const oldest = Array.from({ length: 100 }, (_, i) => ({ author: `o${i}`, body: `old${i}` }));
    const newestPage = Array.from({ length: 100 }, (_, i) => ({
      author: `n${i}`,
      body: `new${i}`,
    }));
    const link =
      '<https://api.github.com/repositories/1/issues/1/comments?per_page=100&page=9>; rel="last"';
    mockFetch
      .mockResolvedValueOnce(res(oldest, link)) // page 1
      .mockResolvedValueOnce(res(newestPage)); // page 9

    const result = await listIssueComments('owner', 'repo', 1, 'token', 5);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');
    expect(mockFetch.mock.calls[1][0]).toContain('page=9');
    // Returns the trailing 5 of the NEWEST page, not the tail of the oldest.
    expect(result.map((c) => c.body)).toEqual(['new95', 'new96', 'new97', 'new98', 'new99']);
  });

  it('21 comments, maxCount=20: completes the window from the previous page (regression)', async () => {
    // The regression: per_page used to == maxCount (20), so page 1 = 1..20 and
    // the last page (page 2) = comment 21 only → returned 1 comment. With the
    // fix, per_page=100 → page 1 advertises rel="last" page=2 (the 21st comment),
    // the partial last page underfills, so page 1 is prepended → newest 20.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
    const page2 = [{ author: 'u100', body: 'c100' }]; // single newest comment
    const link =
      '<https://api.github.com/repositories/1/issues/1/comments?per_page=100&page=2>; rel="last"';
    // Two distinct pages, but emulate a 101-comment issue (window math is the
    // same as the 21/20 case: last page underfills maxCount).
    mockFetch
      .mockResolvedValueOnce(res(page1, link)) // page 1 (probe)
      .mockResolvedValueOnce(res(page2)); // page 2 (last, partial)

    const result = await listIssueComments('owner', 'repo', 1, 'token', 20);

    // page 1 already in hand (prevPage === 1) → only 2 fetches, NOT 3.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Newest 20: c81..c99 (tail of page 1) + c100 (page 2).
    const expected = [...Array.from({ length: 19 }, (_, i) => `c${81 + i}`), 'c100'];
    expect(result.map((c) => c.body)).toEqual(expected);
    expect(result).toHaveLength(20);
  });

  it('partial last page, intermediate previous page: 3 fetches complete the window', async () => {
    // 105 comments, per_page=100 → page 1 = c0..c99, page 2 (last) = c100..c104
    // (only 5). maxCount=20 underfills from the last page, and the previous page
    // is an INTERMEDIATE page (page 1 here, but exercise the > 1 path with page 3).
    // Model a 3-page issue: page 3 (last) = 5 comments, prev = page 2 (full 100).
    const page2 = Array.from({ length: 100 }, (_, i) => ({ author: `m${i}`, body: `mid${i}` }));
    const page3 = Array.from({ length: 5 }, (_, i) => ({ author: `n${i}`, body: `new${i}` }));
    const link =
      '<https://api.github.com/repositories/1/issues/1/comments?per_page=100&page=3>; rel="last"';
    mockFetch
      .mockResolvedValueOnce(res([], link)) // page 1 (probe; content irrelevant here)
      .mockResolvedValueOnce(res(page3)) // page 3 (last, partial — 5)
      .mockResolvedValueOnce(res(page2)); // page 2 (previous, intermediate → re-fetched)

    const result = await listIssueComments('owner', 'repo', 1, 'token', 20);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[1][0]).toContain('page=3');
    expect(mockFetch.mock.calls[2][0]).toContain('page=2');
    // Newest 20 = trailing 15 of page 2 (mid85..mid99) + 5 of page 3 (new0..new4).
    const expected = [
      ...Array.from({ length: 15 }, (_, i) => `mid${85 + i}`),
      ...Array.from({ length: 5 }, (_, i) => `new${i}`),
    ];
    expect(result.map((c) => c.body)).toEqual(expected);
  });

  it('missing Link header (single page) → trailing maxCount of page 1', async () => {
    const comments = Array.from({ length: 8 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
    mockFetch.mockResolvedValueOnce(res(comments)); // no link arg → header null

    const result = await listIssueComments('owner', 'repo', 1, 'token', 3);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.map((c) => c.body)).toEqual(['c5', 'c6', 'c7']);
  });

  it('malformed Link header → warns and falls back to page 1 tail (NOT oldest)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const comments = Array.from({ length: 6 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
    // Link present but no rel="last" page number → malformed.
    const badLink = '<https://api.github.com/...>; rel="next", <garbage>; rel="prev"';
    mockFetch.mockResolvedValueOnce(res(comments, badLink));

    const result = await listIssueComments('owner', 'repo', 1, 'token', 3);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Falls back to the NEWEST 3 of page 1, never the oldest.
    expect(result.map((c) => c.body)).toEqual(['c3', 'c4', 'c5']);
    warnSpy.mockRestore();
  });

  it('exactly maxCount on a single page → returns all, in order', async () => {
    const comments = Array.from({ length: 4 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
    mockFetch.mockResolvedValueOnce(res(comments));

    const result = await listIssueComments('owner', 'repo', 1, 'token', 4);

    expect(result.map((c) => c.body)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('total < maxCount (single page) → returns all available', async () => {
    const comments = [
      { author: 'a', body: 'c0' },
      { author: 'b', body: 'c1' },
    ];
    mockFetch.mockResolvedValueOnce(res(comments));

    const result = await listIssueComments('owner', 'repo', 1, 'token', 20);

    expect(result.map((c) => c.body)).toEqual(['c0', 'c1']);
  });

  it('zero comments (empty single page) → empty array', async () => {
    mockFetch.mockResolvedValueOnce(res([]));

    const result = await listIssueComments('owner', 'repo', 1, 'token', 20);

    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rel="last" pointing at page 1 → treats page 1 as the whole set (1 fetch)', async () => {
    const comments = Array.from({ length: 5 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
    const link =
      '<https://api.github.com/repositories/1/issues/1/comments?per_page=100&page=1>; rel="last"';
    mockFetch.mockResolvedValueOnce(res(comments, link));

    const result = await listIssueComments('owner', 'repo', 1, 'token', 3);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.map((c) => c.body)).toEqual(['c2', 'c3', 'c4']);
  });

  it('THROWS on a failed page (caller distinguishes fetch-fail from no-comments)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
    });
    await expect(listIssueComments('owner', 'repo', 1, 'token', 5)).rejects.toThrow(
      'GitHub API error listing issue comments: 403 Forbidden',
    );
  });
});

describe('getIssue', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const res = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

  it('returns title/body/labels, normalizing object AND string label shapes', async () => {
    mockFetch.mockResolvedValueOnce(
      res({ title: 'Crash on start', body: 'stack trace', labels: [{ name: 'bug' }, 'p1'] }),
    );

    const result = await getIssue('owner', 'repo', 7, 'token');

    expect(result).toEqual({ title: 'Crash on start', body: 'stack trace', labels: ['bug', 'p1'] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/issues/7');
  });

  it('coerces a null body to an empty string and tolerates missing labels', async () => {
    mockFetch.mockResolvedValueOnce(res({ title: 'No body', body: null }));

    const result = await getIssue('owner', 'repo', 8, 'token');

    expect(result).toEqual({ title: 'No body', body: '', labels: [] });
  });

  it('drops empty/blank label names', async () => {
    mockFetch.mockResolvedValueOnce(
      res({ title: 't', body: 'b', labels: [{ name: '' }, { name: 'kept' }] }),
    );

    const result = await getIssue('owner', 'repo', 9, 'token');

    expect(result.labels).toEqual(['kept']);
  });

  it('throws a GitHubApiError-shaped error on a non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });

    await expect(getIssue('owner', 'repo', 10, 'token')).rejects.toThrow(
      'GitHub API error fetching issue: 404 Not Found',
    );
  });
});

describe('fetchFileContents (ERE-transfer: remote code-in-evidence, hardened)', () => {
  const mockFetch = vi.fn();
  const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const fileResponse = (content: string, size = content.length) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ type: 'file', encoding: 'base64', content: b64(content), size }),
  });

  it('decodes a base64 file and hits the Contents API at the pinned ref', async () => {
    mockFetch.mockResolvedValueOnce(fileResponse('export const x = 1;\n'));
    const out = await fetchFileContents('octo', 'demo', 'src/retry.ts', 'abc123', 'tok');
    expect(out).toBe('export const x = 1;\n');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/repos/octo/demo/contents/src/retry.ts');
    expect(url).toContain('ref=abc123');
  });

  it('reads the default branch when ref is empty (no ?ref on the URL)', async () => {
    mockFetch.mockResolvedValueOnce(fileResponse('export const x = 1;\n'));
    const out = await fetchFileContents('octo', 'demo', 'src/retry.ts', '', 'tok');
    expect(out).toBe('export const x = 1;\n');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/repos/octo/demo/contents/src/retry.ts');
    expect(url).not.toContain('?ref='); // default branch → ?ref omitted
  });

  it('returns null on 404 (file absent at that ref)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });
    expect(await fetchFileContents('octo', 'demo', 'nope.ts', 'main', 'tok')).toBeNull();
  });

  it('returns null for a directory listing (JSON array), never a bogus "file"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ name: 'a.ts' }]),
    });
    expect(await fetchFileContents('octo', 'demo', 'src', 'main', 'tok')).toBeNull();
  });

  it('returns null for a non-file type (submodule/symlink)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ type: 'submodule' }),
    });
    expect(await fetchFileContents('octo', 'demo', 'vendor/x', 'main', 'tok')).toBeNull();
  });

  it('rejects a path-traversal attempt BEFORE any network call', async () => {
    await expect(
      fetchFileContents('octo', 'demo', '../../../etc/passwd', 'main', 'tok'),
    ).rejects.toThrow(/invalid path segment/);
    await expect(fetchFileContents('octo', 'demo', '/abs/path', 'main', 'tok')).rejects.toThrow(
      /invalid path/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a bad owner/ref BEFORE any network call', async () => {
    await expect(fetchFileContents('octo/evil', 'demo', 'a.ts', 'main', 'tok')).rejects.toThrow(
      /invalid owner/,
    );
    await expect(fetchFileContents('octo', 'demo', 'a.ts', 'main space', 'tok')).rejects.toThrow(
      /invalid ref/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on an oversized file (size field over the cap)', async () => {
    mockFetch.mockResolvedValueOnce(fileResponse('x', 512 * 1024 + 1));
    await expect(fetchFileContents('octo', 'demo', 'big.ts', 'main', 'tok')).rejects.toThrow(
      /exceeds/,
    );
  });

  it('throws when content is not inline (encoding switched) — hits the encoding branch, size within cap', async () => {
    // size is WITHIN the cap so the o.size guard does NOT fire first — this
    // isolates the `encoding !== 'base64'` branch the size check previously masked.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ type: 'file', encoding: 'none', content: '', size: 100 }),
    });
    await expect(fetchFileContents('octo', 'demo', 'huge.ts', 'main', 'tok')).rejects.toThrow(
      /not inline/,
    );
  });

  it('throws on a decoded body over the cap even when the size field is absent/understated', async () => {
    // No `size` field → the o.size guard is skipped; only the post-decode
    // byteLength cap can catch it. Guards against a lying/absent size.
    const big = 'a'.repeat(512 * 1024 + 10);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ type: 'file', encoding: 'base64', content: b64(big) }),
    });
    await expect(fetchFileContents('octo', 'demo', 'big.ts', 'main', 'tok')).rejects.toThrow(
      /decoded .* exceeds/,
    );
  });

  it('throws 502 on content that is not valid base64', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ type: 'file', encoding: 'base64', content: 'not*base64!', size: 11 }),
    });
    await expect(fetchFileContents('octo', 'demo', 'a.ts', 'main', 'tok')).rejects.toThrow(
      /not valid base64/,
    );
  });

  it('double-encodes path segments and the ref so specials cannot inject the URL', async () => {
    // The airtightness of the traversal/query defense rests on encodeURIComponent.
    // A literal `%2f` must NOT become a separator, a `?`/space must be encoded, and
    // a ref like `feature/foo` must become `feature%2Ffoo` (not a second path/qs).
    mockFetch.mockResolvedValueOnce(fileResponse('ok'));
    await fetchFileContents('octo', 'demo', 'weird/a %2f b?.ts', 'feature/foo', 'tok');
    const url = mockFetch.mock.calls[0][0] as string;
    // `%2f` → `%252f` (the % is re-encoded); space → `%20`; `?` → `%3F`.
    expect(url).toContain('weird/a%20%252f%20b%3F.ts');
    expect(url).not.toContain('weird/a %2f b?.ts');
    // ref slash is encoded so it cannot start a new path or query segment.
    expect(url).toContain('ref=feature%2Ffoo');
  });

  it('rejects empty and trailing-slash path segments (a//b, a/)', async () => {
    await expect(fetchFileContents('octo', 'demo', 'a//b', 'main', 'tok')).rejects.toThrow(
      /invalid path segment/,
    );
    await expect(fetchFileContents('octo', 'demo', 'a/', 'main', 'tok')).rejects.toThrow(
      /invalid path segment/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a grossly oversized response by Content-Length before reading the body', async () => {
    const json = vi.fn(() =>
      Promise.resolve({ type: 'file', encoding: 'base64', content: 'AA==' }),
    );
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === 'content-length' ? String(512 * 1024 * 5) : null) },
      json,
    });
    await expect(fetchFileContents('octo', 'demo', 'a.ts', 'main', 'tok')).rejects.toThrow(
      /exceeds cap/,
    );
    expect(json).not.toHaveBeenCalled(); // body never materialized
  });

  it('throws GitHubApiError on a non-2xx that is not 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
    await expect(fetchFileContents('octo', 'demo', 'a.ts', 'main', 'tok')).rejects.toThrow(
      'GitHub API error fetching file: 500 Server Error',
    );
  });
});
