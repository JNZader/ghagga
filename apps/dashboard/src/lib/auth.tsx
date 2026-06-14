import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { API_URL, fetchGitHubUser, type GitHubUser } from './oauth';
import { consumeSessionExpired, SESSION_EXPIRED_EVENT } from './session-expired';
import type { User } from './types';

// ─── Types ──────────────────────────────────────────────────────

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  /** Login with token obtained from the Web Flow callback */
  loginFromCallback: (token: string) => Promise<boolean>;

  /** Login with a manually entered Personal Access Token (fallback) */
  loginWithToken: (token: string) => Promise<void>;

  /** Log out and clear credentials */
  logout: () => void;

  /**
   * Re-authenticate by redirecting to the server's /auth/login endpoint.
   * Clears current credentials and initiates a new Web Flow login.
   */
  reAuthenticate: () => void;

  /** Error message if login failed */
  error: string | null;
}

// ─── Constants ──────────────────────────────────────────────────

const TOKEN_KEY = 'ghagga_token';
const USER_KEY = 'ghagga_user';
/** sessionStorage key for redirect-after-login destination */
export const REDIRECT_KEY = 'ghagga_redirect_after_login';

/**
 * Sanitize a redirect-after-login destination read from sessionStorage.
 *
 * REDIRECT_KEY is attacker-controllable (plain sessionStorage), so its value
 * must never be navigated to verbatim. Only honor in-app, single-leading-slash
 * paths. Reject:
 *   - anything not starting with '/'        → 'https://evil.com', 'evil.com'
 *   - protocol-relative '//...'             → '//evil.com' (off-site)
 *   - backslash-escaped '/\...'             → browsers normalize '\' to '/'
 *   - control-char bypass '/\n/evil.com'    → browsers strip \t \n \r per the
 *     WHATWG URL spec, collapsing '/\n/evil.com' → '//evil.com' (off-site).
 *     We must strip the same chars BEFORE validating, or the second-slash
 *     check below is trivially bypassed.
 * Returns the safe path, or '/' as the default for anything unsafe/empty.
 */
export function safeInternalPath(path: string | null | undefined): string {
  if (!path) return '/';
  // Strip the control chars the browser silently removes from URLs (the WHATWG
  // URL parser drops \t \n \r). We strip all of C0 (\x00-\x1F) + DEL (\x7F) to
  // be safe, then validate the CLEANED string — otherwise '/\n/evil.com' slips
  // past the second-slash guard and the browser later collapses it to
  // '//evil.com' (a protocol-relative, off-site URL).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping these is the whole point
  const cleaned = path.replace(/[\x00-\x1F\x7F]/g, '');
  // '//evil.com' (protocol-relative) and '/\evil.com' (browser-normalized to
  // '//') both escape the origin — reject any second leading slash/backslash.
  if (!cleaned || cleaned[0] !== '/' || cleaned[1] === '/' || cleaned[1] === '\\') return '/';
  return cleaned;
}

// ─── Context ────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null);

// ─── Provider ───────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) {
      try {
        return JSON.parse(stored) as User;
      } catch {
        return null;
      }
    }
    return null;
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validate stored token on mount
  useEffect(() => {
    if (token && !user) {
      setIsLoading(true);
      fetchGitHubUser(token)
        .then((githubUser: GitHubUser) => {
          const appUser: User = {
            githubLogin: githubUser.login,
            githubUserId: githubUser.id,
            avatarUrl: githubUser.avatar_url,
          };
          setUser(appUser);
          localStorage.setItem(USER_KEY, JSON.stringify(appUser));
        })
        .catch(() => {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          setToken(null);
          setUser(null);
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [token, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear auth state when the API layer reports an expired session (401).
  // api.ts is not a React module, so it signals via a window event; clearing
  // React state here makes ProtectedRoute redirect naturally and prevents
  // Login from bouncing a stale "authenticated" user back into the app.
  useEffect(() => {
    const handleSessionExpired = () => {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setToken(null);
      setUser(null);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    // Drain any 401 that fired before this listener was registered (cold-boot
    // race). The sticky flag in session-expired.ts ensures the signal is not lost.
    if (consumeSessionExpired()) {
      handleSessionExpired();
    }
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, []);

  // ── Web Flow Callback Login ─────────────────────────────────

  const loginFromCallback = useCallback(async (newToken: string): Promise<boolean> => {
    setError(null);
    setIsLoading(true);

    try {
      const githubUser = await fetchGitHubUser(newToken);

      const appUser: User = {
        githubLogin: githubUser.login,
        githubUserId: githubUser.id,
        avatarUrl: githubUser.avatar_url,
      };

      localStorage.setItem(TOKEN_KEY, newToken);
      localStorage.setItem(USER_KEY, JSON.stringify(appUser));
      setToken(newToken);
      setUser(appUser);
      return true;
    } catch {
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── PAT Login (fallback when no backend) ─────────────────────

  const loginWithToken = useCallback(async (newToken: string) => {
    setError(null);
    setIsLoading(true);

    try {
      const githubUser = await fetchGitHubUser(newToken);

      const appUser: User = {
        githubLogin: githubUser.login,
        githubUserId: githubUser.id,
        avatarUrl: githubUser.avatar_url,
      };

      localStorage.setItem(TOKEN_KEY, newToken);
      localStorage.setItem(USER_KEY, JSON.stringify(appUser));
      setToken(newToken);
      setUser(appUser);
    } catch {
      setError('Invalid token. Make sure it has not expired.');
      throw new Error('Invalid token');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(REDIRECT_KEY);
    setToken(null);
    setUser(null);
    setError(null);
  }, []);

  /**
   * Re-authenticate: clear credentials and redirect to /auth/login.
   * Used when a scope upgrade is needed (e.g. public_repo for runner creation).
   */
  const reAuthenticate = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    // Redirect to server's OAuth login endpoint
    window.location.href = `${API_URL}/auth/login`;
  }, []);

  const value: AuthContextType = {
    user,
    token,
    isAuthenticated: !!user && !!token,
    isLoading,
    loginFromCallback,
    loginWithToken,
    logout,
    reAuthenticate,
    error,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hooks & Guards ─────────────────────────────────────────────

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // Store the intended destination before redirecting to login
    sessionStorage.setItem(REDIRECT_KEY, location.pathname);
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
