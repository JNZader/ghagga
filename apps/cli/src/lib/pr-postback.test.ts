/**
 * R-CLI: the `--pr` post-back routes through the REAL GitHubForgeAdapter folding
 * over the CLI's own GitHubClientPort. We mock ONLY `fetch` (the network seam),
 * so this exercises the genuine adapter find→delete→post idempotency path and
 * the genuine CLI port REST calls — a faithful simulation against a mocked
 * GitHub.
 */

import { REVIEW_COMMENT_MARKER } from 'ghagga-core';
import { GitHubForgeAdapter, githubCommentId } from 'ghagga-forge';
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

    expect(result.commentId).toEqual(githubCommentId(9001));
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

  it('finds stale → deletes ALL → reposts fresh (idempotent upsert + marker)', async () => {
    // list returns two GHAGGA comments (with marker) + one foreign comment
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 100, body: `old ${REVIEW_COMMENT_MARKER}` },
        { id: 200, body: 'someone else' },
        { id: 300, body: `newer ${REVIEW_COMMENT_MARKER}` },
      ]),
    );
    // deleteComment(latest=300), deleteComment(stale=100)
    mockFetch.mockResolvedValueOnce(jsonResponse(204, {}));
    mockFetch.mockResolvedValueOnce(jsonResponse(204, {}));
    // postComment fresh
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 400 }));

    const adapter = buildAdapter();
    const result = await postSummaryComment(adapter, REF, 'body', MARKER);

    expect(result.commentId).toEqual(githubCommentId(400));
    // delete order: latest first, then stale.
    expect(result.deletedNativeIds).toEqual([300, 100]);

    const delCall1 = mockFetch.mock.calls[1] as [string, RequestInit];
    const delCall2 = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(delCall1[0]).toContain('/issues/comments/300');
    expect(delCall1[1].method).toBe('DELETE');
    expect(delCall2[0]).toContain('/issues/comments/100');
    // foreign comment (200) is never deleted.
    const allUrls = mockFetch.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allUrls).not.toContain('/issues/comments/200');
  });

  it('a 401 with the static token is fatal (no invalidate-retry)', async () => {
    // findExistingComment → 401
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { message: 'bad creds' }));
    const adapter = buildAdapter();
    await expect(postSummaryComment(adapter, REF, 'body', MARKER)).rejects.toThrow();
    // exactly one call — no retry loop.
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
