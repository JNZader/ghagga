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

/** Notify listeners (AuthProvider) that the current session is no longer valid. */
export function notifySessionExpired(): void {
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
