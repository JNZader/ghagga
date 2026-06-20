/**
 * The forge credential provider port (task 0.5).
 *
 * P1's task 1.3 consumes this seam to obtain a forge access token without the
 * adapter knowing HOW the token is sourced (env var, GitHub App installation
 * token, OAuth refresh, secret manager, …). Keeping this an interface lets the
 * token-acquisition strategy vary per deployment without touching adapters.
 */

/** Supplies a forge access token on demand. */
export interface ForgeCredentialProvider {
  /**
   * Resolve a valid forge access token.
   *
   * Implementations are responsible for any caching / refresh. Callers should
   * treat the returned token as short-lived and re-call when they need a fresh
   * one rather than holding it indefinitely.
   */
  getToken(): Promise<string>;

  /**
   * Drop any cached token so the NEXT {@link getToken} re-acquires a fresh one.
   *
   * Callers invoke this on a forge auth failure (HTTP 401/403) — the token was
   * revoked/rotated server-side BEFORE its advertised expiry, so the cache is
   * stale even though it looks valid. This is the in-job recovery seam: catch a
   * {@link ForgeAuthError}, `invalidate()`, re-`getToken()`, retry the call once.
   *
   * Implementations with NO cache (e.g. a fixed-token provider) implement this
   * as a no-op — there is nothing to drop.
   */
  invalidate(): void;
}
