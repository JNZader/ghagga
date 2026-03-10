/**
 * Tests for Dashboard OAuth helpers: isServerAvailable and fetchGitHubUser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubUser, GITHUB_CLIENT_ID, isServerAvailable } from './oauth';

// ─── Mocks ──────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

describe('GITHUB_CLIENT_ID', () => {
  it('exports the expected OAuth client ID', () => {
    expect(GITHUB_CLIENT_ID).toBe('Iv23liP63ERrlq0eMUfk');
  });
});

// ═══════════════════════════════════════════════════════════════════
// isServerAvailable
// ═══════════════════════════════════════════════════════════════════

describe('isServerAvailable', () => {
  it('returns true when /health responds ok', async () => {
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const result = await isServerAvailable();

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/health');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns false when fetch throws (network error)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await isServerAvailable();

    expect(result).toBe(false);
  });

  it('returns false when response is not ok (500)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const result = await isServerAvailable();

    expect(result).toBe(false);
  });

  it('returns false when request is aborted (timeout)', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    const result = await isServerAvailable();

    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// fetchGitHubUser
// ═══════════════════════════════════════════════════════════════════

describe('fetchGitHubUser', () => {
  it('returns GitHubUser on success', async () => {
    const user = { login: 'testuser', id: 42, avatar_url: 'https://example.com/avatar.png' };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await fetchGitHubUser('ghp_test-token');

    expect(result).toEqual(user);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect(options.headers.Authorization).toBe('Bearer ghp_test-token');
  });

  it('throws "Invalid or expired token" on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    await expect(fetchGitHubUser('bad-token')).rejects.toThrow('Invalid or expired token');
  });
});
