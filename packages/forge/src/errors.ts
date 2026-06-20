/**
 * Forge error taxonomy (SDD forge-agnostic — P2 401-recovery fix).
 *
 * The forge boundary throws plain `Error`s on most failures. But the in-job
 * 401-recovery seam (review.ts postback) needs to distinguish an AUTH failure
 * (HTTP 401/403 — the cached installation token was revoked/rotated server-side)
 * from any other failure, GENERICALLY, without sniffing error message strings.
 *
 * {@link ForgeAuthError} is that typed signal. The adapter raises it when an
 * underlying forge call fails with a 401/403 status; the worker catches it via
 * {@link isForgeAuthError}, invalidates the credential provider's cache, re-mints,
 * and retries the call ONCE. Non-auth failures stay plain `Error`s (NOT
 * reclassified) so retry logic only fires for genuine auth failures.
 */

/** HTTP statuses that mean "the token is no longer accepted" → re-mint + retry. */
export const FORGE_AUTH_STATUSES = [401, 403] as const;

/**
 * A forge call failed because the access token was rejected (HTTP 401/403).
 *
 * Carries the originating HTTP `status` and (optionally) the underlying `cause`
 * so callers can log the real error while reacting to the auth class generically.
 */
export class ForgeAuthError extends Error {
  /** The HTTP status that triggered this auth error (401 or 403). */
  readonly status: number;

  constructor(status: number, message?: string, options?: { cause?: unknown }) {
    super(message ?? `Forge auth failure (HTTP ${status})`, options);
    this.name = 'ForgeAuthError';
    this.status = status;
    // Preserve prototype chain across the TS-to-ES5/ES2015 transpile boundary so
    // `instanceof` keeps working even if a downstream target down-levels classes.
    Object.setPrototypeOf(this, ForgeAuthError.prototype);
  }
}

/**
 * Type guard: is `e` a {@link ForgeAuthError}?
 *
 * Robust to cross-realm / multiple-bundle-copy situations (where `instanceof`
 * can fail) by ALSO accepting any error shaped like a ForgeAuthError (name +
 * numeric auth status). Non-auth errors return `false` so they are never
 * mistaken for a retry-able auth failure.
 */
export function isForgeAuthError(e: unknown): e is ForgeAuthError {
  if (e instanceof ForgeAuthError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const candidate = e as { name?: unknown; status?: unknown };
  return (
    candidate.name === 'ForgeAuthError' &&
    typeof candidate.status === 'number' &&
    (FORGE_AUTH_STATUSES as readonly number[]).includes(candidate.status)
  );
}

/**
 * Extract an HTTP status from an arbitrary thrown value, if it carries one.
 *
 * The `apps/server` GitHub client tags its thrown errors with a numeric
 * `status` field (see client.ts). The adapter uses this to decide whether a
 * client failure is an auth failure (401/403) it should reclassify as a
 * {@link ForgeAuthError}. Returns `undefined` when no usable status is present.
 */
export function getErrorStatus(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const status = (e as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
