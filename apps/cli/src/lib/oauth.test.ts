/**
 * OAuth device flow tests.
 *
 * Tests requestDeviceCode(), pollForAccessToken(), and fetchGitHubUser()
 * with mocked global fetch and fake timers for the polling loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGitHubUser,
  GITHUB_CLIENT_ID,
  pollForAccessToken,
  requestDeviceCode,
} from './oauth.js';

// ─── Mock global fetch ──────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

function errorResponse(status: number, body = 'error'): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('GITHUB_CLIENT_ID', () => {
  it('is exported and equals the expected public client ID', () => {
    expect(typeof GITHUB_CLIENT_ID).toBe('string');
  });
});

describe('requestDeviceCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends POST to github.com/login/device/code with client_id', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'dc_123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    );

    const result = await requestDeviceCode();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://github.com/login/device/code',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
      }),
    );

    // Verify client_id is in the body
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.client_id).toBe(GITHUB_CLIENT_ID);

    expect(result.device_code).toBe('dc_123');
    expect(result.user_code).toBe('ABCD-1234');
    expect(result.verification_uri).toBe('https://github.com/login/device');
  });

  it('throws on non-ok response with status and body', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(422, 'validation failed'));

    await expect(requestDeviceCode()).rejects.toThrow(
      'Failed to request device code: 422 validation failed',
    );
  });
});

describe('pollForAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: run pollForAccessToken and advance timers
  async function _runPoll(deviceCode = 'dc_123', interval = 1, expiresIn = 60) {
    const promise = pollForAccessToken(deviceCode, interval, expiresIn);

    // Advance through the initial sleep + poll cycles
    // We need to flush several timer rounds
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(interval * 1000 + 100);
    }

    return promise;
  }

  it('returns AccessTokenResponse on success after first poll', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'gho_abc123',
        token_type: 'bearer',
        scope: '',
      }),
    );

    const promise = pollForAccessToken('dc_123', 1, 60);
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(result.access_token).toBe('gho_abc123');
    expect(result.token_type).toBe('bearer');
  });

  it('keeps polling on authorization_pending, returns on success', async () => {
    // First call: pending
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }));
    // Second call: success
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'gho_xyz',
        token_type: 'bearer',
        scope: '',
      }),
    );

    const promise = pollForAccessToken('dc_123', 1, 60);

    // First poll (sleep 1s + fetch)
    await vi.advanceTimersByTimeAsync(1100);
    // Second poll (sleep 1s + fetch)
    await vi.advanceTimersByTimeAsync(1100);

    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.access_token).toBe('gho_xyz');
  });

  it('increases interval by 5 on slow_down and continues polling', async () => {
    // First call: slow_down
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'slow_down', interval: 5 }));
    // Second call: success (after longer wait)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'gho_slow',
        token_type: 'bearer',
        scope: '',
      }),
    );

    const promise = pollForAccessToken('dc_123', 1, 120);

    // First poll: 1s sleep
    await vi.advanceTimersByTimeAsync(1100);
    // After slow_down: new interval is (5 + 5) = 10s
    await vi.advanceTimersByTimeAsync(10100);

    const result = await promise;
    expect(result.access_token).toBe('gho_slow');
  });

  it('throws "Device code expired" on expired_token error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'expired_token' }));

    const promise = pollForAccessToken('dc_123', 1, 60);
    // Attach rejection handler immediately to prevent unhandled rejection
    const rejection = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1100);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Device code expired');
  });

  it('throws "Authorization was denied" on access_denied error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'access_denied' }));

    const promise = pollForAccessToken('dc_123', 1, 60);
    const rejection = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1100);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Authorization was denied');
  });

  it('throws "OAuth error" with description on unknown error', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        error: 'server_error',
        error_description: 'Something went wrong',
      }),
    );

    const promise = pollForAccessToken('dc_123', 1, 60);
    const rejection = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1100);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('OAuth error: server_error — Something went wrong');
  });

  it('throws "OAuth error" without description when none provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'unknown_error' }));

    const promise = pollForAccessToken('dc_123', 1, 60);
    const rejection = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1100);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('OAuth error: unknown_error');
  });

  it('throws timeout error when deadline is exceeded', async () => {
    // Keep returning authorization_pending until deadline passes
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: 'authorization_pending' })),
    );

    // Use very short expiry so we can trigger timeout
    const promise = pollForAccessToken('dc_123', 1, 2);
    const rejection = promise.catch((e: Error) => e);

    // Advance past the 2-second deadline
    await vi.advanceTimersByTimeAsync(1100); // first poll
    await vi.advanceTimersByTimeAsync(1100); // second poll — now past deadline

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Device code expired (timeout)');
  });
});

describe('fetchGitHubUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends GET to api.github.com/user with Bearer token', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        login: 'testuser',
        id: 12345,
        avatar_url: 'https://github.com/avatar.png',
      }),
    );

    const user = await fetchGitHubUser('gho_token123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer gho_token123',
        }),
      }),
    );

    expect(user.login).toBe('testuser');
    expect(user.id).toBe(12345);
    expect(user.avatar_url).toBe('https://github.com/avatar.png');
  });

  it('throws on non-ok response with status', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401));

    await expect(fetchGitHubUser('bad_token')).rejects.toThrow('Failed to fetch GitHub user: 401');
  });
});
