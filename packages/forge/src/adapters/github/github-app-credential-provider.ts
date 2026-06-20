/**
 * GitHubAppCredentialProvider — the REAL P2 {@link ForgeCredentialProvider} for
 * the GitHub App installation-token flow (SDD forge-agnostic task 2.1).
 *
 * Replaces P1's `TemporaryGitHubTokenSource` (which minted a fresh token on every
 * `getToken()` call, no cache). This provider delivers the R-TOKEN contract:
 *
 *   - TTL CACHE: a minted token is reused until `expiresAtMs - SKEW_SECONDS`.
 *   - BUDGET VALIDITY: `getToken()` returns a token valid for >= `BUDGET_SECONDS`
 *     of REMAINING life. If the cached token would expire within that budget, it
 *     is re-minted PROACTIVELY (never "wait for a 401"). This is what makes the
 *     ~11-min fetch+dispatch+poll phase reuse one token AND guarantees the
 *     postback token outlives the postback.
 *   - SINGLEFLIGHT: concurrent `getToken()` calls with no valid cached token
 *     share ONE in-flight mint promise (no duplicate concurrent mints).
 *   - 401/403 FORCE-REFRESH: {@link GitHubAppCredentialProvider.invalidate}
 *     drops the cache so the next `getToken()` re-mints. The caller signals an
 *     auth failure (401/403) by calling `invalidate()`.
 *   - HARD-FAIL: if the mint POST fails HARD (non-401, e.g. 500/network), the
 *     in-flight promise rejects and `getToken()` REJECTS — NO stale/empty token
 *     is returned, so the job fails fast.
 *
 * DEPENDENCY INVERSION (R-AGNOSTIC): like the adapter, this class does NOT import
 * `apps/server`. The real expiry-carrying mint is injected as
 * {@link GitHubInstallationTokenMintWithExpiry}; the composition root in
 * apps/server adapts `client.getInstallationToken` to also surface `expires_at`.
 *
 * DETERMINISTIC CLOCK: time is read through an injected `now()` (defaults to
 * {@link Date.now}). `Date.now` is not otherwise controllable in tests; injecting
 * it lets the fake-clock tests (task 2.4) drive TTL/budget/expiry decisions
 * deterministically.
 */

import type { ForgeCredentialProvider } from '../../ports/credential-provider.js';
import type {
  GitHubInstallationTokenMintWithExpiry,
  MintedInstallationToken,
} from './github-client-port.js';

/**
 * Early-refresh margin (seconds). The cached token is treated as expired this
 * many seconds BEFORE its real `expiresAtMs`, absorbing clock skew between this
 * process and GitHub so a token never gets USED in the moments around its true
 * expiry. (Design Open Question resolved: a fixed value is enough for P1–P4.)
 */
export const SKEW_SECONDS = 60;

/**
 * Required remaining validity (seconds). `getToken()` guarantees the returned
 * token has at least this much life left; otherwise it re-mints PROACTIVELY.
 * This is the "token must OUTLIVE the postback" budget — sized so a token handed
 * out just before the comment postback cannot expire mid-postback.
 */
export const BUDGET_SECONDS = 120;

/** Construction options for {@link GitHubAppCredentialProvider}. */
export interface GitHubAppCredentialProviderDeps {
  /**
   * Injected expiry-carrying installation-token mint. Real impl = the apps/server
   * composition root adapting `client.getInstallationToken` to surface
   * `expires_at`. MUST reject on a HARD failure (non-401) — the provider relies
   * on that rejection to fail fast.
   */
  mint: GitHubInstallationTokenMintWithExpiry;
  /** GitHub App installation id. */
  installationId: number;
  /** GitHub App id. */
  appId: string;
  /** GitHub App private key (PEM). */
  privateKey: string;
  /** Optional repository-id scoping for the minted token. */
  repositoryIds?: number[];
  /**
   * Injected clock — epoch millis. Defaults to {@link Date.now}. Override in
   * tests to make TTL/budget/expiry decisions deterministic.
   */
  now?: () => number;
}

/**
 * TTL-cached, single-flight, budget-valid GitHub installation-token provider.
 *
 * @see {@link ForgeCredentialProvider} — the port it implements.
 */
export class GitHubAppCredentialProvider implements ForgeCredentialProvider {
  readonly #mint: GitHubInstallationTokenMintWithExpiry;
  readonly #installationId: number;
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #repositoryIds?: number[];
  readonly #now: () => number;

  /** The last successfully minted token + its expiry, or null when uncached. */
  #cached: MintedInstallationToken | null = null;

  /**
   * The in-flight mint promise, or null when no mint is running. SINGLEFLIGHT:
   * concurrent callers that find no valid cached token await THIS shared promise
   * instead of each starting their own mint.
   */
  #inFlight: Promise<MintedInstallationToken> | null = null;

  constructor(deps: GitHubAppCredentialProviderDeps) {
    this.#mint = deps.mint;
    this.#installationId = deps.installationId;
    this.#appId = deps.appId;
    this.#privateKey = deps.privateKey;
    this.#repositoryIds = deps.repositoryIds;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Resolve a budget-valid installation token.
   *
   * Returns the cached token when it still has >= `BUDGET_SECONDS` of life
   * (minus `SKEW_SECONDS` margin). Otherwise mints a fresh one — coalescing
   * concurrent callers onto a single in-flight mint. Rejects (no stale token) if
   * the mint fails hard.
   */
  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (cached !== null && this.#isUsable(cached)) {
      return cached.token;
    }

    // SINGLEFLIGHT: if a mint is already running, await it instead of starting
    // a second one. All concurrent callers share the same promise + result.
    if (this.#inFlight !== null) {
      const minted = await this.#inFlight;
      return minted.token;
    }

    const inFlight = this.#mint(
      this.#installationId,
      this.#appId,
      this.#privateKey,
      this.#repositoryIds && this.#repositoryIds.length > 0
        ? { repositoryIds: this.#repositoryIds }
        : undefined,
    );
    this.#inFlight = inFlight;

    try {
      const minted = await inFlight;
      // HARD-FAIL safety: only cache on success. On rejection we fall through to
      // the finally + the throw below — the cache is NEVER populated with a
      // stale/empty token, so the job fails fast.
      this.#cached = minted;
      return minted.token;
    } finally {
      // Clear the in-flight slot whether the mint resolved or rejected, so a
      // failed mint does not wedge every future caller onto a rejected promise.
      if (this.#inFlight === inFlight) {
        this.#inFlight = null;
      }
    }
  }

  /**
   * Drop the cached token so the NEXT `getToken()` re-mints. The caller invokes
   * this on a 401/403 auth failure (the token was revoked/rotated server-side
   * before its advertised expiry). An in-flight mint is left untouched — it is
   * already a fresh acquisition.
   */
  invalidate(): void {
    this.#cached = null;
  }

  /**
   * A cached token is usable when its remaining life (with the skew margin
   * applied) still covers the required budget. i.e.
   *   expiresAtMs - SKEW*1000  >=  now + BUDGET*1000
   * Equivalently: the skew-adjusted expiry is at least `BUDGET_SECONDS` in the
   * future. Otherwise it must be re-minted PROACTIVELY (not via a 401).
   */
  #isUsable(token: MintedInstallationToken): boolean {
    const skewAdjustedExpiry = token.expiresAtMs - SKEW_SECONDS * 1000;
    const budgetDeadline = this.#now() + BUDGET_SECONDS * 1000;
    return skewAdjustedExpiry >= budgetDeadline;
  }
}
