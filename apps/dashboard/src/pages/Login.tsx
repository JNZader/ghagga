import { type FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { REDIRECT_KEY, useAuth } from '@/lib/auth';
import { API_URL, isServerAvailable } from '@/lib/oauth';

export function Login() {
  const { isAuthenticated, loginWithToken, error } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';

  // If navigated from AuthCallback with showPat flag, start with PAT form
  const showPatFromState = (location.state as { showPat?: boolean })?.showPat === true;

  // Check if the user was redirected here due to an expired session
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('expired') === '1') {
      setSessionExpired(true);
      // Clean the URL parameter so it doesn't persist on refresh
      navigate('/login', { replace: true });
    }
  }, [location.search, navigate]);

  // Server availability (determines which login method to show)
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [showPatFallback, setShowPatFallback] = useState(showPatFromState);
  const [patInput, setPatInput] = useState('');
  const [patValidating, setPatValidating] = useState(false);

  // Check server availability on mount
  useEffect(() => {
    isServerAvailable().then(setServerOnline);
  }, []);

  // Redirect when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, from, navigate]);

  // Web Flow: redirect to server's /auth/login
  const handleWebFlowLogin = () => {
    // Store the intended destination before leaving
    sessionStorage.setItem(REDIRECT_KEY, from);
    window.location.href = `${API_URL}/auth/login`;
  };

  // PAT login handler
  const handlePatLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) return;

    setPatValidating(true);
    try {
      await loginWithToken(patInput.trim());
      navigate(from, { replace: true });
    } catch {
      // Error is set in auth context
    } finally {
      setPatValidating(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-bg px-4">
      <div className="w-full max-w-md">
        {/* Branding */}
        <div className="mb-8 text-center">
          <div className="mb-4 text-6xl" role="img" aria-label="GHAGGA bird">
            🐦
          </div>
          <h1 className="text-3xl font-bold text-text-primary">GHAGGA</h1>
          <p className="mt-2 text-text-secondary">Multi-agent AI Code Review</p>
        </div>

        {/* Login Card */}
        <div className="rounded-lg border border-surface-border bg-surface-card p-6">
          {/* ─── Session Expired Banner ──────────────────────── */}
          {sessionExpired && (
            <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
              Your session has expired. Please log in again.
            </div>
          )}

          {/* ─── Main Login (Web Flow or PAT when server offline) ─ */}
          {!showPatFallback && (
            <>
              <h2 className="mb-4 text-lg font-semibold text-text-primary">Sign in with GitHub</h2>
              <p className="mb-6 text-sm text-text-secondary">
                {serverOnline
                  ? 'Authenticate with your GitHub account — no passwords needed.'
                  : 'Enter your GitHub Personal Access Token to get started.'}
              </p>

              {error && (
                <div className="mb-4 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  {error}
                </div>
              )}

              {/* Web Flow button (when server is available) */}
              {serverOnline && (
                <button
                  type="button"
                  onClick={handleWebFlowLogin}
                  className="btn-primary flex w-full items-center justify-center gap-2"
                >
                  <GitHubIcon />
                  Sign in with GitHub
                </button>
              )}

              {/* Direct PAT form (when server is NOT available) */}
              {serverOnline === false && (
                <PatForm
                  value={patInput}
                  onChange={setPatInput}
                  onSubmit={handlePatLogin}
                  isValidating={patValidating}
                />
              )}

              {/* Loading server check */}
              {serverOnline === null && (
                <div className="flex items-center justify-center gap-2 py-4">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
                  <span className="text-sm text-text-secondary">Checking server...</span>
                </div>
              )}

              <p className="mt-4 text-center text-xs text-text-muted">
                Free — uses GitHub Models for AI-powered code review.
              </p>

              {/* Toggle between methods */}
              {serverOnline && (
                <button
                  type="button"
                  onClick={() => setShowPatFallback(true)}
                  className="mt-3 block w-full text-center text-xs text-text-muted hover:text-primary-400 transition"
                >
                  Or enter a Personal Access Token
                </button>
              )}
              {serverOnline === false && (
                <button
                  type="button"
                  onClick={() => isServerAvailable().then(setServerOnline)}
                  className="mt-3 block w-full text-center text-xs text-text-muted hover:text-primary-400 transition"
                >
                  Retry server connection
                </button>
              )}
            </>
          )}

          {/* ─── PAT Fallback Form ────────────────────────────── */}
          {showPatFallback && (
            <>
              <h2 className="mb-4 text-lg font-semibold text-text-primary">
                Enter Personal Access Token
              </h2>
              <p className="mb-6 text-sm text-text-secondary">
                Create a token at{' '}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-400 hover:text-primary-300"
                >
                  github.com/settings/tokens
                </a>
                . No special scopes needed.
              </p>

              {error && (
                <div className="mb-4 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  {error}
                </div>
              )}

              <PatForm
                value={patInput}
                onChange={setPatInput}
                onSubmit={handlePatLogin}
                isValidating={patValidating}
              />

              <button
                type="button"
                onClick={() => setShowPatFallback(false)}
                className="mt-3 block w-full text-center text-xs text-text-muted hover:text-primary-400 transition"
              >
                Back to GitHub login
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────────

function GitHubIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function PatForm({
  value,
  onChange,
  onSubmit,
  isValidating,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  isValidating: boolean;
}) {
  return (
    <form onSubmit={onSubmit}>
      <div className="mb-4">
        <label htmlFor="token" className="mb-2 block text-sm font-medium text-text-primary">
          Personal Access Token
        </label>
        <input
          id="token"
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
          className="input-field"
          required
        />
      </div>

      <button
        type="submit"
        disabled={isValidating || !value.trim()}
        className="btn-primary flex w-full items-center justify-center gap-2"
      >
        {isValidating ? (
          <>
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Validating...
          </>
        ) : (
          <>
            <GitHubIcon />
            Connect with GitHub
          </>
        )}
      </button>

      <p className="mt-4 text-center text-xs text-text-muted">
        Your token is stored locally and never shared.
      </p>
    </form>
  );
}
