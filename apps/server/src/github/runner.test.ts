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
  type DelegatedCiDispatchParams,
  type DispatchParams,
  deriveCallbackSecret,
  dispatchRunnerWorkflow,
  dispatchWorkflow,
  getCallbackTtlMs,
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
    repoFullName: 'test-owner/test-repo',
    prNumber: 1,
    headSha: 'abc123',
    baseBranch: 'main',
    callbackUrl: 'https://example.com/callback',
    callbackSecret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    callbackId: '550e8400-e29b-41d4-a716-446655440000.m1abc',
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

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockRunnerLogger.info.mockClear();
    mockRunnerLogger.warn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Set up mock fetch to handle the single dispatch POST call.
   */
  function setupMockChain(dispatchStatus: number, dispatchBody?: string) {
    // dispatchWorkflow → POST workflow_dispatch (only 1 fetch call)
    const isNullBody = dispatchStatus === 204 || dispatchStatus === 304;
    mockFetch.mockResolvedValueOnce(
      new Response(isNullBody ? null : (dispatchBody ?? ''), {
        status: dispatchStatus,
        statusText: dispatchStatus === 204 ? 'No Content' : 'Unprocessable Entity',
      }),
    );
  }

  it('returns the callbackId passed in params (S-R2.1)', async () => {
    setupMockChain(204);

    const params = makeDispatchParams({
      callbackId: '550e8400-e29b-41d4-a716-446655440000.m1test',
    });
    const result = await dispatchWorkflow(params);

    expect(result).toBe('550e8400-e29b-41d4-a716-446655440000.m1test');
  });

  it('makes exactly 1 fetch call (the dispatch POST)', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams());

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('dispatch URL targets repoFullName with ghagga.yml', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ repoFullName: 'my-org/my-repo' }));

    const dispatchUrl = mockFetch.mock.calls[0][0] as string;
    expect(dispatchUrl).toBe(
      'https://api.github.com/repos/my-org/my-repo/actions/workflows/ghagga.yml/dispatches',
    );
  });

  it('sends correct headers for the dispatch POST request', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ token: 'ghp_dispatch-tok' }));

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).toEqual({
      Authorization: 'Bearer ghp_dispatch-tok',
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('dispatch body inputs contain all required fields with correct values', async () => {
    setupMockChain(204);

    const callbackId = 'abc00000-e29b-41d4-a716-446655440000.m1xyz';
    const callbackSecret = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const params = makeDispatchParams({
      repoFullName: 'org/my-repo',
      prNumber: 42,
      headSha: 'deadbeef',
      callbackUrl: 'https://cb.example.com/hook',
      callbackSecret,
      callbackId,
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: false,
      enabledTools: ['semgrep', 'trivy'],
      disabledTools: ['cpd'],
    });

    await dispatchWorkflow(params);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const inputs = body.inputs;

    expect(inputs.callbackId).toBe(callbackId);
    expect(inputs.prNumber).toBe('42');
    expect(inputs.headSha).toBe('deadbeef');
    expect(inputs.callbackUrl).toBe('https://cb.example.com/hook');
    expect(inputs.callbackSecret).toBe(callbackSecret);
    expect(inputs.enableSemgrep).toBe('true');
    expect(inputs.enableTrivy).toBe('true');
    expect(inputs.enableCpd).toBe('false');
    expect(inputs.enabledTools).toBe('["semgrep","trivy"]');
    expect(inputs.disabledTools).toBe('["cpd"]');
  });

  it('inputs do NOT contain repoFullName or baseBranch as workflow input fields', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.inputs).not.toHaveProperty('repoFullName');
    expect(body.inputs).not.toHaveProperty('baseBranch');
  });

  it('dispatch body ref uses baseBranch from params', async () => {
    setupMockChain(204);

    await dispatchWorkflow(makeDispatchParams({ baseBranch: 'develop' }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.ref).toBe('develop');
  });

  it('callbackSecret in inputs is passed through as-is from params', async () => {
    setupMockChain(204);

    const callbackSecret = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    await dispatchWorkflow(makeDispatchParams({ callbackSecret }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.inputs.callbackSecret).toBe(callbackSecret);
  });

  it('enabledTools defaults to empty JSON array when not provided', async () => {
    setupMockChain(204);

    // makeDispatchParams does not set enabledTools/disabledTools by default
    await dispatchWorkflow(makeDispatchParams());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.inputs.enabledTools).toBe('[]');
    expect(body.inputs.disabledTools).toBe('[]');
  });

  it('logs info with callbackId, repoFullName, and prNumber on success', async () => {
    setupMockChain(204);

    const params = makeDispatchParams({
      repoFullName: 'acme/my-app',
      prNumber: 77,
      callbackId: '550e8400-e29b-41d4-a716-446655440000.logtest',
    });
    await dispatchWorkflow(params);

    expect(mockRunnerLogger.info).toHaveBeenCalledOnce();
    expect(mockRunnerLogger.info).toHaveBeenCalledWith(
      {
        callbackId: '550e8400-e29b-41d4-a716-446655440000.logtest',
        repoFullName: 'acme/my-app',
        prNumber: 77,
      },
      'Dispatched inline workflow',
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

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
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

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.inputs.enableSemgrep).toBe('false');
    expect(body.inputs.enableTrivy).toBe('true');
    expect(body.inputs.enableCpd).toBe('true');
  });

  it('throws when dispatch API fails (422)', async () => {
    setupMockChain(422, '{"message":"Validation Failed"}');

    await expect(dispatchWorkflow(makeDispatchParams())).rejects.toThrow(
      'Failed to communicate with GitHub API',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
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
