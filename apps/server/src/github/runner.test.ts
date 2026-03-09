import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Logger Mock ────────────────────────────────────────────────
// vi.hoisted ensures these are available when vi.mock factory runs
// (vi.mock is hoisted above all other code by Vitest).

const { mockRunnerLogger, mockRootChildFn } = vi.hoisted(() => {
  const mockRunnerLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockRootChildFn = vi.fn().mockReturnValue(mockRunnerLogger);
  return { mockRunnerLogger, mockRootChildFn };
});

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: (...args: unknown[]) => mockRootChildFn(...args),
  },
}));

import {
  buildDelegatedCiDescriptor,
  createRunnerRepo,
  type DelegatedCiDispatchParams,
  type DispatchParams,
  deriveCallbackSecret,
  discoverRunnerRepo,
  dispatchRunnerWorkflow,
  dispatchWorkflow,
  getCallbackTtlMs,
  RunnerCreationError,
  type RunnerErrorCode,
  type RunnerWorkflowDescriptor,
  setRunnerSecret,
  verifyCallbackSignature,
} from './runner.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Compute a valid HMAC-SHA256 signature in GitHub's `sha256=<hex>` format. */
function computeSignature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/** Build a minimal DispatchParams with sensible defaults. */
function makeDispatchParams(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    ownerLogin: 'test-owner',
    repoFullName: 'test-owner/test-repo',
    prNumber: 1,
    headSha: 'abc123',
    baseBranch: 'main',
    callbackUrl: 'https://example.com/callback',
    enableSemgrep: true,
    enableTrivy: false,
    enableCpd: false,
    token: 'ghp_test-token',
    ...overrides,
  };
}

/** Create a callbackId with an embedded timestamp at a given time offset from now. */
function makeCallbackId(ageMs = 0): string {
  const ts = (Date.now() - ageMs).toString(36);
  return `550e8400-e29b-41d4-a716-446655440000.${ts}`;
}

// ─── Group 1: deriveCallbackSecret ──────────────────────────────

describe('deriveCallbackSecret', () => {
  const TEST_SECRET = 'test-secret-key';

  beforeEach(() => {
    process.env.STATE_SECRET = TEST_SECRET;
    mockRunnerLogger.warn.mockClear();
    mockRunnerLogger.info.mockClear();
  });

  afterEach(() => {
    delete process.env.STATE_SECRET;
  });

  it('produces deterministic output — same input yields same result (S-R1.1)', () => {
    const callbackId = '550e8400-e29b-41d4-a716-446655440000.m1abc';
    const result1 = deriveCallbackSecret(callbackId);
    const result2 = deriveCallbackSecret(callbackId);

    expect(result1).toBe(result2);
  });

  it('returns exactly 64 hexadecimal characters (S-R1.1)', () => {
    const callbackId = '550e8400-e29b-41d4-a716-446655440000.m1abc';
    const result = deriveCallbackSecret(callbackId);

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different secrets for different callbackIds (S-R1.2)', () => {
    const secret1 = deriveCallbackSecret('id-a.ts1');
    const secret2 = deriveCallbackSecret('id-b.ts2');

    expect(secret1).not.toBe(secret2);
  });

  it('produces different secrets for different STATE_SECRETs (S-R1.3)', () => {
    process.env.STATE_SECRET = 'key-1';
    const secret1 = deriveCallbackSecret('same-id.ts1');

    process.env.STATE_SECRET = 'key-2';
    const secret2 = deriveCallbackSecret('same-id.ts1');

    expect(secret1).not.toBe(secret2);
  });

  it('computes HMAC-SHA256(STATE_SECRET, callbackId) as hex', () => {
    const callbackId = '550e8400-e29b-41d4-a716-446655440000.m1abc';
    const expected = createHmac('sha256', TEST_SECRET).update(callbackId).digest('hex');

    expect(deriveCallbackSecret(callbackId)).toBe(expected);
  });

  it('throws when STATE_SECRET is undefined (S-CC1.1)', () => {
    delete process.env.STATE_SECRET;

    expect(() => deriveCallbackSecret('any-id.ts1')).toThrow('STATE_SECRET is not configured');
  });

  it('throws when STATE_SECRET is empty string', () => {
    process.env.STATE_SECRET = '';

    expect(() => deriveCallbackSecret('any-id.ts1')).toThrow('STATE_SECRET is not configured');
  });
});

// ─── Group 1b: verifyCallbackSignature ──────────────────────────

describe('verifyCallbackSignature', () => {
  const TEST_SECRET = 'my-server-secret';
  const payload = '{"result":"ok"}';

  beforeEach(() => {
    process.env.STATE_SECRET = TEST_SECRET;
    mockRunnerLogger.warn.mockClear();
    mockRunnerLogger.info.mockClear();
  });

  afterEach(() => {
    delete process.env.STATE_SECRET;
    delete process.env.CALLBACK_TTL_MINUTES;
    vi.useRealTimers();
  });

  // ─── Happy path (S-R4.1) ────────────────────────────────────

  it('returns true for a valid callbackId and valid signature (S-R4.1)', () => {
    const callbackId = makeCallbackId(0);
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(true);
  });

  // ─── TTL enforcement (S-R3.1 through S-R3.4) ─────────────────

  it('accepts callback within TTL — 5 minutes old (S-R3.1)', () => {
    const callbackId = makeCallbackId(5 * 60 * 1000); // 5 min ago
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(true);
  });

  it('rejects callback at exactly the TTL (S-R3.2)', () => {
    const ttl = getCallbackTtlMs();
    const callbackId = makeCallbackId(ttl); // exactly at TTL
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(false);
  });

  it('accepts callback at TTL minus 1s (S-R3.3)', () => {
    const ttl = getCallbackTtlMs();
    const callbackId = makeCallbackId(ttl - 1000); // TTL - 1s (margin for CI)
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(true);
  });

  it('rejects callback older than TTL — TTL + 1 min (S-R3.4)', () => {
    const ttl = getCallbackTtlMs();
    const callbackId = makeCallbackId(ttl + 60 * 1000); // TTL + 1 min
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(false);
  });

  it('logs warning when callback is expired (S-R3.4)', () => {
    const ttl = getCallbackTtlMs();
    const callbackId = makeCallbackId(ttl + 60 * 1000);
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    verifyCallbackSignature(callbackId, payload, signature);

    expect(mockRunnerLogger.warn).toHaveBeenCalledWith(
      { callbackId },
      'Callback expired — TTL exceeded',
    );
  });

  // ─── TTL with fake timers ────────────────────────────────────

  it('handles TTL boundary with fake timers — just before expiry', () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    const ttl = getCallbackTtlMs();

    // Create callbackId at "now"
    const ts = now.toString(36);
    const callbackId = `550e8400-e29b-41d4-a716-446655440000.${ts}`;
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    // Advance to TTL - 1ms
    vi.advanceTimersByTime(ttl - 1);

    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(true);
  });

  it('handles TTL boundary with fake timers — exactly at expiry', () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    const ttl = getCallbackTtlMs();

    const ts = now.toString(36);
    const callbackId = `550e8400-e29b-41d4-a716-446655440000.${ts}`;
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    // Advance to exactly TTL
    vi.advanceTimersByTime(ttl);

    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(false);
  });

  // ─── Dynamic TTL via CALLBACK_TTL_MINUTES env var ─────────────

  it('uses CALLBACK_TTL_MINUTES env var to override the default TTL', () => {
    process.env.CALLBACK_TTL_MINUTES = '15';

    const now = Date.now();
    vi.useFakeTimers({ now });

    const ts = now.toString(36);
    const callbackId = `550e8400-e29b-41d4-a716-446655440000.${ts}`;
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    // At 14 min (under 15 min TTL) → still valid
    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(true);

    // At exactly 15 min → expired
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(verifyCallbackSignature(callbackId, payload, signature)).toBe(false);
  });

  it('falls back to 11 minutes when CALLBACK_TTL_MINUTES is invalid (non-numeric)', () => {
    process.env.CALLBACK_TTL_MINUTES = 'abc';

    expect(getCallbackTtlMs()).toBe(11 * 60 * 1000);
  });

  it('falls back to 11 minutes when CALLBACK_TTL_MINUTES is less than 1', () => {
    process.env.CALLBACK_TTL_MINUTES = '0';

    expect(getCallbackTtlMs()).toBe(11 * 60 * 1000);
  });

  it('falls back to 11 minutes when CALLBACK_TTL_MINUTES is negative', () => {
    process.env.CALLBACK_TTL_MINUTES = '-5';

    expect(getCallbackTtlMs()).toBe(11 * 60 * 1000);
  });

  it('returns correct milliseconds for a valid CALLBACK_TTL_MINUTES value', () => {
    process.env.CALLBACK_TTL_MINUTES = '20';

    expect(getCallbackTtlMs()).toBe(20 * 60 * 1000);
  });

  // ─── Tampered inputs (S-R4.2, S-R4.3) ────────────────────────

  it('rejects tampered callbackId (S-R4.2)', () => {
    const callbackId = makeCallbackId(0);
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    // Tamper the UUID portion
    const tampered = callbackId.replace('550e8400', 'aaaaaaaa');
    expect(verifyCallbackSignature(tampered, payload, signature)).toBe(false);
  });

  it('rejects tampered signature (S-R4.3)', () => {
    const callbackId = makeCallbackId(0);
    const secret = deriveCallbackSecret(callbackId);
    const correctSig = computeSignature(payload, secret);

    // Flip a character in the signature hex
    const tampered = correctSig.slice(0, -1) + (correctSig.endsWith('0') ? '1' : '0');
    expect(verifyCallbackSignature(callbackId, payload, tampered)).toBe(false);
  });

  // ─── Format validation (S-R4.4, S-R4.5, S-R4.6, S-R4.7) ─────

  it('rejects signature missing sha256= prefix (S-R4.4)', () => {
    const callbackId = makeCallbackId(0);
    const secret = deriveCallbackSecret(callbackId);
    const hex = createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifyCallbackSignature(callbackId, payload, hex)).toBe(false);
  });

  it('logs warning when sha256= prefix is missing', () => {
    const callbackId = makeCallbackId(0);
    const secret = deriveCallbackSecret(callbackId);
    const hex = createHmac('sha256', secret).update(payload).digest('hex');

    verifyCallbackSignature(callbackId, payload, hex);

    expect(mockRunnerLogger.warn).toHaveBeenCalledWith(
      { callbackId },
      'Invalid signature format — missing sha256= prefix',
    );
  });

  it('rejects callbackId without dot separator (S-R4.5)', () => {
    expect(verifyCallbackSignature('plain-uuid-no-timestamp', payload, 'sha256=aabb')).toBe(false);
  });

  it('logs warning for callbackId without dot separator', () => {
    verifyCallbackSignature('plain-uuid-no-timestamp', payload, 'sha256=aabb');

    expect(mockRunnerLogger.warn).toHaveBeenCalledWith(
      { callbackId: 'plain-uuid-no-timestamp' },
      'Invalid callbackId format — no timestamp separator',
    );
  });

  it('rejects signature with wrong-length hex (S-R4.6)', () => {
    const callbackId = makeCallbackId(0);

    expect(verifyCallbackSignature(callbackId, payload, 'sha256=aabbccdd')).toBe(false);
  });

  it('rejects invalid hex in signature without throwing (S-R4.7)', () => {
    const callbackId = makeCallbackId(0);

    expect(verifyCallbackSignature(callbackId, payload, 'sha256=zzzzzz')).toBe(false);
  });

  // ─── HMAC failure logging ───────────────────────────────────────

  it('logs warn with "Callback HMAC verification failed" on HMAC mismatch', () => {
    const callbackId = makeCallbackId(0);
    const wrongSig = computeSignature(payload, 'wrong-secret');

    verifyCallbackSignature(callbackId, payload, wrongSig);

    expect(mockRunnerLogger.warn).toHaveBeenCalledWith(
      { callbackId },
      'Callback HMAC verification failed',
    );
  });

  it('does NOT log warn when HMAC verification succeeds', () => {
    const callbackId = makeCallbackId(0);
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    mockRunnerLogger.warn.mockClear();
    verifyCallbackSignature(callbackId, payload, signature);

    const hmacFailCalls = mockRunnerLogger.warn.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'string' && call[1].includes('HMAC verification failed'),
    );
    expect(hmacFailCalls).toHaveLength(0);
  });

  // ─── STATE_SECRET-undefined tests (S-CC1.2) ──────────────────

  it('throws when STATE_SECRET is undefined during verification (S-CC1.2)', () => {
    // First create a valid callbackId with secret set
    const callbackId = makeCallbackId(0);
    const secret = deriveCallbackSecret(callbackId);
    const signature = computeSignature(payload, secret);

    // Now remove STATE_SECRET
    delete process.env.STATE_SECRET;

    expect(() => verifyCallbackSignature(callbackId, payload, signature)).toThrow(
      'STATE_SECRET is not configured',
    );
  });

  // ─── Logger assertions ────────────────────────────────────────

  it('creates a child logger with { module: "runner" }', () => {
    expect(mockRootChildFn).toHaveBeenCalledWith({ module: 'runner' });
  });
});

// ─── Group 2: discoverRunnerRepo ────────────────────────────────

describe('discoverRunnerRepo', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns DiscoveredRunner when repo exists (200)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 123, full_name: 'acme/ghagga-runner', private: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await discoverRunnerRepo('acme', 'ghp_token');

    expect(result).toEqual({ repoId: 123, fullName: 'acme/ghagga-runner', isPrivate: false });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/ghagga-runner');
  });

  it('sends correct Authorization, Accept, and X-GitHub-Api-Version headers', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1, full_name: 'acme/ghagga-runner', private: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await discoverRunnerRepo('acme', 'ghp_my-token');

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers).toEqual({
      Authorization: 'Bearer ghp_my-token',
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('constructs the correct URL from ownerLogin', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 99, full_name: 'my-org/ghagga-runner', private: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await discoverRunnerRepo('my-org', 'ghp_token');

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/my-org/ghagga-runner');
  });

  it('returns null when repo does not exist (404)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const result = await discoverRunnerRepo('acme', 'ghp_token');

    expect(result).toBeNull();
  });

  it('throws on API error (500)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(discoverRunnerRepo('acme', 'ghp_token')).rejects.toThrow(
      'Failed to communicate with GitHub API',
    );
  });

  it('maps response id to repoId and full_name to fullName', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 999, full_name: 'org/ghagga-runner', private: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await discoverRunnerRepo('org', 'ghp_token');

    expect(result).not.toBeNull();
    expect(result?.repoId).toBe(999);
    expect(result?.fullName).toBe('org/ghagga-runner');
    expect(result?.isPrivate).toBe(true);
  });

  it('returns isPrivate: false for public repos', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 456, full_name: 'alice/ghagga-runner', private: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await discoverRunnerRepo('alice', 'ghp_token');

    expect(result).not.toBeNull();
    expect(result?.isPrivate).toBe(false);
  });
});

// ─── Group 3: setRunnerSecret ───────────────────────────────────

describe('setRunnerSecret', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // We need a real NaCl public key for libsodium's crypto_box_seal.
  // Generate a valid Curve25519 keypair encoded as base64.
  // This is a fixed test key — 32 bytes, base64-encoded.
  const testPublicKeyB64 = 'C2o8Fz0SSCMy56fVlx+MPxPvZC7eQVOMlf82K32KJYA=';

  it('encrypts and sets the secret (happy path)', async () => {
    // GET public-key → 200
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // PUT secret → 204
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      setRunnerSecret('acme/ghagga-runner', 'MY_SECRET', 'secret-value', 'ghp_token'),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify the PUT call includes encrypted_value and key_id
    const putCall = mockFetch.mock.calls[1];
    expect(putCall[0]).toContain('/actions/secrets/MY_SECRET');
    expect(putCall[1].method).toBe('PUT');
    const putBody = JSON.parse(putCall[1].body as string);
    expect(putBody).toHaveProperty('encrypted_value');
    expect(putBody).toHaveProperty('key_id', 'key-001');
  });

  it('sends correct headers for GET public-key request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await setRunnerSecret('acme/ghagga-runner', 'MY_SECRET', 'secret-value', 'ghp_tok');

    const getCall = mockFetch.mock.calls[0];
    expect(getCall[0]).toBe(
      'https://api.github.com/repos/acme/ghagga-runner/actions/secrets/public-key',
    );
    expect(getCall[1].headers).toEqual({
      Authorization: 'Bearer ghp_tok',
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('sends correct headers and URL for PUT secret request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await setRunnerSecret('acme/ghagga-runner', 'SEC_NAME', 'val', 'ghp_tok');

    const putCall = mockFetch.mock.calls[1];
    expect(putCall[0]).toBe(
      'https://api.github.com/repos/acme/ghagga-runner/actions/secrets/SEC_NAME',
    );
    expect(putCall[1].method).toBe('PUT');
    expect(putCall[1].headers).toEqual({
      Authorization: 'Bearer ghp_tok',
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('PUT body encrypted_value is a non-empty base64 string', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-010' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await setRunnerSecret('acme/ghagga-runner', 'MY_SECRET', 'my-value', 'ghp_token');

    const putBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(putBody.encrypted_value).toBeTruthy();
    expect(typeof putBody.encrypted_value).toBe('string');
    expect(putBody.encrypted_value.length).toBeGreaterThan(0);
    expect(putBody.key_id).toBe('key-010');
  });

  it('throws when public key fetch fails (500)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(
      setRunnerSecret('acme/ghagga-runner', 'MY_SECRET', 'val', 'ghp_token'),
    ).rejects.toThrow('Failed to communicate with GitHub API');

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws when secret PUT fails (500)', async () => {
    // GET public-key → 200
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-002' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // PUT secret → 500
    mockFetch.mockResolvedValueOnce(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(
      setRunnerSecret('acme/ghagga-runner', 'MY_SECRET', 'val', 'ghp_token'),
    ).rejects.toThrow('Failed to communicate with GitHub API');
  });
});

// ─── Group 4: dispatchWorkflow ──────────────────────────────────

describe('dispatchWorkflow', () => {
  const mockFetch = vi.fn();
  const TEST_SECRET = 'test-dispatch-secret';

  // Same valid test public key as Group 3
  const testPublicKeyB64 = 'C2o8Fz0SSCMy56fVlx+MPxPvZC7eQVOMlf82K32KJYA=';

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockRunnerLogger.info.mockClear();
    mockRunnerLogger.warn.mockClear();
    process.env.STATE_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STATE_SECRET;
  });

  /**
   * Set up mock fetch to handle:
   *  1. GET public-key → 200  (for GHAGGA_TOKEN)
   *  2. PUT secret     → 204  (for GHAGGA_TOKEN)
   *  3. GET public-key → 200  (for GHAGGA_CALLBACK_SECRET)
   *  4. PUT secret     → 204  (for GHAGGA_CALLBACK_SECRET)
   *  5. POST dispatch  → given status
   */
  function setupMockChain(dispatchStatus: number, dispatchBody?: string) {
    // setRunnerSecret(GHAGGA_TOKEN) → GET public key
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-dispatch' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // setRunnerSecret(GHAGGA_TOKEN) → PUT secret
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // setRunnerSecret(GHAGGA_CALLBACK_SECRET) → GET public key
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-dispatch' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // setRunnerSecret(GHAGGA_CALLBACK_SECRET) → PUT secret
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // dispatchWorkflow → POST workflow_dispatch
    // Status 204 is a null-body status; use null body for it.
    const isNullBody = dispatchStatus === 204 || dispatchStatus === 304;
    mockFetch.mockResolvedValueOnce(
      new Response(isNullBody ? null : (dispatchBody ?? ''), {
        status: dispatchStatus,
        statusText: dispatchStatus === 204 ? 'No Content' : 'Unprocessable Entity',
      }),
    );
  }

  it('returns a callbackId in {uuid}.{timestamp_base36} format (S-R2.1)', async () => {
    setupMockChain(204);

    const callbackId = await dispatchWorkflow(makeDispatchParams());

    // Should match uuid.timestamp_base36
    expect(callbackId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-z]+$/,
    );

    // Timestamp portion should parse to a valid time
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const tsPart = callbackId.split('.').pop()!;
    const timestamp = parseInt(tsPart, 36);
    expect(timestamp).toBeGreaterThan(0);
    expect(Math.abs(Date.now() - timestamp)).toBeLessThan(2000); // within 2s
  });

  it('callbackSecret equals HMAC-SHA256(STATE_SECRET, callbackId) (S-R5.1)', async () => {
    setupMockChain(204);

    const callbackId = await dispatchWorkflow(makeDispatchParams());

    const body = JSON.parse(mockFetch.mock.calls[4][1].body as string);
    const expectedSecret = createHmac('sha256', TEST_SECRET).update(callbackId).digest('hex');

    expect(body.inputs.callbackSecret).toBe(expectedSecret);
  });

  it('5 fetch calls: GET+PUT (GHAGGA_TOKEN), GET+PUT (GHAGGA_CALLBACK_SECRET), POST dispatch', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams());

    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('dispatch URL includes ownerLogin/ghagga-runner path', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ ownerLogin: 'my-org' }));

    const dispatchUrl = mockFetch.mock.calls[4][0] as string;
    expect(dispatchUrl).toBe(
      'https://api.github.com/repos/my-org/ghagga-runner/actions/workflows/ghagga-analysis.yml/dispatches',
    );
  });

  it('sends correct headers for the dispatch POST request', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ token: 'ghp_dispatch-tok' }));

    const headers = mockFetch.mock.calls[4][1].headers;
    expect(headers).toEqual({
      Authorization: 'Bearer ghp_dispatch-tok',
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('dispatch body inputs contain all 10 required fields', async () => {
    setupMockChain(204);

    const params = makeDispatchParams({
      ownerLogin: 'org',
      repoFullName: 'org/my-repo',
      prNumber: 42,
      headSha: 'deadbeef',
      baseBranch: 'develop',
      callbackUrl: 'https://cb.example.com/hook',
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: false,
    });

    const callbackId = await dispatchWorkflow(params);

    const body = JSON.parse(mockFetch.mock.calls[4][1].body as string);
    const inputs = body.inputs;

    expect(inputs.callbackId).toBe(callbackId);
    expect(inputs.repoFullName).toBe('org/my-repo');
    expect(inputs.prNumber).toBe('42');
    expect(inputs.headSha).toBe('deadbeef');
    expect(inputs.baseBranch).toBe('develop');
    expect(inputs.callbackUrl).toBe('https://cb.example.com/hook');
    expect(inputs.enableSemgrep).toBe('true');
    expect(inputs.enableTrivy).toBe('true');
    expect(inputs.enableCpd).toBe('false');

    // callbackSecret must be a raw 64-char hex string (32 bytes)
    expect(inputs.callbackSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('callbackSecret is a raw 64-char hex string (no sha256= prefix)', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams());

    const body = JSON.parse(mockFetch.mock.calls[4][1].body as string);
    expect(body.inputs.callbackSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.inputs.callbackSecret.startsWith('sha256=')).toBe(false);
  });

  it('dispatch body ref is "main"', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams());

    const body = JSON.parse(mockFetch.mock.calls[4][1].body as string);
    expect(body.ref).toBe('main');
  });

  it('sets runner secret on ownerLogin/ghagga-runner repo', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ ownerLogin: 'my-org' }));

    // GHAGGA_TOKEN: GET public-key URL should target ownerLogin/ghagga-runner
    const getKeyUrl0 = mockFetch.mock.calls[0][0] as string;
    expect(getKeyUrl0).toBe(
      'https://api.github.com/repos/my-org/ghagga-runner/actions/secrets/public-key',
    );

    // GHAGGA_TOKEN: PUT secret URL should also target ownerLogin/ghagga-runner
    const putSecretUrl0 = mockFetch.mock.calls[1][0] as string;
    expect(putSecretUrl0).toContain('my-org/ghagga-runner/actions/secrets/');

    // GHAGGA_CALLBACK_SECRET: GET public-key URL should target ownerLogin/ghagga-runner
    const getKeyUrl1 = mockFetch.mock.calls[2][0] as string;
    expect(getKeyUrl1).toBe(
      'https://api.github.com/repos/my-org/ghagga-runner/actions/secrets/public-key',
    );

    // GHAGGA_CALLBACK_SECRET: PUT secret URL should also target ownerLogin/ghagga-runner
    const putSecretUrl1 = mockFetch.mock.calls[3][0] as string;
    expect(putSecretUrl1).toContain('my-org/ghagga-runner/actions/secrets/');
  });

  it('sets runner secrets with names GHAGGA_TOKEN and GHAGGA_CALLBACK_SECRET', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ ownerLogin: 'my-org' }));

    // The first PUT secret URL should contain GHAGGA_TOKEN
    const putTokenUrl = mockFetch.mock.calls[1][0] as string;
    expect(putTokenUrl).toBe(
      'https://api.github.com/repos/my-org/ghagga-runner/actions/secrets/GHAGGA_TOKEN',
    );

    // The second PUT secret URL should contain GHAGGA_CALLBACK_SECRET
    const putCallbackUrl = mockFetch.mock.calls[3][0] as string;
    expect(putCallbackUrl).toBe(
      'https://api.github.com/repos/my-org/ghagga-runner/actions/secrets/GHAGGA_CALLBACK_SECRET',
    );
  });

  it('logs info with callbackId, runnerRepo, repoFullName, and prNumber on success', async () => {
    setupMockChain(204);

    const params = makeDispatchParams({
      ownerLogin: 'acme',
      repoFullName: 'acme/my-app',
      prNumber: 77,
    });
    const callbackId = await dispatchWorkflow(params);

    expect(mockRunnerLogger.info).toHaveBeenCalledOnce();
    expect(mockRunnerLogger.info).toHaveBeenCalledWith(
      {
        callbackId,
        runnerRepo: 'acme/ghagga-runner',
        repoFullName: 'acme/my-app',
        prNumber: 77,
      },
      'Dispatched runner workflow',
    );
  });

  it('does NOT log info when dispatch fails', async () => {
    setupMockChain(422, '{"message":"Fail"}');

    try {
      await dispatchWorkflow(makeDispatchParams());
    } catch {
      // expected
    }

    expect(mockRunnerLogger.info).not.toHaveBeenCalled();
  });

  it('prNumber is converted to string in inputs', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ prNumber: 999 }));

    const body = JSON.parse(mockFetch.mock.calls[4][1].body as string);
    expect(body.inputs.prNumber).toBe('999');
    expect(typeof body.inputs.prNumber).toBe('string');
  });

  it('boolean flags are converted to strings in inputs', async () => {
    setupMockChain(204);

    await dispatchWorkflow(
      makeDispatchParams({
        enableSemgrep: false,
        enableTrivy: true,
        enableCpd: true,
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[4][1].body as string);
    expect(body.inputs.enableSemgrep).toBe('false');
    expect(body.inputs.enableTrivy).toBe('true');
    expect(body.inputs.enableCpd).toBe('true');
  });

  it('throws when dispatch API fails (422) — no in-memory cleanup needed (S-R5.3)', async () => {
    setupMockChain(422, '{"message":"Validation Failed"}');

    const params = makeDispatchParams();
    await expect(dispatchWorkflow(params)).rejects.toThrow('Failed to communicate with GitHub API');

    // Verify all 5 fetch calls were made (both setRunnerSecret calls succeeded)
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('throws when STATE_SECRET is undefined (S-CC1.1)', async () => {
    delete process.env.STATE_SECRET;
    // Don't set up mock chain — it will fail on deriveCallbackSecret before any fetch
    await expect(dispatchWorkflow(makeDispatchParams())).rejects.toThrow(
      'STATE_SECRET is not configured',
    );
  });
});

// ─── Group 5: RunnerCreationError ───────────────────────────────

describe('RunnerCreationError', () => {
  it('is an instance of Error', () => {
    const err = new RunnerCreationError('github_error', 'Something went wrong');
    expect(err).toBeInstanceOf(Error);
  });

  it('sets the name to "RunnerCreationError"', () => {
    const err = new RunnerCreationError('github_error', 'Something went wrong');
    expect(err.name).toBe('RunnerCreationError');
  });

  it('stores the error code', () => {
    const err = new RunnerCreationError('insufficient_scope', 'Need more scope');
    expect(err.code).toBe('insufficient_scope');
  });

  it('stores the message', () => {
    const err = new RunnerCreationError('github_error', 'API broke');
    expect(err.message).toBe('API broke');
  });

  it('stores optional retryAfter', () => {
    const err = new RunnerCreationError('rate_limited', 'Too many requests', 120);
    expect(err.retryAfter).toBe(120);
  });

  it('stores optional repoFullName', () => {
    const err = new RunnerCreationError(
      'already_exists',
      'Exists',
      undefined,
      'alice/ghagga-runner',
    );
    expect(err.repoFullName).toBe('alice/ghagga-runner');
  });

  it('has undefined retryAfter and repoFullName when not provided', () => {
    const err = new RunnerCreationError('template_unavailable', 'Not found');
    expect(err.retryAfter).toBeUndefined();
    expect(err.repoFullName).toBeUndefined();
  });

  it('can be instantiated with all error codes', () => {
    const codes: RunnerErrorCode[] = [
      'insufficient_scope',
      'already_exists',
      'template_unavailable',
      'rate_limited',
      'org_permission_denied',
      'creation_timeout',
      'secret_failed',
      'github_error',
    ];

    for (const code of codes) {
      const err = new RunnerCreationError(code, `Error: ${code}`);
      expect(err.code).toBe(code);
      expect(err.name).toBe('RunnerCreationError');
    }
  });
});

// ─── Group 6: createRunnerRepo ──────────────────────────────────

describe('createRunnerRepo', () => {
  const mockFetch = vi.fn();

  // Same valid test public key as Group 3
  const testPublicKeyB64 = 'C2o8Fz0SSCMy56fVlx+MPxPvZC7eQVOMlf82K32KJYA=';

  const defaultOptions = {
    ownerLogin: 'testuser',
    token: 'ghp_test-token',
    callbackSecretValue: 'callback-secret-123',
  };

  // Mirror the module constants (not exported)
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLL_ATTEMPTS = 15;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockRunnerLogger.info.mockClear();
    mockRunnerLogger.error.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Helper: set up mock fetch for a successful createRunnerRepo flow.
   * 1. discoverRunnerRepo → 404 (not found)
   * 2. template generate → 201
   * 3. poll discoverRunnerRepo → 200 (ready on first poll)
   * 4. setRunnerSecret GET public-key → 200
   * 5. setRunnerSecret PUT secret → 204
   */
  function setupSuccessChain(overrides?: { isPrivate?: boolean }) {
    const isPrivate = overrides?.isPrivate ?? false;

    // 1. discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    // 2. template generate → 201
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ full_name: 'testuser/ghagga-runner', private: isPrivate }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // 3. poll discoverRunnerRepo → 200 (found on first poll)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 123, full_name: 'testuser/ghagga-runner', private: isPrivate }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    // 4. setRunnerSecret → GET public-key
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-create' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // 5. setRunnerSecret → PUT secret
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
  }

  it('creates a runner repo successfully (happy path)', async () => {
    setupSuccessChain();

    const promise = createRunnerRepo(defaultOptions);

    // Advance past the poll interval (2s)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    const result = await promise;

    expect(result).toEqual({
      created: true,
      repoFullName: 'testuser/ghagga-runner',
      isPrivate: false,
      secretConfigured: true,
    });
  });

  it('calls the template generate API with correct parameters', async () => {
    setupSuccessChain();

    const promise = createRunnerRepo(defaultOptions);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await promise;

    // Call 1 is discoverRunnerRepo (404), call 2 is template generate
    const generateCall = mockFetch.mock.calls[1];
    expect(generateCall[0]).toBe(
      'https://api.github.com/repos/JNZader/ghagga-runner-template/generate',
    );
    expect(generateCall[1].method).toBe('POST');

    const body = JSON.parse(generateCall[1].body as string);
    expect(body).toEqual({
      owner: 'testuser',
      name: 'ghagga-runner',
      description: 'GHAGGA static analysis runner — auto-created by the GHAGGA Dashboard',
      include_all_branches: false,
      private: false,
    });
  });

  it('throws already_exists when repo exists on pre-check', async () => {
    // discoverRunnerRepo → 200 (repo exists)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 123, full_name: 'testuser/ghagga-runner', private: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    try {
      await createRunnerRepo(defaultOptions);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerCreationError);
      const rce = err as RunnerCreationError;
      expect(rce.code).toBe('already_exists');
      expect(rce.repoFullName).toBe('testuser/ghagga-runner');
    }
  });

  it('throws already_exists on 422 from template generate', async () => {
    // discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 422
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'name already exists' }), { status: 422 }),
    );

    try {
      await createRunnerRepo(defaultOptions);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerCreationError);
      expect((err as RunnerCreationError).code).toBe('already_exists');
    }
  });

  it('throws insufficient_scope on 403 (not rate limited)', async () => {
    // discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 403
    mockFetch.mockResolvedValueOnce(
      new Response('Forbidden', {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '100' },
      }),
    );

    try {
      await createRunnerRepo(defaultOptions);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerCreationError);
      expect((err as RunnerCreationError).code).toBe('insufficient_scope');
    }
  });

  it('throws rate_limited on 403 with X-RateLimit-Remaining: 0', async () => {
    const resetTime = Math.floor(Date.now() / 1000) + 120;

    // discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 403 rate limited
    mockFetch.mockResolvedValueOnce(
      new Response('Rate limit exceeded', {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetTime),
        },
      }),
    );

    try {
      await createRunnerRepo(defaultOptions);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerCreationError);
      const rce = err as RunnerCreationError;
      expect(rce.code).toBe('rate_limited');
      expect(rce.retryAfter).toBeGreaterThan(0);
    }
  });

  it('throws org_permission_denied on 403 with organization/permission in body', async () => {
    // discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 403 org permission denied
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Resource not accessible by organization' }), {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '100' },
      }),
    );

    try {
      await createRunnerRepo(defaultOptions);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerCreationError);
      expect((err as RunnerCreationError).code).toBe('org_permission_denied');
    }
  });

  it('throws template_unavailable on 404 from template generate', async () => {
    // discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    try {
      await createRunnerRepo(defaultOptions);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerCreationError);
      expect((err as RunnerCreationError).code).toBe('template_unavailable');
    }
  });

  it('throws creation_timeout when polling exceeds max attempts', async () => {
    // discoverRunnerRepo → 404 (pre-check)
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 201
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ full_name: 'testuser/ghagga-runner', private: false }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // All poll attempts → 404 (never ready)
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    }

    // Immediately attach error handler to prevent unhandled rejection
    let caughtError: unknown;
    const promise = createRunnerRepo(defaultOptions).catch((err) => {
      caughtError = err;
    });

    // Advance through all poll intervals — each setTimeout needs its own tick
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }

    await promise;

    expect(caughtError).toBeInstanceOf(RunnerCreationError);
    const rce = caughtError as RunnerCreationError;
    expect(rce.code).toBe('creation_timeout');
    expect(rce.repoFullName).toBe('testuser/ghagga-runner');
  });

  it('returns secretConfigured: false when setRunnerSecret fails', async () => {
    // discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 201
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ full_name: 'testuser/ghagga-runner', private: false }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // poll discoverRunnerRepo → 200
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 123, full_name: 'testuser/ghagga-runner', private: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    // setRunnerSecret GET public-key → 500 (fails)
    mockFetch.mockResolvedValueOnce(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    const promise = createRunnerRepo(defaultOptions);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const result = await promise;

    expect(result.created).toBe(true);
    expect(result.secretConfigured).toBe(false);
    expect(result.repoFullName).toBe('testuser/ghagga-runner');
  });

  it('returns isPrivate: true when org forces private repos', async () => {
    setupSuccessChain({ isPrivate: true });

    const promise = createRunnerRepo(defaultOptions);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const result = await promise;

    expect(result.isPrivate).toBe(true);
  });

  it('throws github_error on unexpected status codes', async () => {
    // discoverRunnerRepo → 404
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // template generate → 500
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    try {
      await createRunnerRepo(defaultOptions);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerCreationError);
      expect((err as RunnerCreationError).code).toBe('github_error');
    }
  });

  it('logs info on successful creation', async () => {
    setupSuccessChain();

    const promise = createRunnerRepo(defaultOptions);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await promise;

    // The creation logger is a separate child logger
    expect(mockRootChildFn).toHaveBeenCalledWith({ module: 'runner-creation' });
  });
});

// ─── Group 7: buildDelegatedCiDescriptor ────────────────────────

describe('buildDelegatedCiDescriptor', () => {
  const TEST_SECRET = 'test-delegated-ci-secret';

  /** Build minimal DelegatedCiDispatchParams with sensible defaults. */
  function makeDelegatedCiParams(
    overrides: Partial<DelegatedCiDispatchParams> = {},
  ): DelegatedCiDispatchParams {
    return {
      ownerLogin: 'test-owner',
      repoFullName: 'test-owner/test-repo',
      headSha: 'abc123',
      baseBranch: 'main',
      callbackUrl: 'https://example.com/runner/callback',
      jobKey: 'ci-lint-test',
      profile: 'node-20',
      allowArtifacts: false,
      allowCache: true,
      maxDurationMinutes: 15,
      token: 'ghp_test-token',
      ...overrides,
    };
  }

  beforeEach(() => {
    process.env.STATE_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    delete process.env.STATE_SECRET;
  });

  it('produces a descriptor with kind "delegated-ci"', () => {
    const descriptor = buildDelegatedCiDescriptor(makeDelegatedCiParams());

    expect(descriptor.kind).toBe('delegated-ci');
  });

  it('produces a descriptor with workflowFile "ghagga-delegated-ci.yml"', () => {
    const descriptor = buildDelegatedCiDescriptor(makeDelegatedCiParams());

    expect(descriptor.workflowFile).toBe('ghagga-delegated-ci.yml');
  });

  it('produces a callbackId in {uuid}.{timestamp_base36} format', () => {
    const descriptor = buildDelegatedCiDescriptor(makeDelegatedCiParams());

    expect(descriptor.inputs.callbackId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-z]+$/,
    );

    // Timestamp portion should parse to a valid time
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const tsPart = descriptor.inputs.callbackId.split('.').pop()!;
    const timestamp = parseInt(tsPart, 36);
    expect(timestamp).toBeGreaterThan(0);
    expect(Math.abs(Date.now() - timestamp)).toBeLessThan(2000);
  });

  it('callbackSecret is HMAC-SHA256(STATE_SECRET, callbackId) as 64-char hex', () => {
    const descriptor = buildDelegatedCiDescriptor(makeDelegatedCiParams());

    const expected = createHmac('sha256', TEST_SECRET)
      .update(descriptor.inputs.callbackId)
      .digest('hex');

    expect(descriptor.inputs.callbackSecret).toBe(expected);
    expect(descriptor.inputs.callbackSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('config JSON contains all expected fields', () => {
    const descriptor = buildDelegatedCiDescriptor(
      makeDelegatedCiParams({
        jobKey: 'ci-build',
        profile: 'node-18',
        allowArtifacts: ['junit'],
        allowCache: false,
        maxDurationMinutes: 30,
        prNumber: 42,
      }),
    );

    const config = JSON.parse(descriptor.inputs.config);
    expect(config).toEqual({
      jobKey: 'ci-build',
      profile: 'node-18',
      allowArtifacts: ['junit'],
      allowCache: false,
      maxDurationMinutes: 30,
      prNumber: 42,
    });
  });

  it('prNumber defaults to null when not provided', () => {
    const descriptor = buildDelegatedCiDescriptor(makeDelegatedCiParams());

    const config = JSON.parse(descriptor.inputs.config);
    expect(config.prNumber).toBeNull();
  });

  it('allowArtifacts=false serializes correctly in config', () => {
    const descriptor = buildDelegatedCiDescriptor(makeDelegatedCiParams({ allowArtifacts: false }));

    const config = JSON.parse(descriptor.inputs.config);
    expect(config.allowArtifacts).toBe(false);
  });

  it('allowArtifacts=["junit"] serializes correctly in config', () => {
    const descriptor = buildDelegatedCiDescriptor(
      makeDelegatedCiParams({ allowArtifacts: ['junit'] }),
    );

    const config = JSON.parse(descriptor.inputs.config);
    expect(config.allowArtifacts).toEqual(['junit']);
  });

  it('allowArtifacts=["junit","coverage"] serializes correctly in config', () => {
    const descriptor = buildDelegatedCiDescriptor(
      makeDelegatedCiParams({ allowArtifacts: ['junit', 'coverage'] }),
    );

    const config = JSON.parse(descriptor.inputs.config);
    expect(config.allowArtifacts).toEqual(['junit', 'coverage']);
  });

  it('includes all 7 inputs: callbackId, callbackUrl, callbackSecret, repoFullName, headSha, baseBranch, config', () => {
    const descriptor = buildDelegatedCiDescriptor(makeDelegatedCiParams());

    expect(Object.keys(descriptor.inputs).sort()).toEqual(
      [
        'baseBranch',
        'callbackId',
        'callbackSecret',
        'callbackUrl',
        'config',
        'headSha',
        'repoFullName',
      ].sort(),
    );
  });

  it('passes repoFullName, headSha, baseBranch, and callbackUrl from params', () => {
    const descriptor = buildDelegatedCiDescriptor(
      makeDelegatedCiParams({
        repoFullName: 'org/my-app',
        headSha: 'deadbeef',
        baseBranch: 'develop',
        callbackUrl: 'https://api.ghagga.dev/runner/callback',
      }),
    );

    expect(descriptor.inputs.repoFullName).toBe('org/my-app');
    expect(descriptor.inputs.headSha).toBe('deadbeef');
    expect(descriptor.inputs.baseBranch).toBe('develop');
    expect(descriptor.inputs.callbackUrl).toBe('https://api.ghagga.dev/runner/callback');
  });
});

// ─── Group 8: dispatchRunnerWorkflow ────────────────────────────

describe('dispatchRunnerWorkflow', () => {
  const mockFetch = vi.fn();
  const TEST_SECRET = 'test-dispatch-runner-secret';

  // Same valid test public key as other groups
  const testPublicKeyB64 = 'C2o8Fz0SSCMy56fVlx+MPxPvZC7eQVOMlf82K32KJYA=';

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockRunnerLogger.info.mockClear();
    mockRunnerLogger.warn.mockClear();
    mockRunnerLogger.error.mockClear();
    process.env.STATE_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STATE_SECRET;
  });

  /** Build a test descriptor for delegated CI. */
  function makeTestDescriptor(
    overrides: Partial<RunnerWorkflowDescriptor> = {},
  ): RunnerWorkflowDescriptor {
    const callbackId = '550e8400-e29b-41d4-a716-446655440000.testts';
    return {
      kind: 'delegated-ci',
      workflowFile: 'ghagga-delegated-ci.yml',
      inputs: {
        callbackId,
        callbackUrl: 'https://example.com/runner/callback',
        callbackSecret: 'abc123secret',
        repoFullName: 'test-owner/test-repo',
        headSha: 'deadbeef',
        baseBranch: 'main',
        config: '{"jobKey":"ci-test","profile":"node-20"}',
      },
      ...overrides,
    };
  }

  /**
   * Set up mock fetch for a successful dispatchRunnerWorkflow flow:
   *  1. GET public-key → 200  (for GHAGGA_TOKEN)
   *  2. PUT secret     → 204  (for GHAGGA_TOKEN)
   *  3. GET public-key → 200  (for GHAGGA_CALLBACK_SECRET)
   *  4. PUT secret     → 204  (for GHAGGA_CALLBACK_SECRET)
   *  5. POST dispatch  → given status
   */
  function setupMockChain(dispatchStatus: number, dispatchBody?: string) {
    // setRunnerSecret(GHAGGA_TOKEN) → GET public key
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-dispatch' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // setRunnerSecret(GHAGGA_TOKEN) → PUT secret
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // setRunnerSecret(GHAGGA_CALLBACK_SECRET) → GET public key
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-dispatch' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // setRunnerSecret(GHAGGA_CALLBACK_SECRET) → PUT secret
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // POST dispatch
    const isNullBody = dispatchStatus === 204 || dispatchStatus === 304;
    mockFetch.mockResolvedValueOnce(
      new Response(isNullBody ? null : (dispatchBody ?? ''), {
        status: dispatchStatus,
        statusText: dispatchStatus === 204 ? 'No Content' : 'Error',
      }),
    );
  }

  it('calls setRunnerSecret for GHAGGA_TOKEN and GHAGGA_CALLBACK_SECRET', async () => {
    setupMockChain(204);

    await dispatchRunnerWorkflow(makeTestDescriptor(), 'test-owner', 'ghp_token');

    expect(mockFetch).toHaveBeenCalledTimes(5);

    // GHAGGA_TOKEN PUT
    const putTokenUrl = mockFetch.mock.calls[1][0] as string;
    expect(putTokenUrl).toBe(
      'https://api.github.com/repos/test-owner/ghagga-runner/actions/secrets/GHAGGA_TOKEN',
    );

    // GHAGGA_CALLBACK_SECRET PUT
    const putCallbackUrl = mockFetch.mock.calls[3][0] as string;
    expect(putCallbackUrl).toBe(
      'https://api.github.com/repos/test-owner/ghagga-runner/actions/secrets/GHAGGA_CALLBACK_SECRET',
    );
  });

  it('uses the correct workflowFile in the dispatch URL', async () => {
    setupMockChain(204);

    await dispatchRunnerWorkflow(makeTestDescriptor(), 'my-org', 'ghp_token');

    const dispatchUrl = mockFetch.mock.calls[4][0] as string;
    expect(dispatchUrl).toBe(
      'https://api.github.com/repos/my-org/ghagga-runner/actions/workflows/ghagga-delegated-ci.yml/dispatches',
    );
  });

  it('uses a different workflowFile when descriptor specifies it', async () => {
    setupMockChain(204);

    const descriptor = makeTestDescriptor({ workflowFile: 'ghagga-analysis.yml' });
    await dispatchRunnerWorkflow(descriptor, 'my-org', 'ghp_token');

    const dispatchUrl = mockFetch.mock.calls[4][0] as string;
    expect(dispatchUrl).toBe(
      'https://api.github.com/repos/my-org/ghagga-runner/actions/workflows/ghagga-analysis.yml/dispatches',
    );
  });

  it('returns the callbackId from the descriptor', async () => {
    setupMockChain(204);

    const descriptor = makeTestDescriptor();
    const result = await dispatchRunnerWorkflow(descriptor, 'test-owner', 'ghp_token');

    expect(result).toBe(descriptor.inputs.callbackId);
  });

  it('sends all descriptor inputs in the dispatch body', async () => {
    setupMockChain(204);

    const descriptor = makeTestDescriptor();
    await dispatchRunnerWorkflow(descriptor, 'test-owner', 'ghp_token');

    const body = JSON.parse(mockFetch.mock.calls[4][1].body as string);
    expect(body.ref).toBe('main');
    expect(body.inputs).toEqual(descriptor.inputs);
  });

  it('sends correct headers for the dispatch POST request', async () => {
    setupMockChain(204);

    await dispatchRunnerWorkflow(makeTestDescriptor(), 'test-owner', 'ghp_my-token');

    const headers = mockFetch.mock.calls[4][1].headers;
    expect(headers).toEqual({
      Authorization: 'Bearer ghp_my-token',
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('logs info with callbackId, runnerRepo, and kind on success', async () => {
    setupMockChain(204);

    const descriptor = makeTestDescriptor();
    await dispatchRunnerWorkflow(descriptor, 'test-owner', 'ghp_token');

    expect(mockRunnerLogger.info).toHaveBeenCalledWith(
      {
        callbackId: descriptor.inputs.callbackId,
        runnerRepo: 'test-owner/ghagga-runner',
        kind: 'delegated-ci',
      },
      'Dispatched runner workflow',
    );
  });

  it('throws when dispatch API fails (422)', async () => {
    setupMockChain(422, '{"message":"Validation Failed"}');

    await expect(
      dispatchRunnerWorkflow(makeTestDescriptor(), 'test-owner', 'ghp_token'),
    ).rejects.toThrow('Failed to communicate with GitHub API');
  });

  it('logs error with kind and repo when dispatch fails', async () => {
    setupMockChain(422, '{"message":"Validation Failed"}');

    try {
      await dispatchRunnerWorkflow(makeTestDescriptor(), 'test-owner', 'ghp_token');
    } catch {
      // expected
    }

    expect(mockRunnerLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 422,
        repo: 'test-owner/ghagga-runner',
        kind: 'delegated-ci',
      }),
      'GitHub API error dispatching workflow',
    );
  });

  it('skips GHAGGA_CALLBACK_SECRET when descriptor has no callbackSecret input', async () => {
    // Only 3 fetch calls: GET+PUT (GHAGGA_TOKEN) + POST dispatch
    // setRunnerSecret(GHAGGA_TOKEN) → GET public key
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: testPublicKeyB64, key_id: 'key-dispatch' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // setRunnerSecret(GHAGGA_TOKEN) → PUT secret
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    // POST dispatch → 204
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const descriptor: RunnerWorkflowDescriptor = {
      kind: 'static-analysis',
      workflowFile: 'ghagga-analysis.yml',
      inputs: {
        callbackId: 'test-id.abc',
        repoFullName: 'owner/repo',
      },
    };

    await dispatchRunnerWorkflow(descriptor, 'owner', 'ghp_token');

    // Only 3 fetch calls (no GHAGGA_CALLBACK_SECRET set)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
