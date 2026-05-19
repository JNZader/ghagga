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
  type DispatchParams,
  deriveCallbackSecret,
  dispatchWorkflow,
  getCallbackTtlMs,
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
