/**
 * OAuth route tests.
 *
 * Verifies:
 * - Device Flow code request sends scope: 'public_repo'
 * - Token exchange forwards device_code correctly
 * - Error handling for both endpoints
 * - Web Flow: generateState / validateState helpers
 * - Web Flow: GET /auth/login redirect to GitHub authorize
 * - Web Flow: GET /auth/callback exchange code, redirect to Dashboard
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before any imports, ensuring env vars are set
// before oauth.ts evaluates its module-level constants
vi.hoisted(() => {
  process.env.GITHUB_CLIENT_ID = 'test-github-client-id';
  process.env.SERVER_URL = 'https://api.javierzader.com';
});

import { createOAuthRouter, generateState, validateState } from './oauth.js';

// ─── Mocks ──────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Helpers ────────────────────────────────────────────────────

function createApp() {
  const app = new Hono();
  app.route('/', createOAuthRouter());
  return app;
}

const TEST_STATE_SECRET = 'test-secret-key-for-hmac-validation';
const TEST_CLIENT_SECRET = 'test-client-secret-value';
const DASHBOARD_URL = 'https://ghagga.javierzader.com/app';

// ═══════════════════════════════════════════════════════════════════
// POST /auth/device/code
// ═══════════════════════════════════════════════════════════════════

describe('POST /auth/device/code', () => {
  it('sends scope: "public_repo" to GitHub (not empty string)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          device_code: 'dc-abc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = createApp();
    const res = await app.request('/auth/device/code', { method: 'POST' });

    expect(res.status).toBe(200);

    // Verify the fetch call to GitHub
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://github.com/login/device/code');

    const body = JSON.parse(options.body as string);
    expect(body.scope).toBe('public_repo');
    expect(body.scope).not.toBe('');
    expect(body.client_id).toBe('test-github-client-id');
  });

  it('proxies GitHub response back to client', async () => {
    const githubResponse = {
      device_code: 'dc-xyz',
      user_code: 'WXYZ-5678',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(githubResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = createApp();
    const res = await app.request('/auth/device/code', { method: 'POST' });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(githubResponse);
  });

  it('sends correct headers to GitHub', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ device_code: 'dc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = createApp();
    await app.request('/auth/device/code', { method: 'POST' });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });

  it('returns github_error when GitHub responds with error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    const app = createApp();
    const res = await app.request('/auth/device/code', { method: 'POST' });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('github_error');
    expect(json.message).toBe('Bad Request');
  });

  it('returns proxy_error when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const app = createApp();
    const res = await app.request('/auth/device/code', { method: 'POST' });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('proxy_error');
    expect(json.message).toBe('Network failure');
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /auth/device/token
// ═══════════════════════════════════════════════════════════════════

describe('POST /auth/device/token', () => {
  it('forwards device_code to GitHub token endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'gho_test-token',
          token_type: 'bearer',
          scope: 'public_repo',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = createApp();
    const res = await app.request('/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: 'dc-abc' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBe('gho_test-token');

    // Verify the fetch call
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://github.com/login/oauth/access_token');

    const body = JSON.parse(options.body as string);
    expect(body.device_code).toBe('dc-abc');
    expect(body.client_id).toBe('test-github-client-id');
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('returns authorization_pending during polling', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'authorization_pending',
          error_description: 'The authorization request is still pending.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = createApp();
    const res = await app.request('/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: 'dc-pending' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.error).toBe('authorization_pending');
  });

  it('returns 400 when device_code is missing', async () => {
    const app = createApp();
    const res = await app.request('/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('missing_field');
    expect(json.message).toBe('device_code is required');
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp();
    const res = await app.request('/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{{{',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_body');
  });

  it('returns github_error when GitHub responds with error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const app = createApp();
    const res = await app.request('/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: 'dc-fail' }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('github_error');
  });

  it('returns proxy_error when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const app = createApp();
    const res = await app.request('/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: 'dc-net-err' }),
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('proxy_error');
    expect(json.message).toBe('Connection refused');
  });
});

// ═══════════════════════════════════════════════════════════════════
// generateState / validateState — Unit tests
// ═══════════════════════════════════════════════════════════════════

describe('generateState / validateState', () => {
  it('generates and validates a state within 5 min (S-R2.1)', () => {
    const state = generateState(TEST_STATE_SECRET);
    const result = validateState(state, TEST_STATE_SECRET);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects expired state after 6 minutes (S-R2.2)', () => {
    vi.useFakeTimers();

    const state = generateState(TEST_STATE_SECRET);

    // Advance time by 6 minutes (> 5 min TTL)
    vi.advanceTimersByTime(6 * 60 * 1000);

    const result = validateState(state, TEST_STATE_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('state_expired');
  });

  it('rejects state with manipulated HMAC (S-R2.3)', () => {
    const state = generateState(TEST_STATE_SECRET);
    // Manipulate the HMAC signature
    const [ts] = state.split('.');
    const manipulated = `${ts}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;

    const result = validateState(manipulated, TEST_STATE_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_state');
  });

  it('rejects state with invalid format (no dot separator)', () => {
    const result = validateState('invalid-state-no-dot', TEST_STATE_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_state');
  });

  it('rejects state with wrong secret', () => {
    const state = generateState(TEST_STATE_SECRET);
    const result = validateState(state, 'wrong-secret');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_state');
  });

  it('rejects state with manipulated timestamp', () => {
    const state = generateState(TEST_STATE_SECRET);
    const [, sig] = state.split('.');
    // Use a different timestamp but same signature
    const manipulated = `abc123.${sig}`;

    const result = validateState(manipulated, TEST_STATE_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_state');
  });

  it('state format is {base36_timestamp}.{hex_hmac}', () => {
    const state = generateState(TEST_STATE_SECRET);
    const parts = state.split('.');

    expect(parts).toHaveLength(2);
    // First part is base36 timestamp
    expect(parseInt(parts[0], 36)).toBeGreaterThan(0);
    // Second part is hex HMAC (64 chars for SHA256)
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /auth/login — Web Flow
// ═══════════════════════════════════════════════════════════════════

describe('GET /auth/login', () => {
  beforeEach(() => {
    vi.stubEnv('STATE_SECRET', TEST_STATE_SECRET);
  });

  it('returns 302 redirect to GitHub authorize URL (S-R1.1)', async () => {
    const app = createApp();
    const res = await app.request('/auth/login');

    expect(res.status).toBe(302);

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known response
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://github.com/login/oauth/authorize');
  });

  it('includes all required params in redirect URL (S-R1.1)', async () => {
    const app = createApp();
    const res = await app.request('/auth/login');

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known response
    const location = new URL(res.headers.get('Location')!);

    expect(location.searchParams.get('client_id')).toBeTruthy();
    expect(location.searchParams.get('scope')).toBe('public_repo');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://api.javierzader.com/auth/callback',
    );
    // State should be present and non-empty
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(state?.split('.')).toHaveLength(2);
  });

  it('generates a valid state that can be validated (S-R2.6)', async () => {
    const app = createApp();
    const res = await app.request('/auth/login');

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known response
    const location = new URL(res.headers.get('Location')!);
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known response
    const state = location.searchParams.get('state')!;

    // The state generated by the endpoint should be valid
    const result = validateState(state, TEST_STATE_SECRET);
    expect(result.valid).toBe(true);
  });

  it('returns 500 with errorId when STATE_SECRET is not configured (S-R2.5)', async () => {
    // Remove STATE_SECRET
    delete process.env.STATE_SECRET;

    const app = createApp();
    const res = await app.request('/auth/login');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('INTERNAL_ERROR');
    expect(json.message).toContain('STATE_SECRET');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /auth/callback — Web Flow
// ═══════════════════════════════════════════════════════════════════

describe('GET /auth/callback', () => {
  let validState: string;

  beforeEach(() => {
    vi.stubEnv('STATE_SECRET', TEST_STATE_SECRET);
    vi.stubEnv('GITHUB_CLIENT_SECRET', TEST_CLIENT_SECRET);
    // Generate a valid state for tests that need it
    validState = generateState(TEST_STATE_SECRET);
  });

  it('exchanges code for token and redirects to Dashboard (S-R1.2)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'gho_web-flow-token',
          token_type: 'bearer',
          scope: 'public_repo',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=abc123&state=${encodeURIComponent(validState)}`,
    );

    expect(res.status).toBe(302);
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known response
    const location = res.headers.get('Location')!;
    expect(location).toBe(`${DASHBOARD_URL}/#/auth/callback?token=gho_web-flow-token`);

    // Verify fetch was called with correct params
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://github.com/login/oauth/access_token');

    const body = JSON.parse(options.body as string);
    expect(body.client_id).toBe('test-github-client-id');
    expect(body.client_secret).toBe(TEST_CLIENT_SECRET);
    expect(body.code).toBe('abc123');
  });

  it('sends correct headers when exchanging code (S-R1.2)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'gho_test', token_type: 'bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = createApp();
    await app.request(`/auth/callback?code=test&state=${encodeURIComponent(validState)}`);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });

  it('redirects with error=exchange_failed when GitHub returns error in body (S-R1.3)', async () => {
    // GitHub returns 200 with error field for invalid codes
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=invalid&state=${encodeURIComponent(validState)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${DASHBOARD_URL}/#/auth/callback?error=exchange_failed`,
    );
  });

  it('redirects with error=exchange_failed when GitHub returns non-200 (S-R1.3)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=test&state=${encodeURIComponent(validState)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${DASHBOARD_URL}/#/auth/callback?error=exchange_failed`,
    );
  });

  it('redirects with error=missing_code when code is absent (S-R1.4)', async () => {
    const app = createApp();
    const res = await app.request(`/auth/callback?state=${encodeURIComponent(validState)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${DASHBOARD_URL}/#/auth/callback?error=missing_code`);
  });

  it('redirects with error=missing_state when state is absent (S-R2.4)', async () => {
    const app = createApp();
    const res = await app.request('/auth/callback?code=abc123');

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${DASHBOARD_URL}/#/auth/callback?error=missing_state`,
    );
  });

  it('redirects with error=state_expired for expired state (S-R2.2)', async () => {
    vi.useFakeTimers();

    const expiredState = generateState(TEST_STATE_SECRET);
    // Advance 6 minutes
    vi.advanceTimersByTime(6 * 60 * 1000);

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=abc123&state=${encodeURIComponent(expiredState)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${DASHBOARD_URL}/#/auth/callback?error=state_expired`,
    );

    // fetch should NOT have been called (state validation fails first)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('redirects with error=invalid_state for manipulated state (S-R2.3)', async () => {
    const [ts] = validState.split('.');
    const manipulated = `${ts}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=abc123&state=${encodeURIComponent(manipulated)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${DASHBOARD_URL}/#/auth/callback?error=invalid_state`,
    );

    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('redirects with error=server_error when CLIENT_SECRET is missing (S-R8.2)', async () => {
    delete process.env.GITHUB_CLIENT_SECRET;

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=abc123&state=${encodeURIComponent(validState)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${DASHBOARD_URL}/#/auth/callback?error=server_error`);

    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('redirects with error=access_denied when user denies auth (S-CC2.1)', async () => {
    // GitHub redirects with error=access_denied and no code
    const app = createApp();
    const res = await app.request(
      `/auth/callback?error=access_denied&state=${encodeURIComponent(validState)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${DASHBOARD_URL}/#/auth/callback?error=access_denied`,
    );
  });

  it('redirects with error=github_unavailable when fetch throws (S-CC2.2)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=abc123&state=${encodeURIComponent(validState)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${DASHBOARD_URL}/#/auth/callback?error=github_unavailable`,
    );
  });

  it('redirects with error=server_error when STATE_SECRET is missing in callback', async () => {
    delete process.env.STATE_SECRET;

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=abc123&state=${encodeURIComponent(validState)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${DASHBOARD_URL}/#/auth/callback?error=server_error`);
  });

  it('token is in fragment path, not query params (S-CC1.1)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'gho_fragment-test',
          token_type: 'bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = createApp();
    const res = await app.request(
      `/auth/callback?code=abc123&state=${encodeURIComponent(validState)}`,
    );

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known response
    const location = res.headers.get('Location')!;
    // Token should be after the # (in fragment), not in server-visible query params
    expect(location).toContain('/#/auth/callback?token=gho_fragment-test');
    // The URL before # should NOT contain the token
    const [beforeHash] = location.split('#');
    expect(beforeHash).not.toContain('token=');
  });
});
