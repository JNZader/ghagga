/**
 * credential.test.ts — R-TOKEN contract for the P2 credential providers
 * (SDD forge-agnostic tasks 2.4 + 2.5).
 *
 * Uses a FAKE CLOCK (the injected `now`) so TTL / budget / proactive-expiry
 * decisions are deterministic — `Date.now()` is never read by these tests.
 *
 * Coverage (per the spec Test-Guard Inventory row "credential.test.ts"):
 *   - TTL no-remint           (2.4) — cached token reused until near expiry
 *   - singleflight            (2.4) — N concurrent getToken → exactly 1 mint
 *   - proactive expiry-poll   (2.4) — token expiring within BUDGET re-minted
 *                                     PROACTIVELY, not via a 401
 *   - 401 force-refresh       (2.4) — invalidate() → next getToken re-mints
 *   - hard-fail rejects       (2.4) — mint throws → getToken rejects, no stale
 *   - provider swap App→Static(2.5) — both satisfy the port; a port consumer
 *                                     works with either, no consumer change
 */

import { describe, expect, it, vi } from 'vitest';
import type { ForgeCredentialProvider } from '../../ports/credential-provider.js';
import {
  BUDGET_SECONDS,
  GitHubAppCredentialProvider,
  SKEW_SECONDS,
} from './github-app-credential-provider.js';
import type { MintedInstallationToken } from './github-client-port.js';
import { StaticTokenProvider } from './static-token-provider.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A mutable fake clock injected as `now`. */
function makeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

/**
 * Build a provider whose injected mint returns a token expiring `ttlMs` after
 * the CURRENT fake-clock time on EACH mint (GitHub installation tokens live
 * ~1h). Returns the provider, the mint spy, and the clock.
 */
function makeProvider(opts: { startMs?: number; ttlMs?: number } = {}) {
  const clock = makeClock(opts.startMs ?? 0);
  const ttlMs = opts.ttlMs ?? 60 * MINUTE; // GitHub default ~1h
  let mintSeq = 0;
  const mint = vi.fn(async (): Promise<MintedInstallationToken> => {
    mintSeq += 1;
    return { token: `ghs_mint-${mintSeq}`, expiresAtMs: clock.now() + ttlMs };
  });
  const provider = new GitHubAppCredentialProvider({
    mint,
    installationId: 7777,
    appId: 'app-id',
    privateKey: 'PEM',
    now: clock.now,
  });
  return { provider, mint, clock };
}

describe('GitHubAppCredentialProvider (task 2.1) — R-TOKEN', () => {
  it('implements ForgeCredentialProvider', () => {
    const { provider } = makeProvider();
    const asPort: ForgeCredentialProvider = provider;
    expect(typeof asPort.getToken).toBe('function');
  });

  // ── TTL no-remint: cached token reused until near expiry ──────────
  it('reuses the cached token across calls until near expiry (TTL, no re-mint)', async () => {
    const { provider, mint, clock } = makeProvider({ ttlMs: 60 * MINUTE });

    const first = await provider.getToken();
    expect(first).toBe('ghs_mint-1');
    expect(mint).toHaveBeenCalledTimes(1);

    // Advance well within validity (10 min into a 60-min token) — still cached.
    clock.advance(10 * MINUTE);
    expect(await provider.getToken()).toBe('ghs_mint-1');
    // Another small hop — still the SAME minted token.
    clock.advance(5 * MINUTE);
    expect(await provider.getToken()).toBe('ghs_mint-1');

    expect(mint).toHaveBeenCalledTimes(1); // ZERO re-mints while valid
  });

  it('re-mints once the cached token crosses the skew+budget threshold', async () => {
    // 10-min token; SKEW=60s, BUDGET=120s. Usable while
    //   (expiresAt - SKEW) - now >= BUDGET  ⇔  remaining >= SKEW+BUDGET = 180s.
    const { provider, mint, clock } = makeProvider({ startMs: 0, ttlMs: 10 * MINUTE });
    expect(await provider.getToken()).toBe('ghs_mint-1');

    // Move to exactly the threshold: remaining == SKEW+BUDGET → still usable.
    clock.set(10 * MINUTE - (SKEW_SECONDS + BUDGET_SECONDS) * SECOND);
    expect(await provider.getToken()).toBe('ghs_mint-1');
    expect(mint).toHaveBeenCalledTimes(1);

    // One second past the threshold → must proactively re-mint.
    clock.advance(1 * SECOND);
    expect(await provider.getToken()).toBe('ghs_mint-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  // ── Singleflight: N concurrent getToken → exactly 1 mint ──────────
  it('coalesces N concurrent getToken() calls to exactly ONE mint (singleflight)', async () => {
    const clock = makeClock(0);
    // Gate the mint so all concurrent callers pile up on the SAME in-flight
    // promise before it resolves.
    let release!: (v: MintedInstallationToken) => void;
    const gated = new Promise<MintedInstallationToken>((res) => {
      release = res;
    });
    const mint = vi.fn(() => gated);
    const provider = new GitHubAppCredentialProvider({
      mint,
      installationId: 1,
      appId: 'a',
      privateKey: 'p',
      now: clock.now,
    });

    const calls = Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    // Exactly one upstream mint started despite 5 concurrent callers.
    expect(mint).toHaveBeenCalledTimes(1);

    release({ token: 'ghs_shared', expiresAtMs: clock.now() + 60 * MINUTE });
    const results = await calls;
    expect(results).toEqual(['ghs_shared', 'ghs_shared', 'ghs_shared', 'ghs_shared', 'ghs_shared']);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  // ── Proactive expiry-during-poll: re-mint BEFORE postback, not via 401 ──
  it('PROACTIVELY re-mints when the cached token would expire within budget before postback', async () => {
    // Simulate review.ts: mint at fetch (phase 1), long poll, then postback.
    // The phase-1 token has a SHORT life so it falls inside BUDGET by postback.
    const { provider, mint, clock } = makeProvider({ startMs: 0, ttlMs: 5 * MINUTE });

    // Phase 1: fetch+dispatch token.
    const fetchToken = await provider.getToken();
    expect(fetchToken).toBe('ghs_mint-1');
    expect(mint).toHaveBeenCalledTimes(1);

    // Poll loop burns time — advance to where the phase-1 token has LESS than
    // SKEW+BUDGET (180s) of life left (4m30s elapsed of a 5m token → 30s left).
    clock.advance(4 * MINUTE + 30 * SECOND);

    // Phase 2: postback getToken — must hand out a token that OUTLIVES the
    // postback, so it re-mints PROACTIVELY (no 401 was ever signalled).
    const postbackToken = await provider.getToken();
    expect(postbackToken).toBe('ghs_mint-2');
    expect(postbackToken).not.toBe(fetchToken);
    expect(mint).toHaveBeenCalledTimes(2);

    // The fresh token has full budget life — comfortably outlives the postback.
    // (No invalidate() / 401 path was used: this is purely proactive.)
  });

  // ── 401 force-refresh: invalidate() → next getToken re-mints ───────
  it('re-mints on the next getToken() after invalidate() (401/403 force-refresh)', async () => {
    const { provider, mint, clock } = makeProvider({ ttlMs: 60 * MINUTE });

    const t1 = await provider.getToken();
    expect(t1).toBe('ghs_mint-1');
    // Still well within TTL — a plain getToken would reuse it.
    clock.advance(1 * MINUTE);
    expect(await provider.getToken()).toBe('ghs_mint-1');
    expect(mint).toHaveBeenCalledTimes(1);

    // Caller hits a 401 (token revoked server-side before its advertised expiry)
    // and signals it. The NEXT getToken must re-mint despite the cache being
    // nominally still valid.
    provider.invalidate();
    const t2 = await provider.getToken();
    expect(t2).toBe('ghs_mint-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  // ── Hard-fail: mint throws (non-401) → getToken rejects, no stale ──
  it('REJECTS (no stale/empty token) when the mint fails hard', async () => {
    const clock = makeClock(0);
    const mint = vi
      .fn<() => Promise<MintedInstallationToken>>()
      .mockRejectedValueOnce(new Error('GitHub API error getting installation token: 500'));
    const provider = new GitHubAppCredentialProvider({
      mint,
      installationId: 1,
      appId: 'a',
      privateKey: 'p',
      now: clock.now,
    });

    await expect(provider.getToken()).rejects.toThrow(/500/);
    // No token cached → a subsequent call tries again (not wedged on the
    // rejected in-flight promise). Make the retry succeed to prove recovery.
    mint.mockResolvedValueOnce({
      token: 'ghs_after-recovery',
      expiresAtMs: clock.now() + 60 * MINUTE,
    });
    await expect(provider.getToken()).resolves.toBe('ghs_after-recovery');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('a hard-failed concurrent batch all reject (no stale token leaks to any caller)', async () => {
    const clock = makeClock(0);
    let reject!: (e: unknown) => void;
    const gated = new Promise<MintedInstallationToken>((_res, rej) => {
      reject = rej;
    });
    const mint = vi.fn(() => gated);
    const provider = new GitHubAppCredentialProvider({
      mint,
      installationId: 1,
      appId: 'a',
      privateKey: 'p',
      now: clock.now,
    });

    const a = provider.getToken();
    const b = provider.getToken();
    expect(mint).toHaveBeenCalledTimes(1); // singleflight
    reject(new Error('network down'));

    await expect(a).rejects.toThrow(/network down/);
    await expect(b).rejects.toThrow(/network down/);
  });

  it('passes repositoryIds scoping to the mint when provided', async () => {
    const clock = makeClock(0);
    const mint = vi.fn(
      async (): Promise<MintedInstallationToken> => ({
        token: 't',
        expiresAtMs: clock.now() + 60 * MINUTE,
      }),
    );
    const provider = new GitHubAppCredentialProvider({
      mint,
      installationId: 99,
      appId: 'app',
      privateKey: 'PEM',
      repositoryIds: [1, 2],
      now: clock.now,
    });
    await provider.getToken();
    expect(mint).toHaveBeenCalledWith(99, 'app', 'PEM', { repositoryIds: [1, 2] });
  });

  it('omits the options arg when no repositoryIds are configured', async () => {
    const { provider, mint } = makeProvider();
    await provider.getToken();
    expect(mint).toHaveBeenCalledWith(7777, 'app-id', 'PEM', undefined);
  });

  it('exposes invalidate() as part of the ForgeCredentialProvider port', () => {
    const { provider } = makeProvider();
    const asPort: ForgeCredentialProvider = provider;
    expect(typeof asPort.invalidate).toBe('function');
  });

  // ── FIX 4: in-flight fence — a mint that started BEFORE invalidate() must
  //    NOT repopulate the cache when it resolves AFTER the invalidate. ────────
  it('does NOT re-cache an in-flight mint when invalidate() races it (generation fence)', async () => {
    const clock = makeClock(0);
    // Gate mint #1 so we can invalidate() WHILE it is in flight, then resolve it.
    let release1!: (v: MintedInstallationToken) => void;
    const gated1 = new Promise<MintedInstallationToken>((res) => {
      release1 = res;
    });
    let mintCalls = 0;
    const mint = vi.fn((): Promise<MintedInstallationToken> => {
      mintCalls += 1;
      if (mintCalls === 1) return gated1;
      // mint #2 (the post-invalidation re-mint) resolves immediately.
      return Promise.resolve({ token: 'ghs_mint-2', expiresAtMs: clock.now() + 60 * MINUTE });
    });
    const provider = new GitHubAppCredentialProvider({
      mint,
      installationId: 1,
      appId: 'a',
      privateKey: 'p',
      now: clock.now,
    });

    // Start mint #1 (in flight, not yet resolved).
    const inflight = provider.getToken();
    expect(mint).toHaveBeenCalledTimes(1);

    // A 401 arrives mid-mint → caller invalidates the (currently empty) cache.
    provider.invalidate();

    // NOW mint #1 resolves — its token belongs to the PRE-invalidation generation
    // and MUST NOT be cached. The awaiting caller still RECEIVES it (fresh for it).
    release1({ token: 'ghs_mint-1', expiresAtMs: clock.now() + 60 * MINUTE });
    await expect(inflight).resolves.toBe('ghs_mint-1');

    // The fence held: the cache was NOT repopulated with mint-1, so the next
    // getToken() must RE-MINT (→ mint-2) rather than hand back the stale mint-1.
    const next = await provider.getToken();
    expect(next).toBe('ghs_mint-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('a normal (un-raced) in-flight mint DOES cache (fence does not over-fire)', async () => {
    // Sanity counter-test: without an invalidate during the mint, the result IS
    // cached and reused — proving the fence only blocks the raced case.
    const { provider, mint, clock } = makeProvider({ ttlMs: 60 * MINUTE });
    expect(await provider.getToken()).toBe('ghs_mint-1');
    clock.advance(1 * MINUTE);
    expect(await provider.getToken()).toBe('ghs_mint-1'); // cached, no re-mint
    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe('StaticTokenProvider (task 2.2) — R-TOKEN CLI path', () => {
  it('implements ForgeCredentialProvider and returns the fixed token', async () => {
    const provider: ForgeCredentialProvider = new StaticTokenProvider('ghp_static-pat');
    expect(typeof provider.getToken).toBe('function');
    await expect(provider.getToken()).resolves.toBe('ghp_static-pat');
  });

  it('returns the SAME token on every call (no cache logic, no refresh, no mint)', async () => {
    const provider = new StaticTokenProvider('ghp_static-pat');
    expect(await provider.getToken()).toBe('ghp_static-pat');
    expect(await provider.getToken()).toBe('ghp_static-pat');
    expect(await provider.getToken()).toBe('ghp_static-pat');
  });

  it('invalidate() is a no-op: the token is unchanged afterwards (no cache to drop)', async () => {
    const provider = new StaticTokenProvider('ghp_static-pat');
    // Satisfies the port and must not throw.
    const asPort: ForgeCredentialProvider = provider;
    expect(typeof asPort.invalidate).toBe('function');
    expect(() => provider.invalidate()).not.toThrow();
    // Same fixed token before AND after invalidate() — nothing was dropped.
    await expect(provider.getToken()).resolves.toBe('ghp_static-pat');
  });
});

// ── 2.5: provider swap App→Static requires NO consumer change ───────
describe('provider swap (task 2.5) — App→Static, no consumer change', () => {
  /**
   * A stand-in for the worker: it depends ONLY on the ForgeCredentialProvider
   * PORT. The SAME function works with either concrete provider — proving the
   * auth strategy is a pure construction-site choice (R-TOKEN swap scenario).
   */
  async function consumeViaPort(provider: ForgeCredentialProvider): Promise<string> {
    // Exactly what review.ts does: resolve a token through the port.
    return provider.getToken();
  }

  it('the SAME port consumer works with GitHubAppCredentialProvider', async () => {
    const clock = makeClock(0);
    const provider = new GitHubAppCredentialProvider({
      mint: async () => ({ token: 'ghs_app', expiresAtMs: clock.now() + 60 * MINUTE }),
      installationId: 1,
      appId: 'a',
      privateKey: 'p',
      now: clock.now,
    });
    await expect(consumeViaPort(provider)).resolves.toBe('ghs_app');
  });

  it('the SAME port consumer works with StaticTokenProvider — no code change', async () => {
    const provider = new StaticTokenProvider('ghp_static');
    await expect(consumeViaPort(provider)).resolves.toBe('ghp_static');
  });
});
