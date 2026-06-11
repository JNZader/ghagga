/**
 * Cross-module session-expiry signal.
 *
 * `api.ts` is a plain module (no React), so when the server answers 401 it
 * cannot touch AuthContext state directly. It dispatches this window event
 * instead; `AuthProvider` listens and clears the in-memory auth state so
 * `ProtectedRoute`/`Login` see `isAuthenticated === false` and the user is
 * not bounced back into authenticated routes (the 401 redirect loop).
 */
export const SESSION_EXPIRED_EVENT = 'ghagga:session-expired';

/**
 * Sticky flag for the cold-boot race: a 401 can fire BEFORE AuthProvider's
 * mount effect registers its event listener (the dispatch is then lost,
 * leaving stale auth state). We latch the signal here so the provider can
 * drain it on mount even if it missed the live event.
 */
let sessionExpiredPending = false;

/** Notify listeners (AuthProvider) that the current session is no longer valid. */
export function notifySessionExpired(): void {
  sessionExpiredPending = true;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/**
 * Returns true once if a session-expired signal fired (latched), then clears it.
 * AuthProvider calls this on mount to catch a pre-mount 401 that the live
 * listener missed. Returns false on subsequent calls until the next signal.
 */
export function consumeSessionExpired(): boolean {
  if (!sessionExpiredPending) return false;
  sessionExpiredPending = false;
  return true;
}
