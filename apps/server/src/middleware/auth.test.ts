/**
 * Auth middleware tests.
 *
 * Tests token verification via GitHub API, user-installation lookups,
 * and auto-discovery of installations on first login.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware, cleanupExpiredTokens, cleanupInterval, tokenCache } from './auth.js';

// ─── Mocks ──────────────────────────────────────────────────────

const mockGetInstallationsByUserId = vi.fn();
const mockGetInstallationsByAccountLogin = vi.fn();
const mockUpsertUserMapping = vi.fn();
const mockGetRawMappingsByUserId = vi.fn();
const mockDeleteStaleUserMappings = vi.fn();

vi.mock('ghagga-db', () => ({
  getInstallationsByUserId: (...args: unknown[]) => mockGetInstallationsByUserId(...args),
  getInstallationsByAccountLogin: (...args: unknown[]) =>
    mockGetInstallationsByAccountLogin(...args),
  upsertUserMapping: (...args: unknown[]) => mockUpsertUserMapping(...args),
  getRawMappingsByUserId: (...args: unknown[]) => mockGetRawMappingsByUserId(...args),
  deleteStaleUserMappings: (...args: unknown[]) => mockDeleteStaleUserMappings(...args),
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ─── Helpers ────────────────────────────────────────────────────

const mockFetch = vi.fn();
// biome-ignore lint/suspicious/noExplicitAny: mock cast
const mockDb = {} as any;

function createApp() {
  const app = new Hono();
  app.use('*', authMiddleware(mockDb));
  // Test route that returns the user context
  app.get('/test', (c) => {
    const user = c.get('user');
    return c.json({ user });
  });
  return app;
}

function _makeAuthRequest(token?: string) {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request('http://localhost/test', { headers });
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  tokenCache.clear();
});

afterEach(() => {
  tokenCache.clear();
});

// ─── Missing/Invalid Authorization ──────────────────────────────

describe('auth middleware — missing or invalid token', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = createApp();
    const res = await app.request('/test');

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Missing or invalid Authorization header');
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Basic abc123' },
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Missing or invalid Authorization header');
  });

  it('returns 401 when token is empty after Bearer prefix', async () => {
    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer ' },
    });

    expect(res.status).toBe(401);
    // Hono may trim trailing space, causing "Bearer " to fail the startsWith check
    const json = await res.json();
    expect(json.error).toMatch(/Missing/);
  });
});

// ─── GitHub API Verification ────────────────────────────────────

describe('auth middleware — GitHub API verification', () => {
  it('returns 401 when GitHub API returns non-OK status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer invalid-token' },
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Invalid or expired token');
  });

  it('returns 401 when token has expired (expires_at in the past)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 1,
        login: 'testuser',
        expires_at: '2020-01-01T00:00:00Z',
      }),
    });

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer expired-token' },
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Token has expired');
  });

  it('allows token when expires_at is in the future', async () => {
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 1,
        login: 'testuser',
        expires_at: futureDate,
      }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 1, githubUserId: 1, githubLogin: 'testuser', installationId: 100 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 100, accountLogin: 'testuser' }]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer future-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.githubLogin).toBe('testuser');
  });

  it('allows token when expires_at is not present', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, login: 'testuser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 1, githubUserId: 1, githubLogin: 'testuser', installationId: 100 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 100, accountLogin: 'testuser' }]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer no-expiry-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.githubLogin).toBe('testuser');
  });

  it('returns 503 with Retry-After when GitHub API is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer some-token' },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    const json = await res.json();
    expect(json.error).toMatch(/GitHub API/i);
  });

  it('calls GitHub /user API with correct headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, login: 'testuser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 1, githubUserId: 1, githubLogin: 'testuser', installationId: 100 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 100, accountLogin: 'testuser' }]);

    const app = createApp();
    await app.request('/test', {
      headers: { Authorization: 'Bearer my-gh-token' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-gh-token',
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
  });
});

// ─── Successful Auth with Existing Mappings ─────────────────────

describe('auth middleware — successful auth', () => {
  it('sets user context with existing installation mappings', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, login: 'octocat' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 1, githubUserId: 42, githubLogin: 'octocat', installationId: 100 },
      { id: 2, githubUserId: 42, githubLogin: 'octocat', installationId: 200 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([
      { id: 100, accountLogin: 'octocat' },
      { id: 200, accountLogin: 'org-a' },
    ]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user).toEqual({
      githubUserId: 42,
      githubLogin: 'octocat',
      installationIds: [100, 200],
    });

    // Should NOT trigger auto-discovery
    expect(mockGetInstallationsByAccountLogin).not.toHaveBeenCalled();
    expect(mockUpsertUserMapping).not.toHaveBeenCalled();
    expect(mockDeleteStaleUserMappings).not.toHaveBeenCalled();
  });

  it('passes the db to getRawMappingsByUserId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, login: 'testuser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 1, githubUserId: 1, githubLogin: 'testuser', installationId: 100 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 100 }]);

    const app = createApp();
    await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(mockGetRawMappingsByUserId).toHaveBeenCalledWith(mockDb, 1);
  });
});

// ─── Auto-Discovery ─────────────────────────────────────────────

describe('auth middleware — auto-discovery', () => {
  it('auto-discovers and maps installations when no existing mappings', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 55, login: 'newuser' }),
    });
    // No raw mappings at all
    mockGetRawMappingsByUserId.mockResolvedValueOnce([]);
    // Discover matching installations
    mockGetInstallationsByAccountLogin.mockResolvedValueOnce([
      { id: 300, accountLogin: 'newuser' },
      { id: 400, accountLogin: 'newuser' },
    ]);
    mockUpsertUserMapping.mockResolvedValue({});

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([300, 400]);

    // Should NOT call getInstallationsByUserId (no raw mappings → skip straight to discovery)
    expect(mockGetInstallationsByUserId).not.toHaveBeenCalled();

    // Should create mappings for each discovered installation
    expect(mockUpsertUserMapping).toHaveBeenCalledTimes(2);
    expect(mockUpsertUserMapping).toHaveBeenCalledWith(mockDb, {
      githubUserId: 55,
      githubLogin: 'newuser',
      installationId: 300,
    });
    expect(mockUpsertUserMapping).toHaveBeenCalledWith(mockDb, {
      githubUserId: 55,
      githubLogin: 'newuser',
      installationId: 400,
    });
  });

  it('returns empty installationIds when no matching installations found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 99, login: 'loner' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([]);
    mockGetInstallationsByAccountLogin.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([]);
    expect(mockUpsertUserMapping).not.toHaveBeenCalled();
  });

  it('returns empty installationIds when auto-discovery throws', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 99, login: 'erroruser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([]);
    mockGetInstallationsByAccountLogin.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    // Auto-discovery catches errors and returns []
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([]);
  });
});

// ─── DB Error During Lookup ─────────────────────────────────────

describe('auth middleware — DB errors', () => {
  it('returns 500 when getRawMappingsByUserId throws', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, login: 'testuser' }),
    });
    mockGetRawMappingsByUserId.mockRejectedValueOnce(new Error('DB connection lost'));

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Internal server error');
  });
});

// ─── Stale Mapping Detection & Cleanup ──────────────────────────

describe('auth middleware — stale mapping cleanup', () => {
  // Helper: mock GitHub /user API to return a valid user
  function mockGitHubUser(id: number, login: string) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id, login }),
    });
  }

  it('S-R9.1: valid mappings — normal flow, no cleanup', async () => {
    mockGitHubUser(42, 'octocat');
    // Raw mappings → one mapping to installation 5
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 10, githubUserId: 42, githubLogin: 'octocat', installationId: 5 },
    ]);
    // Active installations → installation 5 is active
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 5, accountLogin: 'octocat' }]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([5]);

    // No cleanup, no re-discovery
    expect(mockDeleteStaleUserMappings).not.toHaveBeenCalled();
    expect(mockGetInstallationsByAccountLogin).not.toHaveBeenCalled();
  });

  it('S-R9.2: mapping to inactive installation — cleanup + re-discovery', async () => {
    mockGitHubUser(42, 'octocat');
    // Raw mappings → one mapping to installation 5
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 10, githubUserId: 42, githubLogin: 'octocat', installationId: 5 },
    ]);
    // Active installations → empty (installation 5 is inactive)
    mockGetInstallationsByUserId.mockResolvedValueOnce([]);
    // Cleanup stale mapping
    mockDeleteStaleUserMappings.mockResolvedValueOnce(undefined);
    // Re-discovery finds a new installation
    mockGetInstallationsByAccountLogin.mockResolvedValueOnce([{ id: 10, accountLogin: 'octocat' }]);
    mockUpsertUserMapping.mockResolvedValue({});

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([10]);

    // Should have cleaned up stale mapping
    expect(mockDeleteStaleUserMappings).toHaveBeenCalledWith(mockDb, [10]);
    // Should have re-discovered
    expect(mockGetInstallationsByAccountLogin).toHaveBeenCalledWith(mockDb, 'octocat');
    expect(mockUpsertUserMapping).toHaveBeenCalledWith(mockDb, {
      githubUserId: 42,
      githubLogin: 'octocat',
      installationId: 10,
    });
  });

  it('S-R9.3: mapping to non-existent installation — cleanup', async () => {
    mockGitHubUser(42, 'octocat');
    // Raw mapping to installation 99 (which doesn't exist)
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 20, githubUserId: 42, githubLogin: 'octocat', installationId: 99 },
    ]);
    // Active installations → empty (99 doesn't exist)
    mockGetInstallationsByUserId.mockResolvedValueOnce([]);
    mockDeleteStaleUserMappings.mockResolvedValueOnce(undefined);
    // Re-discovery finds nothing
    mockGetInstallationsByAccountLogin.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([]);

    expect(mockDeleteStaleUserMappings).toHaveBeenCalledWith(mockDb, [20]);
    expect(mockGetInstallationsByAccountLogin).toHaveBeenCalled();
  });

  it('S-R9.4: mixed mappings — one valid, one stale — cleanup only stale, no re-discovery', async () => {
    mockGitHubUser(42, 'octocat');
    // Raw mappings → two mappings
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 10, githubUserId: 42, githubLogin: 'octocat', installationId: 5 },
      { id: 11, githubUserId: 42, githubLogin: 'octocat', installationId: 7 },
    ]);
    // Active installations → only 5 is active (7 is inactive)
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 5, accountLogin: 'octocat' }]);
    mockDeleteStaleUserMappings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([5]);

    // Should cleanup only the stale mapping (id=11, installationId=7)
    expect(mockDeleteStaleUserMappings).toHaveBeenCalledWith(mockDb, [11]);
    // Should NOT re-discover (still have valid mappings)
    expect(mockGetInstallationsByAccountLogin).not.toHaveBeenCalled();
  });

  it('S-R9.5: all mappings stale, discovery finds new installation', async () => {
    mockGitHubUser(55, 'johndoe');
    // Raw mapping to installation 3 (inactive)
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 30, githubUserId: 55, githubLogin: 'johndoe', installationId: 3 },
    ]);
    // No active installations
    mockGetInstallationsByUserId.mockResolvedValueOnce([]);
    mockDeleteStaleUserMappings.mockResolvedValueOnce(undefined);
    // Discovery finds new installation
    mockGetInstallationsByAccountLogin.mockResolvedValueOnce([{ id: 10, accountLogin: 'johndoe' }]);
    mockUpsertUserMapping.mockResolvedValue({});

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([10]);

    expect(mockDeleteStaleUserMappings).toHaveBeenCalledWith(mockDb, [30]);
    expect(mockUpsertUserMapping).toHaveBeenCalledWith(mockDb, {
      githubUserId: 55,
      githubLogin: 'johndoe',
      installationId: 10,
    });
  });

  it('S-R12.1: all stale, discovery finds nothing — empty installationIds', async () => {
    mockGitHubUser(55, 'johndoe');
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 30, githubUserId: 55, githubLogin: 'johndoe', installationId: 3 },
      { id: 31, githubUserId: 55, githubLogin: 'johndoe', installationId: 4 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([]);
    mockDeleteStaleUserMappings.mockResolvedValueOnce(undefined);
    mockGetInstallationsByAccountLogin.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([]);

    expect(mockDeleteStaleUserMappings).toHaveBeenCalledWith(mockDb, [30, 31]);
    expect(mockGetInstallationsByAccountLogin).toHaveBeenCalled();
    expect(mockUpsertUserMapping).not.toHaveBeenCalled();
  });

  it('S-R12.2: mixed mappings — does NOT re-discover when valid remain', async () => {
    mockGitHubUser(42, 'octocat');
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 10, githubUserId: 42, githubLogin: 'octocat', installationId: 5 },
      { id: 11, githubUserId: 42, githubLogin: 'octocat', installationId: 7 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 5, accountLogin: 'octocat' }]);
    mockDeleteStaleUserMappings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([5]);

    expect(mockDeleteStaleUserMappings).toHaveBeenCalledWith(mockDb, [11]);
    expect(mockGetInstallationsByAccountLogin).not.toHaveBeenCalled();
  });
});

// ─── Backward Compatibility ─────────────────────────────────────

describe('auth middleware — backward compatibility', () => {
  it('S-CC4.1: existing PAT token still works normally', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, login: 'patuser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 1, githubUserId: 42, githubLogin: 'patuser', installationId: 100 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 100, accountLogin: 'patuser' }]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer ghp_existing_pat_token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user).toEqual({
      githubUserId: 42,
      githubLogin: 'patuser',
      installationIds: [100],
    });
  });

  it('S-CC4.2: token from any source (Web Flow, Device Flow, PAT) is accepted', async () => {
    // The middleware doesn't care about token source — it just verifies via GitHub API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 77, login: 'webflowuser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 5, githubUserId: 77, githubLogin: 'webflowuser', installationId: 200 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 200, accountLogin: 'webflowuser' }]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer gho_web_flow_token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.installationIds).toEqual([200]);
  });
});

// ─── Token Cache ────────────────────────────────────────────────

describe('auth middleware — token cache', () => {
  it('second request with same token does not call GitHub API', async () => {
    // First request: GitHub API is called
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, login: 'cacheduser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValue([
      { id: 1, githubUserId: 42, githubLogin: 'cacheduser', installationId: 100 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValue([{ id: 100, accountLogin: 'cacheduser' }]);

    const app = createApp();

    const res1 = await app.request('/test', {
      headers: { Authorization: 'Bearer cached-token' },
    });
    expect(res1.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second request: should use cache, no GitHub API call
    const res2 = await app.request('/test', {
      headers: { Authorization: 'Bearer cached-token' },
    });
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.user.githubLogin).toBe('cacheduser');

    // fetch should still only have been called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('expired cache entry triggers new API call', async () => {
    // Manually insert an expired cache entry
    tokenCache.set('expired-token', {
      user: { id: 42, login: 'expireduser' },
      expiresAt: Date.now() - 1000, // already expired
    });

    // When the expired entry is found, the middleware should call GitHub API again
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, login: 'expireduser' }),
    });
    mockGetRawMappingsByUserId.mockResolvedValueOnce([
      { id: 1, githubUserId: 42, githubLogin: 'expireduser', installationId: 100 },
    ]);
    mockGetInstallationsByUserId.mockResolvedValueOnce([{ id: 100, accountLogin: 'expireduser' }]);

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer expired-token' },
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const json = await res.json();
    expect(json.user.githubLogin).toBe('expireduser');
  });

  it('invalid token is not cached', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const app = createApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer bad-token' },
    });

    expect(res.status).toBe(401);
    expect(tokenCache.has('bad-token')).toBe(false);
  });
});

// ─── Periodic Token Cache Cleanup ───────────────────────────────

describe('token cache — periodic cleanup', () => {
  it('cleanupExpiredTokens removes expired entries', () => {
    // Add an expired entry
    tokenCache.set('expired-1', {
      user: { id: 1, login: 'user1' },
      expiresAt: Date.now() - 10_000,
    });
    // Add another expired entry
    tokenCache.set('expired-2', {
      user: { id: 2, login: 'user2' },
      expiresAt: Date.now() - 1,
    });

    expect(tokenCache.size).toBe(2);

    cleanupExpiredTokens();

    expect(tokenCache.size).toBe(0);
    expect(tokenCache.has('expired-1')).toBe(false);
    expect(tokenCache.has('expired-2')).toBe(false);
  });

  it('cleanupExpiredTokens keeps non-expired entries', () => {
    // Add an expired entry
    tokenCache.set('expired', {
      user: { id: 1, login: 'expired-user' },
      expiresAt: Date.now() - 10_000,
    });
    // Add a valid (non-expired) entry
    tokenCache.set('valid', {
      user: { id: 2, login: 'valid-user' },
      expiresAt: Date.now() + 60_000,
    });

    expect(tokenCache.size).toBe(2);

    cleanupExpiredTokens();

    expect(tokenCache.size).toBe(1);
    expect(tokenCache.has('expired')).toBe(false);
    expect(tokenCache.has('valid')).toBe(true);
    expect(tokenCache.get('valid')?.user.login).toBe('valid-user');
  });

  it('cleanupInterval is a valid timer with .unref() applied', () => {
    // The interval should exist and be a Node.js Timer object
    expect(cleanupInterval).toBeDefined();
    // Verify it has hasRef() — which returns false after .unref()
    expect(cleanupInterval.hasRef()).toBe(false);
  });
});
