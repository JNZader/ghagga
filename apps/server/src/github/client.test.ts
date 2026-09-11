import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.js';
import {
  createExplanationComment,
  fetchFileContents,
  fetchGraphFromBranch,
  fetchGraphMetadata,
  fetchRevisionPinnedSnapshot,
  findExistingComment,
  findExplanationComment,
  getCurrentExplanationActorAuthorization,
  getInstallationToken,
  getInstallationTokenWithExpiry,
  getIssue,
  getPRCommitMessages,
  getPRFileList,
  listIssueComments,
  resolveGitHubAppBotAuthorId,
  searchCode,
  updateExplanationComment,
  verifyWebhookSignature,
} from './client.js';

describe('getCurrentExplanationActorAuthorization', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires matching human identity, non-none permission, and a separate collaborator 204 proof', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ user: { id: 42, type: 'User' }, permission: 'read' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204 });

    await expect(
      getCurrentExplanationActorAuthorization('octo', 'demo', 'alice', '42', 'token'),
    ).resolves.toEqual({ kind: 'AUTHORIZED' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[0]).toContain('/collaborators/alice');
  });

  it.each([
    [{ user: { id: 7, type: 'User' }, permission: 'write' }],
    [{ user: { id: 42, type: 'Bot' }, permission: 'write' }],
    [{ user: { id: 42, type: 'User' }, permission: 'none' }],
  ])(
    'returns explicit unauthorized only for a confirmed identity or role denial',
    async (payload) => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });

      await expect(
        getCurrentExplanationActorAuthorization('octo', 'demo', 'alice', '42', 'token'),
      ).resolves.toEqual({ kind: 'UNAUTHORIZED' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 404, 500])(
    'keeps permission endpoint HTTP %i operationally uncertain',
    async (status) => {
      mockFetch.mockResolvedValueOnce({ ok: false, status, statusText: 'unavailable' });

      await expect(
        getCurrentExplanationActorAuthorization('octo', 'demo', 'alice', '42', 'token'),
      ).resolves.toEqual({ kind: 'UNCERTAIN' });
    },
  );

  it('does not infer collaboration from read permission when the separate check is not 204', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ user: { id: 42, type: 'User' }, permission: 'read' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'not found' });

    await expect(
      getCurrentExplanationActorAuthorization('octo', 'demo', 'alice', '42', 'token'),
    ).resolves.toEqual({ kind: 'UNCERTAIN' });
  });
});

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

describe('searchCode (triage-search-discovery T3: throttle-isolated code search)', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const searchResponse = (paths: string[]) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve({ items: paths.map((path) => ({ path })) }),
  });

  it('hits the search/code endpoint with a URLSearchParams-encoded q + per_page', async () => {
    mockFetch.mockResolvedValueOnce(searchResponse(['src/a.ts', 'src/b.ts']));
    const out = await searchCode('octo', 'demo', 'fetchGraph', 5, 'tok');
    expect(out).toEqual(['src/a.ts', 'src/b.ts']);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://api.github.com/search/code?');
    expect(url).toContain('q=fetchGraph+repo%3Aocto%2Fdemo');
    expect(url).toContain('per_page=5');
  });

  it('caps per_page at MAX_SEARCH_RESULTS even when limit is larger', async () => {
    mockFetch.mockResolvedValueOnce(searchResponse([]));
    await searchCode('octo', 'demo', 'fetchGraph', 999, 'tok');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('per_page=10');
  });

  it('validates owner/repo/term/limit BEFORE any network call (term out-of-charset → 400)', async () => {
    await expect(searchCode('octo/evil', 'demo', 'fetchGraph', 5, 'tok')).rejects.toThrow(
      /invalid owner/,
    );
    await expect(searchCode('octo', '..', 'fetchGraph', 5, 'tok')).rejects.toThrow(/invalid repo/);
    await expect(searchCode('octo', 'demo', 'bad term!', 5, 'tok')).rejects.toThrow(/invalid term/);
    await expect(searchCode('octo', 'demo', 'a'.repeat(65), 5, 'tok')).rejects.toThrow(
      /invalid term/,
    );
    await expect(searchCode('octo', 'demo', 'fetchGraph', 0, 'tok')).rejects.toThrow(
      /invalid limit/,
    );
    await expect(searchCode('octo', 'demo', 'fetchGraph', -1, 'tok')).rejects.toThrow(
      /invalid limit/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns [] on a 429 (rate-limited) without throwing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: () => null },
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);
  });

  it('returns [] on a 422 (search-specific rejection) without throwing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      headers: { get: () => null },
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);
  });

  it('returns [] on a 403 WITH rate-limit-remaining=0 (secondary rate limit)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: (h: string) => (h === 'x-ratelimit-remaining' ? '0' : null) },
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);
  });

  it('returns [] on a 403 WITH a retry-after header (abuse detection)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: (h: string) => (h === 'retry-after' ? '30' : null) },
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);
  });

  it('THROWS on a genuine 403 (no rate-limit headers) — not a throttle', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).rejects.toThrow(
      'GitHub API error searching code: 403 Forbidden',
    );
  });

  it('degrades a 5xx to [] (best-effort search is decoupled from the shared breaker)', async () => {
    // /search/code is a flakier, lower-limit endpoint; a 5xx there must NOT trip
    // the shared breaker that gates the core PR-review + file-fetch paths — it
    // degrades to [] just like a throttle.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: { get: () => null },
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);
  });

  it('degrades a network/timeout error to [] (never throws out of best-effort search)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);
  });

  it('returns [] for an empty/malformed items array, never throws', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({ items: [] }),
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.reject(new Error('bad json')),
    });
    await expect(searchCode('octo', 'demo', 'fetchGraph', 5, 'tok')).resolves.toEqual([]);
  });

  it('dedupes paths and caps at limit', async () => {
    mockFetch.mockResolvedValueOnce(searchResponse(['a.ts', 'a.ts', 'b.ts', 'c.ts']));
    const out = await searchCode('octo', 'demo', 'fetchGraph', 2, 'tok');
    expect(out).toEqual(['a.ts', 'b.ts']);
  });
});

describe('fetchRevisionPinnedSnapshot — revision-pinned snapshot', () => {
  const mockFetch = vi.fn();
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const mergeBase = 'c'.repeat(40);
  const baseTree = 'd'.repeat(40);
  const headTree = 'e'.repeat(40);

  const response = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Failure',
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  });
  const blob = (text: string, sha = 'f'.repeat(40)) =>
    response({
      sha,
      size: Buffer.byteLength(text),
      encoding: 'base64',
      content: Buffer.from(text).toString('base64'),
    });
  const pull = (currentHead = head, overrides: Record<string, unknown> = {}) =>
    response({
      number: 7,
      base: { sha: base, repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
      head: { sha: currentHead, repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
      ...overrides,
    });
  const commit = (sha: string, tree: string) => response({ sha, tree: { sha: tree } });
  const tree = (entries: readonly unknown[], sha: string, truncated = false) =>
    response({ sha, truncated, tree: entries });
  const entry = (path: string, sha: string, mode = '100644', type = 'blob', size?: number) => ({
    path,
    mode,
    type,
    sha,
    ...(size === undefined ? {} : { size }),
  });

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function queueSnapshot(
    before: readonly unknown[],
    after: readonly unknown[],
    blobs: ReturnType<typeof response>[],
    finalHead = head,
    initialPull = pull(),
    finalPull = pull(finalHead),
  ) {
    const requests = [
      { resource: '/pulls/7', value: initialPull },
      {
        resource: `/compare/${base}...`,
        value: response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
      },
      { resource: `/git/commits/${mergeBase}`, value: commit(mergeBase, baseTree) },
      { resource: `/git/commits/${head}`, value: commit(head, headTree) },
      { resource: `/git/trees/${baseTree}?recursive=1`, value: tree(before, baseTree) },
      { resource: `/git/trees/${headTree}?recursive=1`, value: tree(after, headTree) },
      ...blobs.map((value) => ({ resource: '/git/blobs/', value })),
      { resource: '/pulls/7', value: finalPull },
    ];
    mockFetch.mockImplementation((url: string) => {
      const expected = requests.shift();
      if (!expected || !url.includes(expected.resource)) {
        throw new Error(`unexpected GitHub request: ${url}`);
      }
      return Promise.resolve(expected.value);
    });
  }

  it('acquires a deterministic merge-base snapshot without PR diff/files fallbacks', async () => {
    const beforeSha = '1'.repeat(40);
    const afterSha = '2'.repeat(40);
    queueSnapshot(
      [entry('lib/a.ts', beforeSha)],
      [entry('lib/a.ts', afterSha), entry('new.ts', '3'.repeat(40))],
      [blob('before\n', beforeSha), blob('after\n', afterSha), blob('added\n', '3'.repeat(40))],
    );
    const result = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token');
    expect(result).toEqual({
      repositoryId: '11',
      baseSha: mergeBase,
      headSha: head,
      diff: '--- a/lib/a.ts\n+++ b/lib/a.ts\n@@ -1 +1 @@\n-before\n+after\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+added\n',
      files: [
        { path: 'lib/a.ts', content: 'after\n' },
        { path: 'new.ts', content: 'added\n' },
      ],
    });
    expect(mockFetch.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([expect.stringContaining(`/compare/${base}...${head}`)]),
    );
  });

  it('uses the fork head repository while keeping merge-base reads in the target repository', async () => {
    const forkPull = pull(head, {
      head: { sha: head, repo: { id: 22, owner: { login: 'forker' }, name: 'fork' } },
    });
    queueSnapshot(
      [entry('shared.ts', '1'.repeat(40))],
      [entry('shared.ts', '2'.repeat(40))],
      [blob('before\n', '1'.repeat(40)), blob('after\n', '2'.repeat(40))],
      head,
      forkPull,
      forkPull,
    );
    const result = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token');
    expect(result?.baseSha).toBe(mergeBase);
    const urls = mockFetch.mock.calls.map(([url]) => String(url));
    expect(urls).toContain(
      `https://api.github.com/repos/octo/demo/compare/${base}...forker:${head}`,
    );
    expect(urls).toContain(`https://api.github.com/repos/octo/demo/git/blobs/${'1'.repeat(40)}`);
    expect(urls).toContain(`https://api.github.com/repos/forker/fork/git/blobs/${'2'.repeat(40)}`);
  });

  it('returns null before I/O for unsafe identity inputs', async () => {
    await expect(
      fetchRevisionPinnedSnapshot('octo/evil', 'demo', 7, head, 'token'),
    ).resolves.toBeNull();
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 0, head, 'token')).resolves.toBeNull();
    await expect(
      fetchRevisionPinnedSnapshot('octo', 'demo', 7, 'short', 'token'),
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails closed for PR identity races and missing fork metadata', async () => {
    queueSnapshot(
      [],
      [entry('new.ts', '3'.repeat(40))],
      [blob('added\n', '3'.repeat(40))],
      '9'.repeat(40),
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      response({
        number: 7,
        base: { sha: base, repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
        head: { sha: head, repo: null },
      }),
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
  });

  it.each([
    ['deleted path', () => queueSnapshot([entry('gone.ts', '1'.repeat(40))], [], [])],
    [
      'mode change',
      () =>
        queueSnapshot(
          [entry('a.ts', '1'.repeat(40))],
          [entry('a.ts', '2'.repeat(40), '100755')],
          [],
        ),
    ],
    [
      'duplicate path',
      () => queueSnapshot([], [entry('a.ts', '1'.repeat(40)), entry('a.ts', '2'.repeat(40))], []),
    ],
  ])('fails closed for %s manifest evidence', async (_name, arrange) => {
    arrange();
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
  });

  it('rejects malformed, non-text, and oversized blob evidence without truncating', async () => {
    const sha = '1'.repeat(40);
    queueSnapshot(
      [],
      [entry('a.ts', sha)],
      [response({ sha, size: 1, encoding: 'base64', content: 'not*base64' })],
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    mockFetch.mockReset();
    queueSnapshot(
      [],
      [entry('a.ts', sha)],
      [
        response({
          sha,
          size: 2,
          encoding: 'base64',
          content: Buffer.from([0xff, 0xff]).toString('base64'),
        }),
      ],
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    mockFetch.mockReset();
    queueSnapshot(
      [],
      [entry('a.ts', sha)],
      [response({ sha, size: 512 * 1024 + 1, encoding: 'base64', content: '' })],
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
  });

  it('preserves CRLF and missing final newlines in complete-file unified diffs', async () => {
    const beforeSha = '1'.repeat(40);
    const afterSha = '2'.repeat(40);
    queueSnapshot(
      [entry('a b.ts', beforeSha)],
      [entry('a b.ts', afterSha)],
      [blob('old\r\nlast', beforeSha), blob('new\r\nlast', afterSha)],
    );
    const result = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token');
    expect(result?.diff).toContain('--- "a/a b.ts"\n+++ "b/a b.ts"\n');
    expect(result?.diff).toContain(
      '-old\r\n-last\n\\ No newline at end of file\n+new\r\n+last\n\\ No newline at end of file\n',
    );
  });

  it('propagates operational GitHub errors rather than converting them to null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => null },
    });
    await expect(
      fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
    ).rejects.toMatchObject({ status: 401 });
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).rejects.toThrow(
      'network down',
    );
  });

  it('requires immutable compare, commit, and root-tree identities before reading manifests', async () => {
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: 'not-a-sha' } }),
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockResolvedValueOnce(commit('0'.repeat(40), baseTree));
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockResolvedValueOnce(commit(mergeBase, baseTree));
    mockFetch.mockResolvedValueOnce(commit(head, headTree));
    mockFetch.mockResolvedValueOnce(tree([], '0'.repeat(40)));
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
  });

  it('rejects mismatched head commit and root-tree identities before blob hydration', async () => {
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockResolvedValueOnce(commit(mergeBase, baseTree));
    mockFetch.mockResolvedValueOnce(commit('0'.repeat(40), headTree));
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4);

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockResolvedValueOnce(commit(mergeBase, baseTree));
    mockFetch.mockResolvedValueOnce(commit(head, headTree));
    mockFetch.mockResolvedValueOnce(tree([], baseTree));
    mockFetch.mockResolvedValueOnce(tree([], '0'.repeat(40)));
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('rejects explicitly truncated base and head trees before blob hydration', async () => {
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockResolvedValueOnce(commit(mergeBase, baseTree));
    mockFetch.mockResolvedValueOnce(commit(head, headTree));
    mockFetch.mockResolvedValueOnce(tree([], baseTree, true));
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(5);

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockResolvedValueOnce(commit(mergeBase, baseTree));
    mockFetch.mockResolvedValueOnce(commit(head, headTree));
    mockFetch.mockResolvedValueOnce(tree([], baseTree));
    mockFetch.mockResolvedValueOnce(tree([], headTree, true));
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('rejects a Compare base-commit race before fetching immutable commits', async () => {
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: '9'.repeat(40) }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockImplementation(() => {
      throw new Error('unexpected GitHub request after invalid Compare response');
    });

    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched merge-base commit before fetching the head commit', async () => {
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } }),
    );
    mockFetch.mockResolvedValueOnce(commit('0'.repeat(40), baseTree));
    mockFetch.mockImplementation(() => {
      throw new Error('unexpected GitHub request after invalid base commit');
    });

    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects a known per-blob limit before hydrating any blob', async () => {
    queueSnapshot([], [entry('large.ts', '1'.repeat(40), '100644', 'blob', 512 * 1024 + 1)], []);

    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('ignores added directory entries while hydrating the changed regular file beneath them', async () => {
    const fileSha = '1'.repeat(40);
    queueSnapshot(
      [],
      [entry('directory', '2'.repeat(40), '040000', 'tree'), entry('directory/new.ts', fileSha)],
      [blob('added\n', fileSha)],
    );

    await expect(
      fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
    ).resolves.toMatchObject({
      files: [{ path: 'directory/new.ts', content: 'added\n' }],
    });
  });

  it('fails closed before downstream I/O for invalid PR metadata and determinable manifest limits', async () => {
    for (const invalidPull of [
      response({
        number: '7',
        base: { sha: base, repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
        head: { sha: head, repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
      }),
      response({
        number: 7,
        base: { sha: base, repo: { id: 1.5, owner: { login: 'octo' }, name: 'demo' } },
        head: { sha: head, repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
      }),
      response({
        number: 7,
        base: { sha: base, repo: { id: 11, owner: { login: 'elsewhere' }, name: 'demo' } },
        head: { sha: head, repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
      }),
    ]) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(invalidPull);
      await expect(
        fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
      ).resolves.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }

    mockFetch.mockReset();
    queueSnapshot(
      [],
      Array.from({ length: 101 }, (_, index) =>
        entry(`f-${index}.ts`, `${index}`.padStart(40, '0')),
      ),
      [],
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(6);

    mockFetch.mockReset();
    queueSnapshot([], [entry('large.ts', '1'.repeat(40), '100644', 'blob', 512 * 1024 + 1)], []);
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(6);

    mockFetch.mockReset();
    queueSnapshot(
      [],
      Array.from({ length: 5 }, (_, index) =>
        entry(`size-${index}.ts`, `${index + 1}`.repeat(40), '100644', 'blob', 512 * 1024),
      ),
      [],
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('preserves byte fidelity and rejects blob identity, canonical encoding, UTF-8, and NUL failures', async () => {
    const sha = '1'.repeat(40);
    queueSnapshot([], [entry('bytes.ts', sha)], [blob('\uFEFFone\rtwo', sha)]);
    const result = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token');
    expect(result?.files).toEqual([{ path: 'bytes.ts', content: '\uFEFFone\rtwo' }]);
    expect(result?.diff).toBe(
      '--- /dev/null\n+++ b/bytes.ts\n@@ -0,0 +1 @@\n+\uFEFFone\rtwo\n\\ No newline at end of file\n',
    );

    for (const evidence of [
      response({ sha: '2'.repeat(40), size: 1, encoding: 'base64', content: 'YQ==' }),
      response({ sha, size: 1, encoding: 'base64', content: 'YQ==\rX' }),
      response({ sha, size: 1, encoding: 'base64', content: 'YQ=' }),
      response({ sha, size: 2, encoding: 'base64', content: 'YQ==' }),
      response({
        sha,
        size: 2,
        encoding: 'base64',
        content: Buffer.from([0xff, 0xff]).toString('base64'),
      }),
      response({ sha, size: 1, encoding: 'base64', content: 'AA==' }),
    ]) {
      mockFetch.mockReset();
      queueSnapshot([], [entry('bytes.ts', sha)], [evidence]);
      await expect(
        fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
      ).resolves.toBeNull();
    }
  });

  it('accepts line-wrapped base64, ignores untrusted compare payloads, and rejects all changed unsupported entries', async () => {
    const sha = '1'.repeat(40);
    queueSnapshot(
      [],
      [entry('wrapped.ts', sha)],
      [response({ sha, size: 4, encoding: 'base64', content: 'YWJj\nZA==' })],
    );
    const result = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token');
    expect(result?.files).toEqual([{ path: 'wrapped.ts', content: 'abcd' }]);

    for (const [before, after] of [
      [[entry('gone.ts', sha)], []],
      [[], [entry('link.ts', sha, '120000')]],
      [[], [entry('submodule', sha, '160000', 'commit')]],
      [[], [entry('folder', sha, '040000', 'tree')]],
      [[entry('same.ts', sha)], [entry('same.ts', sha, '100755')]],
    ] as const) {
      mockFetch.mockReset();
      queueSnapshot(before, after, []);
      await expect(
        fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
      ).resolves.toBeNull();
    }
  });

  it.each([
    ['unsafe repository', 'octo', '../demo', 7, head],
    ['non-positive-safe PR', 'octo', 'demo', Number.MAX_SAFE_INTEGER + 1, head],
    ['initial requested-head mismatch', 'octo', 'demo', 7, '9'.repeat(40)],
  ])(
    'rejects %s without consuming immutable object responses',
    async (_name, owner, repository, number, sha) => {
      if (sha !== head) {
        mockFetch.mockResolvedValueOnce(pull());
      }

      await expect(
        fetchRevisionPinnedSnapshot(owner, repository, number, sha, 'token'),
      ).resolves.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(sha === head ? 0 : 1);
    },
  );

  it('rejects malformed initial/final repository bindings without inventing expected repository ids', async () => {
    const invalidHead = pull(head, {
      head: { sha: head, repo: { id: 22, owner: { login: 'bad/owner' }, name: 'fork' } },
    });
    mockFetch.mockResolvedValueOnce(invalidHead);
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();

    mockFetch.mockReset();
    const finalBaseRace = pull(head, {
      base: { sha: '9'.repeat(40), repo: { id: 11, owner: { login: 'octo' }, name: 'demo' } },
    });
    queueSnapshot(
      [],
      [entry('new.ts', '1'.repeat(40))],
      [blob('new\n', '1'.repeat(40))],
      head,
      pull(),
      finalBaseRace,
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();

    mockFetch.mockReset();
    const finalRepositoryRace = pull(head, {
      head: { sha: head, repo: { id: 22, owner: { login: 'forker' }, name: 'fork' } },
    });
    queueSnapshot(
      [],
      [entry('new.ts', '1'.repeat(40))],
      [blob('new\n', '1'.repeat(40))],
      head,
      pull(),
      finalRepositoryRace,
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
  });

  it('rejects malformed head repository numeric and path bindings before downstream reads', async () => {
    for (const invalidHeadRepository of [
      { id: 1.5, owner: { login: 'forker' }, name: 'fork' },
      { id: 22, owner: { login: 'forker' }, name: 'fork/path' },
    ]) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(
        pull(head, { head: { sha: head, repo: invalidHeadRepository } }),
      );
      await expect(
        fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
      ).resolves.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects malformed immutable manifests and does not trust Compare file payloads', async () => {
    for (const invalidEntry of [
      null,
      { mode: '100644', type: 'blob', sha: '1'.repeat(40) },
      { path: 'a.ts', mode: '100644', type: 'blob', sha: 'not-a-sha' },
      { path: '../a.ts', mode: '100644', type: 'blob', sha: '1'.repeat(40) },
    ]) {
      mockFetch.mockReset();
      queueSnapshot([], [invalidEntry], []);
      await expect(
        fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
      ).resolves.toBeNull();
    }

    mockFetch.mockReset();
    const sha = '1'.repeat(40);
    mockFetch.mockResolvedValueOnce(pull());
    mockFetch.mockResolvedValueOnce(
      response({
        base_commit: { sha: base },
        merge_base_commit: { sha: mergeBase },
        files: [
          {
            patch: 'untrusted',
            raw_url: 'https://evil.invalid',
            contents_url: 'https://evil.invalid',
          },
        ],
      }),
    );
    mockFetch.mockResolvedValueOnce(commit(mergeBase, baseTree));
    mockFetch.mockResolvedValueOnce(commit(head, headTree));
    mockFetch.mockResolvedValueOnce(tree([], baseTree));
    mockFetch.mockResolvedValueOnce(tree([entry('new.ts', sha)], headTree));
    mockFetch.mockResolvedValueOnce(blob('trusted\n', sha));
    mockFetch.mockResolvedValueOnce(pull());
    await expect(
      fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
    ).resolves.toMatchObject({
      files: [{ path: 'new.ts', content: 'trusted\n' }],
    });
    expect(mockFetch.mock.calls.map(([url]) => String(url)).join('\n')).not.toContain(
      'evil.invalid',
    );
  });

  it.each([
    ['empty changed set', [], []],
    ['rename evidence', [entry('old.ts', '1'.repeat(40))], [entry('new.ts', '2'.repeat(40))]],
    [
      'blob-to-tree transition',
      [entry('node', '1'.repeat(40))],
      [entry('node', '2'.repeat(40), '040000', 'tree')],
    ],
    [
      'commit transition',
      [entry('node', '1'.repeat(40))],
      [entry('node', '2'.repeat(40), '160000', 'commit')],
    ],
  ])('fails closed for %s changed-set evidence', async (_name, before, after) => {
    queueSnapshot(before, after, []);
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
  });

  it('hydrates executable blobs, ignores unchanged special entries, and accepts an empty text blob', async () => {
    const executable = '1'.repeat(40);
    const unchangedLink = '2'.repeat(40);
    const unchangedGitlink = '3'.repeat(40);
    queueSnapshot(
      [
        entry('link', unchangedLink, '120000'),
        entry('module', unchangedGitlink, '160000', 'commit'),
      ],
      [
        entry('bin/run', executable, '100755'),
        entry('link', unchangedLink, '120000'),
        entry('module', unchangedGitlink, '160000', 'commit'),
      ],
      [blob('', executable)],
    );
    await expect(
      fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
    ).resolves.toMatchObject({
      files: [{ path: 'bin/run', content: '' }],
    });
  });

  it('rejects runtime input and generated-diff limits without continuing to the final PR read', async () => {
    const inputBefore = Array.from({ length: 4 }, (_, index) =>
      entry(`input-${index}.ts`, `${index + 1}`.repeat(40)),
    );
    const inputAfter = Array.from({ length: 4 }, (_, index) =>
      entry(`input-${index}.ts`, `${index + 5}`.repeat(40)),
    );
    const inputBlob = 'a'.repeat(270 * 1024);
    queueSnapshot(
      inputBefore,
      inputAfter,
      inputBefore.flatMap((before, index) => [
        blob(inputBlob, before.sha),
        blob('b'.repeat(270 * 1024), inputAfter[index].sha),
      ]),
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(14);

    mockFetch.mockReset();
    const diffBefore = Array.from({ length: 100 }, (_, index) =>
      entry(`diff-${String(index).padStart(3, '0')}.ts`, `${index}`.padStart(40, '1')),
    );
    const diffAfter = Array.from({ length: 100 }, (_, index) =>
      entry(`diff-${String(index).padStart(3, '0')}.ts`, `${index}`.padStart(40, '2')),
    );
    queueSnapshot(
      diffBefore,
      diffAfter,
      diffBefore.flatMap((before, index) => [
        blob('a\n'.repeat(5000), before.sha),
        blob('b\n'.repeat(5000), diffAfter[index].sha),
      ]),
    );
    await expect(fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token')).resolves.toBeNull();
    expect(mockFetch.mock.calls.length).toBeGreaterThan(6);
    expect(mockFetch.mock.calls.length).toBeLessThan(207);
  });

  it('sorts manifests deterministically and renders documented empty added-file headers', async () => {
    const first = '1'.repeat(40);
    const second = '2'.repeat(40);
    queueSnapshot(
      [],
      [entry('z.ts', second), entry('a.ts', first)],
      [blob('', first), blob('z\n', second)],
    );
    const result = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token');
    expect(result?.files.map((file) => file.path)).toEqual(['a.ts', 'z.ts']);
    expect(result?.diff).toBe(
      'diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/z.ts\n@@ -0,0 +1 @@\n+z\n',
    );

    mockFetch.mockReset();
    queueSnapshot([], [entry('bin/run', first, '100755')], [blob('', first)]);
    const executable = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token');
    expect(executable?.diff).toBe('diff --git a/bin/run b/bin/run\nnew file mode 100755\n');
  });

  it('renders same-path empty-before and empty-after modifications as ordinary unified hunks', async () => {
    const beforeSha = '1'.repeat(40);
    const afterSha = '2'.repeat(40);
    queueSnapshot(
      [entry('a.ts', beforeSha)],
      [entry('a.ts', afterSha)],
      [blob('', beforeSha), blob('after\n', afterSha)],
    );
    await expect(
      fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
    ).resolves.toMatchObject({
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+after\n',
      files: [{ path: 'a.ts', content: 'after\n' }],
    });

    mockFetch.mockReset();
    queueSnapshot(
      [entry('a.ts', beforeSha)],
      [entry('a.ts', afterSha)],
      [blob('before\n', beforeSha), blob('', afterSha)],
    );
    await expect(
      fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token'),
    ).resolves.toMatchObject({
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +0,0 @@\n-before\n',
      files: [{ path: 'a.ts', content: '' }],
    });
  });

  it.each([403, 500])(
    'propagates operational %i failures without exposing credentials or blob content',
    async (status) => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        statusText: 'failure with token secret-content',
        headers: { get: () => null },
      });
      const error = await fetchRevisionPinnedSnapshot('octo', 'demo', 7, head, 'token').catch(
        (reason: unknown) => reason,
      );
      expect(error).toMatchObject({ status });
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toBe(`GitHub API error fetching PR snapshot: ${status}`);
      expect(error.message).not.toContain('token');
      expect(error.message).not.toContain('secret-content');
    },
  );
});

describe('explanation publication transport', () => {
  const mockFetch = vi.fn();
  const reference = {
    forgeInstance: 'github.com',
    installationId: 'installation-42',
    repositoryId: 'repository-99',
    changeRequest: {
      repo: { kind: 'github' as const, nativeId: 'repository-99', path: 'octo/demo' },
      iid: 7,
      globalId: 'PR_7',
    },
    ownerId: '42',
    channel: 'answer' as const,
    invocationId: 'invocation-1',
  };

  const marker = (value = reference) => {
    const encoded = Buffer.from(
      JSON.stringify([
        value.forgeInstance,
        value.installationId,
        value.repositoryId,
        value.changeRequest.repo.kind,
        value.changeRequest.repo.nativeId,
        value.changeRequest.iid,
        value.changeRequest.globalId,
        value.ownerId,
        value.channel,
        value.invocationId,
      ]),
    ).toString('base64url');
    return `<!-- ghagga-explanation:v1:${encoded} -->`;
  };

  const ownedComment = (id: unknown, body = marker()) => ({
    id,
    body,
    user: { id: 42, type: 'Bot' },
  });

  const response = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Failure',
    json: () => Promise.resolve(body),
  });

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds only one exact, bot-owned explanation marker and rejects review-marker spoofs', async () => {
    mockFetch.mockResolvedValueOnce(
      response([
        ownedComment(11, '<!-- ghagga-review -->'),
        { ...ownedComment(12, 'answer'), user: { id: 99, type: 'Bot' } },
      ]),
    );

    await expect(findExplanationComment('octo', 'demo', 7, reference, 'token')).resolves.toEqual({
      kind: 'ABSENT',
    });
  });

  it('returns the exact FOUND record for one exact, bot-owned explanation marker', async () => {
    mockFetch.mockResolvedValueOnce(response([ownedComment(501)]));

    await expect(findExplanationComment('octo', 'demo', 7, reference, 'token')).resolves.toEqual({
      kind: 'FOUND',
      commentId: { kind: 'github:issue-comment', raw: 501 },
      reference,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns incomplete for duplicate markers, incomplete scans, and malformed payloads', async () => {
    const referenceWithProgress = { ...reference, channel: 'progress' as const };
    mockFetch.mockResolvedValueOnce(response([ownedComment(11), ownedComment(12)]));
    await expect(
      findExplanationComment('octo', 'demo', 7, reference, 'token'),
    ).resolves.toMatchObject({ kind: 'INCOMPLETE' });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      response(Array.from({ length: 100 }, (_, index) => ownedComment(index + 1))),
    );
    await expect(
      findExplanationComment('octo', 'demo', 7, referenceWithProgress, 'token'),
    ).resolves.toMatchObject({ kind: 'INCOMPLETE' });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(response({ comments: [] }));
    await expect(
      findExplanationComment('octo', 'demo', 7, reference, 'token'),
    ).resolves.toMatchObject({ kind: 'INCOMPLETE' });
  });

  it('creates one marker-bearing comment and rejects HTTP or malformed responses', async () => {
    mockFetch.mockResolvedValueOnce(response(ownedComment(501, 'answer')));
    await expect(
      createExplanationComment('octo', 'demo', 7, reference, 'answer', 'token'),
    ).resolves.toEqual({ id: 501 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ body: `answer\n\n${marker()}` }),
    });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(response({}, 500));
    await expect(
      createExplanationComment('octo', 'demo', 7, reference, 'answer', 'token'),
    ).rejects.toMatchObject({ status: 500 });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(response(ownedComment('not-a-number')));
    await expect(
      createExplanationComment('octo', 'demo', 7, reference, 'answer', 'token'),
    ).rejects.toThrow(TypeError);
  });

  it('rejects a create response with the wrong bot type without extra I/O', async () => {
    mockFetch.mockResolvedValueOnce(
      response({ ...ownedComment(501), user: { id: 42, type: 'User' } }),
    );

    await expect(
      createExplanationComment('octo', 'demo', 7, reference, 'answer', 'token'),
    ).rejects.toThrow(TypeError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a create response with the wrong numeric owner without extra I/O', async () => {
    mockFetch.mockResolvedValueOnce(
      response({ ...ownedComment(501), user: { id: 43, type: 'Bot' } }),
    );

    await expect(
      createExplanationComment('octo', 'demo', 7, reference, 'answer', 'token'),
    ).rejects.toThrow(TypeError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('confirms the exact owned comment before one update attempt and rejects mismatches', async () => {
    mockFetch
      .mockResolvedValueOnce(response(ownedComment(501, `previous answer\n${marker()}`)))
      .mockResolvedValueOnce(response(ownedComment(501, 'answer')));
    await expect(
      updateExplanationComment('octo', 'demo', 501, reference, 'answer', 'token'),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ body: `answer\n\n${marker()}` }),
    });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      response({ id: 501, body: 'spoof', user: { id: 42, type: 'Bot' } }),
    );
    await expect(
      updateExplanationComment('octo', 'demo', 501, reference, 'answer', 'token'),
    ).rejects.toThrow(TypeError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an update response with the wrong bot type after exact owned preflight', async () => {
    mockFetch
      .mockResolvedValueOnce(response(ownedComment(501, `previous answer\n${marker()}`)))
      .mockResolvedValueOnce(response({ ...ownedComment(501), user: { id: 42, type: 'User' } }));

    await expect(
      updateExplanationComment('octo', 'demo', 501, reference, 'answer', 'token'),
    ).rejects.toThrow(TypeError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an update response with the wrong numeric owner after exact owned preflight', async () => {
    mockFetch
      .mockResolvedValueOnce(response(ownedComment(501, `previous answer\n${marker()}`)))
      .mockResolvedValueOnce(response({ ...ownedComment(501), user: { id: 43, type: 'Bot' } }));

    await expect(
      updateExplanationComment('octo', 'demo', 501, reference, 'answer', 'token'),
    ).rejects.toThrow(TypeError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('GitHub App bot author resolution and shared JWT minting', () => {
  const mockFetch = vi.fn();
  const fixedNow = 1_700_000_000_000;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();
  const appId = 'github-app-id';
  const installationToken = 'installation-token';

  const response = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'failure',
    json: () => Promise.resolve(body),
  });
  const resolveWithRuntimeCredentials = (...credentials: unknown[]) =>
    Reflect.apply(resolveGitHubAppBotAuthorId, undefined, credentials);

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves only a verified numeric bot user after separately authenticated fixed-origin requests', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ id: 11, owner: { id: 12 }, slug: 'trusted-app' }))
      .mockResolvedValueOnce(response({ id: 42, login: 'trusted-app[bot]', type: 'Bot' }));

    await expect(
      resolveGitHubAppBotAuthorId(appId, privateKeyPem, installationToken),
    ).resolves.toEqual({
      kind: 'RESOLVED',
      id: 42,
      slug: 'trusted-app',
      login: 'trusted-app[bot]',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.github.com/app');
    expect(mockFetch.mock.calls[1]?.[0]).toBe('https://api.github.com/users/trusted-app%5Bbot%5D');
    const appRequest = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const userRequest = mockFetch.mock.calls[1]?.[1] as RequestInit;
    expect(appRequest).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(userRequest).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(appRequest.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(userRequest.headers).toMatchObject({
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect((appRequest.headers as Record<string, string>).Authorization).not.toBe(
      (userRequest.headers as Record<string, string>).Authorization,
    );
    expect((userRequest.headers as Record<string, string>).Authorization).not.toContain('.');
  });

  it.each([
    ['empty app id', '', privateKeyPem, installationToken],
    ['blank app id', ' ', privateKeyPem, installationToken],
    ['surrounding app-id whitespace', ' app', privateKeyPem, installationToken],
    ['app-id control character', 'app\nname', privateKeyPem, installationToken],
    ['empty installation token', appId, privateKeyPem, ''],
    ['blank installation token', appId, privateKeyPem, ' '],
    ['surrounding installation-token whitespace', appId, privateKeyPem, ' token'],
    ['installation-token control character', appId, privateKeyPem, 'token\tvalue'],
    ['malformed private key', appId, 'not a private key', installationToken],
  ])(
    'fails closed before I/O for %s',
    async (_name, candidateAppId, candidateKey, candidateToken) => {
      await expect(
        resolveGitHubAppBotAuthorId(candidateAppId, candidateKey, candidateToken),
      ).resolves.toEqual({ kind: 'UNCERTAIN' });
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing app id', [undefined, privateKeyPem, installationToken]],
    ['null app id', [null, privateKeyPem, installationToken]],
    ['numeric app id', [42, privateKeyPem, installationToken]],
    ['missing private key', [appId, undefined, installationToken]],
    ['null private key', [appId, null, installationToken]],
    ['numeric private key', [appId, 42, installationToken]],
    ['missing installation token', [appId, privateKeyPem, undefined]],
    ['null installation token', [appId, privateKeyPem, null]],
    ['numeric installation token', [appId, privateKeyPem, 42]],
  ])('fails closed before I/O for runtime %s', async (_name, credentials) => {
    await expect(resolveWithRuntimeCredentials(...credentials)).resolves.toEqual({
      kind: 'UNCERTAIN',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP 401', () => response({}, 401)],
    ['HTTP 403', () => response({}, 403)],
    ['HTTP 404', () => response({}, 404)],
    ['HTTP 500', () => response({}, 500)],
    ['thrown timeout', () => Promise.reject(new Error('credential=private-key timeout'))],
    [
      'JSON parse failure',
      () => ({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }),
    ],
    ['null payload', () => response(null)],
    ['array payload', () => response([])],
    ['missing slug', () => response({ id: 11 })],
    ['dangerous dot slug', () => response({ slug: 'trusted.app' })],
    ['dangerous slash slug', () => response({ slug: 'trusted/app' })],
    ['dangerous backslash slug', () => response({ slug: 'trusted\\app' })],
    ['dangerous percent slug', () => response({ slug: 'trusted%app' })],
    ['dangerous space slug', () => response({ slug: 'trusted app' })],
    ['dangerous query slug', () => response({ slug: 'trusted?app' })],
    ['dangerous hash slug', () => response({ slug: 'trusted#app' })],
    ['dangerous control slug', () => response({ slug: 'trusted\napp' })],
  ])(
    'returns uncertain without a user lookup when app metadata has %s',
    async (_name, appResponse) => {
      mockFetch.mockImplementationOnce(appResponse);
      await expect(
        resolveGitHubAppBotAuthorId(appId, privateKeyPem, installationToken),
      ).resolves.toEqual({ kind: 'UNCERTAIN' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['HTTP 401', () => response({}, 401)],
    ['HTTP 403', () => response({}, 403)],
    ['HTTP 404', () => response({}, 404)],
    ['HTTP 500', () => response({}, 500)],
    ['thrown timeout', () => Promise.reject(new Error('token=installation-token timeout'))],
    [
      'JSON parse failure',
      () => ({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }),
    ],
    ['null payload', () => response(null)],
    ['array payload', () => response([])],
    ['missing id', () => response({ login: 'trusted-app[bot]', type: 'Bot' })],
    ['string id', () => response({ id: '42', login: 'trusted-app[bot]', type: 'Bot' })],
    ['decimal id', () => response({ id: 1.5, login: 'trusted-app[bot]', type: 'Bot' })],
    ['zero id', () => response({ id: 0, login: 'trusted-app[bot]', type: 'Bot' })],
    ['negative id', () => response({ id: -1, login: 'trusted-app[bot]', type: 'Bot' })],
    [
      'unsafe id',
      () => response({ id: Number.MAX_SAFE_INTEGER + 1, login: 'trusted-app[bot]', type: 'Bot' }),
    ],
    ['missing type', () => response({ id: 42, login: 'trusted-app[bot]' })],
    ['wrong type', () => response({ id: 42, login: 'trusted-app[bot]', type: 'User' })],
    ['login mismatch', () => response({ id: 42, login: 'other-app[bot]', type: 'Bot' })],
  ])('returns uncertain without retries when the bot user has %s', async (_name, userResponse) => {
    mockFetch.mockResolvedValueOnce(response({ slug: 'trusted-app' }));
    mockFetch.mockImplementationOnce(userResponse);
    await expect(
      resolveGitHubAppBotAuthorId(appId, privateKeyPem, installationToken),
    ).resolves.toEqual({ kind: 'UNCERTAIN' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh 10000ms abort signal for each request and does not cache successful resolution', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue({} as AbortSignal);
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        response({ slug: 'trusted-app', id: 42, login: 'trusted-app[bot]', type: 'Bot' }),
      ),
    );

    await resolveGitHubAppBotAuthorId(appId, privateKeyPem, installationToken);
    await resolveGitHubAppBotAuthorId(appId, privateKeyPem, installationToken);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(timeout).toHaveBeenCalledTimes(4);
    expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
    expect(timeout).toHaveBeenNthCalledWith(4, 10_000);
  });

  it('never exposes raw failures or credentials in its generic uncertain outcome or logs', async () => {
    const secret = 'private-key-and-token-secret';
    const errorSpy = vi.spyOn(logger, 'error');
    mockFetch.mockRejectedValueOnce(new Error(secret));

    const result = await resolveGitHubAppBotAuthorId(appId, privateKeyPem, secret);

    expect(result).toEqual({ kind: 'UNCERTAIN' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('shares a cryptographically valid RS256 App JWT with installation minting and preserves mint semantics', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    mockFetch.mockResolvedValueOnce(
      response({ token: 'minted-installation-token', expires_at: '2024-01-02T03:04:05.000Z' }),
    );

    await expect(
      getInstallationTokenWithExpiry(99, appId, privateKeyPem, { repositoryIds: [7, 8] }),
    ).resolves.toEqual({
      token: 'minted-installation-token',
      expiresAtMs: Date.parse('2024-01-02T03:04:05.000Z'),
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const jwt = (request.headers as Record<string, string>).Authorization.slice('Bearer '.length);
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))).toEqual({
      iat: fixedNow / 1000 - 60,
      exp: fixedNow / 1000 + 600,
      iss: appId,
    });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    expect(verifier.verify(publicKey, Buffer.from(encodedSignature, 'base64url'))).toBe(true);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/app/installations/99/access_tokens',
    );
    expect(request).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ repository_ids: [7, 8] }),
    });
  });

  it.each([undefined, 'not a date'])(
    'uses the legacy fallback expiry and string wrapper when expires_at is %s',
    async (expiresAt) => {
      vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      mockFetch.mockResolvedValueOnce(response({ token: 'first-token', expires_at: expiresAt }));
      await expect(getInstallationTokenWithExpiry(99, appId, privateKeyPem)).resolves.toEqual({
        token: 'first-token',
        expiresAtMs: fixedNow + 55 * 60 * 1000,
      });

      mockFetch.mockResolvedValueOnce(response({ token: 'wrapper-token' }));
      await expect(getInstallationToken(99, appId, privateKeyPem)).resolves.toBe('wrapper-token');
    },
  );
});
