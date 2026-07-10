/**
 * R-CLI: the `--pr` post-back routes through the REAL GitHubForgeAdapter folding
 * over the CLI's own GitHubClientPort. We mock ONLY `fetch` (the network seam),
 * so this exercises the genuine adapter find→delete→post idempotency path and
 * the genuine CLI port REST calls — a faithful simulation against a mocked
 * GitHub.
 */

import { REVIEW_COMMENT_MARKER } from 'ghagga-core';
import { GitHubForgeAdapter } from 'ghagga-forge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliGitHubClientPort } from './cli-github-client-port.js';
import { postSummaryComment } from './pr-postback.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'ERR',
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

const MARKER = { html: REVIEW_COMMENT_MARKER };
const REF = {
  repo: { kind: 'github' as const, nativeId: 'acme/widgets', path: 'acme/widgets' },
  iid: 42,
};

function buildAdapter(token = 'tok'): GitHubForgeAdapter {
  return new GitHubForgeAdapter({
    client: createCliGitHubClientPort(),
    token,
    owner: 'acme',
    repo: 'widgets',
  });
}

describe('postSummaryComment via CLI port + GitHubForgeAdapter', () => {
  beforeEach(() => mockFetch.mockReset());

  it('posts a fresh comment when none exists (no stale to delete)', async () => {
    // findExistingComment: empty list → null
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    // postComment → { id }
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 9001 }));

    const adapter = buildAdapter();
    const body = `${REVIEW_COMMENT_MARKER}\n## body`;
    const result = await postSummaryComment(adapter, REF, body, MARKER);

    expect(result.createdNativeId).toBe(9001);
    expect(result.deletedNativeIds).toEqual([]);

    // 1 list call + 1 post call.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [listUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toContain('/repos/acme/widgets/issues/42/comments');

    const [postUrl, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe('https://api.github.com/repos/acme/widgets/issues/42/comments');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({ body });
  });

  it('finds stale → updates latest IN PLACE → prunes only stale duplicates (idempotent upsert + marker)', async () => {
    // list returns two GHAGGA comments (with marker) + one foreign comment
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 100, body: `old ${REVIEW_COMMENT_MARKER}` },
        { id: 200, body: 'someone else' },
        { id: 300, body: `newer ${REVIEW_COMMENT_MARKER}` },
      ]),
    );
    // FORGE-UPSERT-005: updateComment(latest=300) IN PLACE first...
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 300 }));
    // ...then deleteComment(stale=100) only after the update confirms success.
    mockFetch.mockResolvedValueOnce(jsonResponse(204, {}));

    const adapter = buildAdapter();
    const result = await postSummaryComment(adapter, REF, 'body', MARKER);

    // "created" now carries the id of the comment currently holding the review
    // body — the updated latest (300), NOT a freshly posted comment.
    expect(result.createdNativeId).toBe(300);
    // The latest (300) is updated, never deleted; only the stale duplicate (100) is pruned.
    expect(result.deletedNativeIds).toEqual([100]);

    // Update happens in place (PATCH) on the latest, before any delete.
    const updateCall = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(updateCall[0]).toContain('/issues/comments/300');
    expect(updateCall[1].method).toBe('PATCH');
    expect(JSON.parse(updateCall[1].body as string)).toEqual({ body: 'body' });
    const delCall = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(delCall[0]).toContain('/issues/comments/100');
    expect(delCall[1].method).toBe('DELETE');
    // The latest (300) is updated, never the target of a DELETE.
    const deleteUrls = mockFetch.mock.calls
      .filter((c) => (c[1] as RequestInit).method === 'DELETE')
      .map((c) => c[0] as string);
    expect(deleteUrls.some((u) => u.includes('/issues/comments/300'))).toBe(false);
    // foreign comment (200) is never touched.
    const allUrls = mockFetch.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allUrls).not.toContain('/issues/comments/200');
    // No fresh POST on the replace path — the update carried the body.
    const methods = mockFetch.mock.calls.map((c) => (c[1] as RequestInit).method);
    expect(methods).not.toContain('POST');
  });

  it('a 401 with the static token is fatal (no invalidate-retry)', async () => {
    // findExistingComment → 401
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { message: 'bad creds' }));
    const adapter = buildAdapter();
    await expect(postSummaryComment(adapter, REF, 'body', MARKER)).rejects.toThrow();
    // exactly one call — no retry loop.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('passes an AbortSignal (timeout) on every fetch so CI cannot hang', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 1 }));
    const adapter = buildAdapter();
    await postSummaryComment(adapter, REF, 'body', MARKER);
    // Both the list (find) and the post fetch carry an abort signal.
    for (const call of mockFetch.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('sends Bearer auth + version headers on the post', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 1 }));
    const adapter = buildAdapter('secret-token');
    await postSummaryComment(adapter, REF, 'body', MARKER);
    const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = postInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });
});

describe('CLI GitHub port — findExistingComment pagination (backlog #6)', () => {
  beforeEach(() => mockFetch.mockReset());

  function makeComments(count: number, startId = 0, markerAt?: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: startId + i,
      body:
        i === markerAt ? `summary ${startId + i} ${REVIEW_COMMENT_MARKER}` : `noise ${startId + i}`,
    }));
  }

  it('single page (< 100 comments) → exactly one list call, no extra fetch', async () => {
    const port = createCliGitHubClientPort();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, makeComments(20, 0)));
    const result = await port.findExistingComment('acme', 'widgets', 42, 'tok');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0] as string).toContain('page=1');
  });

  it('multi-page → full page 1 forces page 2 fetch; stale-on-page-2 found + updated in place (no duplicate)', async () => {
    // page 1: 100 comments, NO marker → must fetch page 2; page 2 carries the sole marker.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, makeComments(100, 0)));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, makeComments(15, 100, 5))); // marker id 105
    // FORGE-UPSERT-005: single GHAGGA comment → update it in place, nothing to prune.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 105 })); // update 105

    const adapter = buildAdapter();
    const result = await postSummaryComment(adapter, REF, 'body', MARKER);

    // Sole comment (105) is updated in place: it carries the body, nothing is deleted.
    expect(result.deletedNativeIds).toEqual([]);
    expect(result.createdNativeId).toBe(105);
    expect(mockFetch.mock.calls[0][0] as string).toContain('page=1');
    expect(mockFetch.mock.calls[1][0] as string).toContain('page=2');
    const updateCall = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(updateCall[0]).toContain('/issues/comments/105');
    expect(updateCall[1].method).toBe('PATCH');
    // No DELETE and no POST — the sole comment is updated, not replaced.
    const methods = mockFetch.mock.calls.map((c) => (c[1] as RequestInit).method);
    expect(methods).not.toContain('DELETE');
    expect(methods).not.toContain('POST');
  });

  it('safety bound → stops at MAX_PAGES (50) and warns instead of looping forever', async () => {
    for (let page = 0; page < 50; page++) {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeComments(100, page * 100)));
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = createCliGitHubClientPort();
    const result = await port.findExistingComment('acme', 'widgets', 42, 'tok');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(50);
    expect(mockFetch.mock.calls[49][0] as string).toContain('page=50');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MAX_PAGES (50)'));
    warnSpy.mockRestore();
  });
});

describe('CLI port stub safety (read members never hit in --pr flow)', () => {
  it('the --pr post-back never invokes any stubbed read member', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 5 }));

    const port = createCliGitHubClientPort();
    // Spy on the stubs — if the post-back path touched them they'd throw, but
    // assert explicitly they were never called.
    const fetchPRDiff = vi.spyOn(port, 'fetchPRDiff');
    const getPRFileList = vi.spyOn(port, 'getPRFileList');
    const getPRCommitMessages = vi.spyOn(port, 'getPRCommitMessages');
    const fetchPRDetails = vi.spyOn(port, 'fetchPRDetails');
    const addCommentReaction = vi.spyOn(port, 'addCommentReaction');
    const fetchGraphFromBranch = vi.spyOn(port, 'fetchGraphFromBranch');
    const fetchGraphMetadata = vi.spyOn(port, 'fetchGraphMetadata');

    const adapter = new GitHubForgeAdapter({ client: port, token: 't', owner: 'a', repo: 'b' });
    await postSummaryComment(adapter, REF, 'body', MARKER);

    expect(fetchPRDiff).not.toHaveBeenCalled();
    expect(getPRFileList).not.toHaveBeenCalled();
    expect(getPRCommitMessages).not.toHaveBeenCalled();
    expect(fetchPRDetails).not.toHaveBeenCalled();
    expect(addCommentReaction).not.toHaveBeenCalled();
    expect(fetchGraphFromBranch).not.toHaveBeenCalled();
    expect(fetchGraphMetadata).not.toHaveBeenCalled();
  });

  it('each stubbed read member throws a clear "not supported in CLI" error', async () => {
    const port = createCliGitHubClientPort();
    await expect(port.fetchPRDiff('a', 'b', 1, 't')).rejects.toThrow(/not supported in CLI/);
    await expect(port.fetchPRDetails('a', 'b', 1, 't')).rejects.toThrow(/not supported in CLI/);
    await expect(port.getPRFileList('a', 'b', 1, 't')).rejects.toThrow(/not supported in CLI/);
    await expect(port.getPRCommitMessages('a', 'b', 1, 't')).rejects.toThrow(
      /not supported in CLI/,
    );
    await expect(port.addCommentReaction('a', 'b', 1, '+1', 't')).rejects.toThrow(
      /not supported in CLI/,
    );
    await expect(port.fetchGraphFromBranch('a', 'b', 't')).rejects.toThrow(/not supported in CLI/);
    await expect(port.fetchGraphMetadata('a', 'b', 't')).rejects.toThrow(/not supported in CLI/);
  });
});
