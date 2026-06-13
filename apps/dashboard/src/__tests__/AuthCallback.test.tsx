/**
 * Tests for AuthCallback page component.
 *
 * Tests token extraction, validation, URL cleanup, error handling,
 * and redirect-after-login behavior.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIRECT_KEY } from '../lib/auth';
import { AuthCallback } from '../pages/AuthCallback';

// ─── Mocks ──────────────────────────────────────────────────────

const mockFetchGitHubUser = vi.fn();
const mockLoginFromCallback = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/lib/oauth', () => ({
  fetchGitHubUser: (...args: unknown[]) => mockFetchGitHubUser(...args),
  API_URL: 'https://api.javierzader.com',
}));

vi.mock('@/lib/auth', () => ({
  REDIRECT_KEY: 'ghagga_redirect_after_login',
  useAuth: () => ({
    loginFromCallback: mockLoginFromCallback,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ─── Helpers ────────────────────────────────────────────────────

const mockReplaceState = vi.fn();

function renderWithRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/" element={<div>Dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Renders the callback under <StrictMode> so React double-invokes the
 * mount effect (mount → cleanup → mount) in dev/test, replicating the
 * production dev behaviour that exposes the AuthCallback double-fire.
 */
function renderWithRouteStrict(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/login" element={<div>Login Page</div>} />
          <Route path="/" element={<div>Dashboard</div>} />
          <Route path="/settings" element={<div>Settings</div>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('history', {
    ...window.history,
    replaceState: mockReplaceState,
  });
  // Clear sessionStorage
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════
// AuthCallback — Token Handling
// ═══════════════════════════════════════════════════════════════════

describe('AuthCallback — token handling', () => {
  it('validates token, saves credentials, and redirects to / (S-R4.1)', async () => {
    mockLoginFromCallback.mockResolvedValueOnce(true);

    renderWithRoute('/auth/callback?token=gho_abc123');

    // Should show loading state
    expect(screen.getByText('Signing you in...')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockLoginFromCallback).toHaveBeenCalledWith('gho_abc123');
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });

    // Validation is delegated to loginFromCallback (which calls the GitHub
    // API internally). AuthCallback must NOT do a redundant direct
    // fetchGitHubUser round-trip (DSH-A6: single validation per login).
    expect(mockFetchGitHubUser).not.toHaveBeenCalled();
    // The component must delegate validation EXACTLY ONCE — the contract of
    // the DSH-A6 fix is a single validation per login, not two.
    expect(mockLoginFromCallback).toHaveBeenCalledTimes(1);
  });

  it('shows error when token is invalid (loginFromCallback returns false) (S-R4.2)', async () => {
    // An invalid/expired token surfaces as loginFromCallback resolving to
    // false (it swallows the GitHub API rejection internally). AuthCallback
    // no longer pre-validates the token itself (DSH-A6).
    mockLoginFromCallback.mockResolvedValueOnce(false);

    renderWithRoute('/auth/callback?token=invalid_token');

    await waitFor(() => {
      expect(screen.getByText(/Invalid or expired token/)).toBeInTheDocument();
    });

    // Should show retry button
    expect(screen.getByText('Try Again')).toBeInTheDocument();
    // Should show PAT fallback link
    expect(screen.getByText('Use a Personal Access Token instead')).toBeInTheDocument();
    // No direct validation round-trip from the component.
    expect(mockFetchGitHubUser).not.toHaveBeenCalled();
  });

  it('shows error when loginFromCallback throws (S-R4.2)', async () => {
    // Defensive: if loginFromCallback unexpectedly throws, the try/catch
    // still surfaces a friendly error instead of a blank screen.
    mockLoginFromCallback.mockRejectedValueOnce(new Error('boom'));

    renderWithRoute('/auth/callback?token=gho_bad');

    await waitFor(() => {
      expect(screen.getByText(/Invalid or expired token/)).toBeInTheDocument();
    });
  });

  it('redirects to stored destination after login (S-R4.5)', async () => {
    sessionStorage.setItem(REDIRECT_KEY, '/settings');
    mockLoginFromCallback.mockResolvedValueOnce(true);

    renderWithRoute('/auth/callback?token=gho_abc123');

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings', { replace: true });
    });

    // Should clear the stored destination
    expect(sessionStorage.getItem(REDIRECT_KEY)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// AuthCallback — Error Param Handling
// ═══════════════════════════════════════════════════════════════════

describe('AuthCallback — error params', () => {
  it('shows descriptive message for state_expired (S-R4.3)', async () => {
    renderWithRoute('/auth/callback?error=state_expired');

    await waitFor(() => {
      expect(screen.getByText(/login session expired/)).toBeInTheDocument();
    });

    expect(screen.getByText('Try Again')).toBeInTheDocument();
  });

  it('shows descriptive message for access_denied (S-CC2.1)', async () => {
    renderWithRoute('/auth/callback?error=access_denied');

    await waitFor(() => {
      expect(screen.getByText(/cancelled the authorization/)).toBeInTheDocument();
    });
  });

  it('shows descriptive message for exchange_failed', async () => {
    renderWithRoute('/auth/callback?error=exchange_failed');

    await waitFor(() => {
      expect(screen.getByText(/Could not complete authentication/)).toBeInTheDocument();
    });
  });

  it('shows descriptive message for github_unavailable (S-CC2.2)', async () => {
    renderWithRoute('/auth/callback?error=github_unavailable');

    await waitFor(() => {
      expect(screen.getByText(/GitHub is not available/)).toBeInTheDocument();
    });
  });

  it('shows descriptive message for server_error (S-CC2.3)', async () => {
    renderWithRoute('/auth/callback?error=server_error');

    await waitFor(() => {
      expect(screen.getByText(/Server error/)).toBeInTheDocument();
    });
  });

  it('shows generic message for unknown error codes', async () => {
    renderWithRoute('/auth/callback?error=something_weird');

    await waitFor(() => {
      expect(screen.getByText(/Authentication error: something_weird/)).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// AuthCallback — No Params
// ═══════════════════════════════════════════════════════════════════

describe('AuthCallback — no params', () => {
  it('redirects to /login when no token or error param (S-R4.4)', async () => {
    renderWithRoute('/auth/callback');

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// AuthCallback — URL Cleanup
// ═══════════════════════════════════════════════════════════════════

describe('AuthCallback — URL cleanup', () => {
  it('calls history.replaceState to clean token from URL (S-R5.1)', async () => {
    mockLoginFromCallback.mockResolvedValueOnce(true);

    renderWithRoute('/auth/callback?token=gho_abc123');

    // replaceState should be called before the async validation completes
    expect(mockReplaceState).toHaveBeenCalledTimes(1);
    expect(mockReplaceState).toHaveBeenCalledWith(
      null,
      '',
      expect.stringContaining('#/auth/callback'),
    );
  });

  it('calls history.replaceState to clean error from URL (S-R5.2)', async () => {
    renderWithRoute('/auth/callback?error=state_expired');

    expect(mockReplaceState).toHaveBeenCalledTimes(1);
    expect(mockReplaceState).toHaveBeenCalledWith(
      null,
      '',
      expect.stringContaining('#/auth/callback'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// AuthCallback — StrictMode idempotency (DSH-A7 / DSH-A8)
// ═══════════════════════════════════════════════════════════════════
//
// Under <StrictMode> React double-invokes the mount effect (mount →
// cleanup → mount) in dev/test. The callback effect must be idempotent:
// the token must be processed EXACTLY ONCE per mount, otherwise:
//   1. loginFromCallback hits the GitHub API twice (double round-trip);
//   2. the second fire reads REDIRECT_KEY *after* the first fire already
//      removed it, so the destination collapses to '/' (losing e.g.
//      '/settings').

describe('AuthCallback — StrictMode idempotency (DSH-A7/A8)', () => {
  it('processes the token EXACTLY ONCE under StrictMode double-invoke', async () => {
    // Both fires would resolve true if the effect ran twice; the guard
    // must ensure only the first fire ever reaches loginFromCallback.
    mockLoginFromCallback.mockResolvedValue(true);

    renderWithRouteStrict('/auth/callback?token=gho_abc123');

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });

    // The contract: a single validation per login even when StrictMode
    // double-invokes the mount effect. Without the guard this is 2.
    expect(mockLoginFromCallback).toHaveBeenCalledTimes(1);
    // The URL cleanup (replaceState) must also fire EXACTLY ONCE — without the
    // guard the second StrictMode mount would re-run the cleanup, double-firing
    // replaceState. This is the same idempotency contract, observed on R5.
    expect(mockReplaceState).toHaveBeenCalledTimes(1);
  });

  it('shows error EXACTLY ONCE under StrictMode when loginFromCallback returns false', async () => {
    // The guard must protect the ERROR path too, not just the happy path:
    // an invalid token (loginFromCallback → false) must surface the error
    // exactly once. Without the guard, the StrictMode double-invoke runs the
    // effect twice → loginFromCallback called twice → setStatus/setErrorMessage
    // fire twice (redundant GitHub round-trip + duplicated error handling).
    mockLoginFromCallback.mockResolvedValue(false);

    renderWithRouteStrict('/auth/callback?token=invalid_token');

    await waitFor(() => {
      expect(screen.getByText(/Invalid or expired token/)).toBeInTheDocument();
    });

    // The error path is processed once: a single validation attempt even
    // though StrictMode double-invokes the mount effect. Without the guard
    // this is 2.
    expect(mockLoginFromCallback).toHaveBeenCalledTimes(1);
    // Single URL cleanup as well — the cleanup runs before the async branch,
    // so a double-invoke would double-fire it without the guard.
    expect(mockReplaceState).toHaveBeenCalledTimes(1);
  });

  it('shows error EXACTLY ONCE under StrictMode when loginFromCallback throws', async () => {
    // Same idempotency contract on the throw path: the try/catch surfaces the
    // friendly error, and the guard ensures it happens once despite the
    // StrictMode double-invoke (no double round-trip / double error handling).
    mockLoginFromCallback.mockRejectedValue(new Error('boom'));

    renderWithRouteStrict('/auth/callback?token=gho_bad');

    await waitFor(() => {
      expect(screen.getByText(/Invalid or expired token/)).toBeInTheDocument();
    });

    expect(mockLoginFromCallback).toHaveBeenCalledTimes(1);
    expect(mockReplaceState).toHaveBeenCalledTimes(1);
  });

  it('preserves the stored redirect destination under StrictMode (no collapse to /)', async () => {
    sessionStorage.setItem(REDIRECT_KEY, '/settings');
    mockLoginFromCallback.mockResolvedValue(true);

    renderWithRouteStrict('/auth/callback?token=gho_abc123');

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings', { replace: true });
    });

    // The destination must NOT collapse to '/'. Without the guard, the
    // first fire removes REDIRECT_KEY and the second fire navigates to '/'.
    expect(mockNavigate).not.toHaveBeenCalledWith('/', { replace: true });
    expect(sessionStorage.getItem(REDIRECT_KEY)).toBeNull();
  });
});
