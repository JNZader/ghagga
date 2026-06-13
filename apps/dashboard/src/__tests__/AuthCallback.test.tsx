/**
 * Tests for AuthCallback page component.
 *
 * Tests token extraction, validation, URL cleanup, error handling,
 * and redirect-after-login behavior.
 */

import { render, screen, waitFor } from '@testing-library/react';
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
