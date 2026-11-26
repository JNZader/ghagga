import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPullReviewComment, GitHubApiError, listPullReviewComments } from './client.js';

describe('pull review comments', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists inline comments and drops malformed rows', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 7, body: '<!-- ghagga-inline:a.ts:1:security -->' },
          { id: 'nope', body: 'skip' },
          { id: 8, body: 'plain' },
        ]),
    });

    await expect(listPullReviewComments('octo', 'demo', 4, 'tok')).resolves.toEqual([
      { id: 7, body: '<!-- ghagga-inline:a.ts:1:security -->' },
      { id: 8, body: 'plain' },
    ]);
    expect(mockFetch.mock.calls[0]?.[0]).toContain(
      '/repos/octo/demo/pulls/4/comments?per_page=100',
    );
  });

  it('posts an inline comment anchored to the head commit and the new side', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 99 }),
    });

    await expect(
      createPullReviewComment(
        'octo',
        'demo',
        4,
        { body: 'fix this', commitId: 'abc123', path: 'src/a.ts', line: 12 },
        'tok',
      ),
    ).resolves.toEqual({ id: 99 });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      body: 'fix this',
      commit_id: 'abc123',
      path: 'src/a.ts',
      line: 12,
      side: 'RIGHT',
    });
  });

  it('throws GitHubApiError with the status when GitHub rejects the line', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422, statusText: 'Unprocessable Entity' });

    await expect(
      createPullReviewComment(
        'octo',
        'demo',
        4,
        { body: 'x', commitId: 'abc', path: 'src/a.ts', line: 1 },
        'tok',
      ),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
