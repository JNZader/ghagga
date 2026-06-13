/**
 * OAuth Web Flow callback page.
 *
 * Handles the redirect back from GitHub OAuth via the server.
 * The server redirects to: `.../#/auth/callback?token=gho_xxx`
 * or `.../#/auth/callback?error=<code>` on failure.
 *
 * Since the Dashboard uses HashRouter, the token arrives as a
 * query param inside the hash fragment. We use `useSearchParams()`
 * from react-router-dom which handles this automatically.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { REDIRECT_KEY, useAuth } from '@/lib/auth';

// ─── Error Messages ─────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  state_expired: 'Your login session expired. Please try again.',
  invalid_state: 'Security validation failed. Please try again.',
  exchange_failed: 'Could not complete authentication with GitHub.',
  access_denied: 'You cancelled the authorization. Want to try again?',
  missing_code: 'Error in the GitHub response. Please try again.',
  missing_state: 'Security parameter missing. Please try again.',
  github_unavailable:
    'GitHub is not available right now. Please try later or use a Personal Access Token.',
  server_error: 'Server error. Please try again or use a Personal Access Token.',
};

// ─── Component ──────────────────────────────────────────────────

export function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loginFromCallback } = useAuth();

  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Once-flag making the callback effect idempotent under React StrictMode,
  // which double-invokes the mount effect (mount → cleanup → mount) in dev.
  // Without this, the token would be processed twice: a double GitHub API
  // round-trip, and a redirect bug where the second fire reads REDIRECT_KEY
  // *after* the first fire removed it, collapsing the destination to '/'.
  // The flag is set synchronously before any async work; the cleanup must
  // NOT reset it, otherwise the second mount reprocesses the token.
  const processedRef = useRef(false);

  useEffect(() => {
    if (processedRef.current) {
      return;
    }
    processedRef.current = true;

    const token = searchParams.get('token');
    const error = searchParams.get('error');

    // Clean the token/error from the URL immediately (R5)
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname + window.location.search}#/auth/callback`,
    );

    if (token) {
      handleToken(token);
    } else if (error) {
      setStatus('error');
      setErrorMessage(ERROR_MESSAGES[error] ?? `Authentication error: ${error}`);
    } else {
      // No token, no error — redirect to login
      navigate('/login', { replace: true });
    }

    async function handleToken(accessToken: string) {
      try {
        // Validate token + save credentials via AuthProvider.
        // loginFromCallback internally validates against the GitHub API
        // (fetchGitHubUser), so no separate validation round-trip is needed.
        const success = await loginFromCallback(accessToken);

        if (success) {
          // Redirect to the original destination or /
          const redirectTo = sessionStorage.getItem(REDIRECT_KEY) || '/';
          sessionStorage.removeItem(REDIRECT_KEY);
          navigate(redirectTo, { replace: true });
        } else {
          setStatus('error');
          setErrorMessage('Invalid or expired token. Please try again.');
        }
      } catch {
        setStatus('error');
        setErrorMessage('Invalid or expired token. Please try again.');
      }
    }
    // Deps below are listed to satisfy exhaustive-deps, but the `processedRef`
    // once-flag guarantees the effect processes the callback EXACTLY ONCE — it
    // does NOT react to `searchParams` changes by design (a callback page is
    // single-use: it consumes the token/error on mount and never re-runs).
  }, [loginFromCallback, navigate, searchParams]);

  // ─── Loading State ────────────────────────────────────────────

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-bg px-4">
        <div className="w-full max-w-md text-center">
          <div className="mb-4 text-6xl" role="img" aria-label="GHAGGA bird">
            🐦
          </div>
          <div className="flex items-center justify-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
            <p className="text-lg text-text-secondary">Signing you in...</p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Error State ──────────────────────────────────────────────

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-bg px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mb-4 text-6xl" role="img" aria-label="GHAGGA bird">
            🐦
          </div>
          <h1 className="text-3xl font-bold text-text-primary">GHAGGA</h1>
        </div>

        <div className="rounded-lg border border-surface-border bg-surface-card p-6">
          <div className="mb-4 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {errorMessage}
          </div>

          <div className="space-y-3">
            <Link to="/login" className="btn-primary flex w-full items-center justify-center gap-2">
              Try Again
            </Link>

            <Link
              to="/login"
              state={{ showPat: true }}
              className="block w-full text-center text-xs text-text-muted hover:text-primary-400 transition"
            >
              Use a Personal Access Token instead
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
