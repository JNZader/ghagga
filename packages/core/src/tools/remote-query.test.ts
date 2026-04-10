import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRemoteFile, searchRemoteCode } from './remote-query.js';

// ─── fetch mock setup ───────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────

function makeResponse(body: string | object, ok = true, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(text) : body),
  } as unknown as Response;
}

// ─── fetchRemoteFile ────────────────────────────────────────────

describe('fetchRemoteFile', () => {
  const opts = { owner: 'octocat', repo: 'Hello-World' };

  it('returns file content on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse("console.log('hello')"));
    const result = await fetchRemoteFile('src/index.js', opts);
    expect(result).toBe("console.log('hello')");
  });

  it('constructs the correct raw URL with default ref', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse('content'));
    await fetchRemoteFile('README.md', opts);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toBe('https://raw.githubusercontent.com/octocat/Hello-World/HEAD/README.md');
  });

  it('uses the provided ref in the URL', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse('content'));
    await fetchRemoteFile('README.md', { ...opts, ref: 'main' });
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('/main/');
  });

  it('adds Authorization header when token is provided', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse('content'));
    await fetchRemoteFile('README.md', opts, 'my-token');
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
  });

  it('returns null when response is not ok (404)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse('Not Found', false, 404));
    const result = await fetchRemoteFile('missing.ts', opts);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await fetchRemoteFile('src/index.ts', opts);
    expect(result).toBeNull();
  });
});

// ─── searchRemoteCode ───────────────────────────────────────────

describe('searchRemoteCode', () => {
  const opts = { owner: 'octocat', repo: 'Hello-World' };

  const searchResponse = {
    items: [
      {
        path: 'src/auth.ts',
        text_matches: [{ fragment: 'function authenticate()' }],
      },
      {
        path: 'src/utils.ts',
        text_matches: [],
      },
    ],
  };

  it('returns mapped items on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(searchResponse));
    const result = await searchRemoteCode('authenticate', opts);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ path: 'src/auth.ts', snippet: 'function authenticate()' });
    expect(result[1]).toEqual({ path: 'src/utils.ts', snippet: '' });
  });

  it('scopes query to the repo', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ items: [] }));
    await searchRemoteCode('useState', opts);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain(encodeURIComponent('repo:octocat/Hello-World'));
  });

  it('sets the text-match Accept header', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ items: [] }));
    await searchRemoteCode('foo', opts);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Accept).toBe(
      'application/vnd.github.v3.text-match+json',
    );
  });

  it('adds Authorization header when token is provided', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ items: [] }));
    await searchRemoteCode('foo', opts, 'ghp_token');
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_token');
  });

  it('returns empty array on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse('Forbidden', false, 403));
    const result = await searchRemoteCode('foo', opts);
    expect(result).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));
    const result = await searchRemoteCode('foo', opts);
    expect(result).toEqual([]);
  });
});
