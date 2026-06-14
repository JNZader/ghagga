/**
 * Tests for Login page component.
 *
 * Tests server online/offline/checking states, Web Flow redirect button,
 * PAT fallback form, and sessionStorage redirect destination.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Login } from '../pages/Login';

// ─── Mocks ──────────────────────────────────────────────────────

const mockIsServerAvailable = vi.fn();
const mockLoginWithToken = vi.fn();
const mockNavigate = vi.fn();

let locationHref = '';

vi.mock('@/lib/oauth', () => ({
  isServerAvailable: (...args: unknown[]) => mockIsServerAvailable(...args),
  API_URL: 'https://api.javierzader.com',
}));

// Use the REAL safeInternalPath so the unified `dest` computation in Login is
// exercised end-to-end. Only useAuth is faked (per-test isAuthenticated).
let mockIsAuthenticated = false;
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    REDIRECT_KEY: 'ghagga_redirect_after_login',
    safeInternalPath: actual.safeInternalPath,
    useAuth: () => ({
      isAuthenticated: mockIsAuthenticated,
      loginWithToken: mockLoginWithToken,
      error: null,
    }),
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ─── Helpers ────────────────────────────────────────────────────

function renderLogin(initialPath = '/login') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>Dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockIsAuthenticated = false;

  // Mock window.location.href
  locationHref = '';
  Object.defineProperty(window, 'location', {
    value: {
      href: '',
      get pathname() {
        return '/';
      },
      get search() {
        return '';
      },
      get hash() {
        return '';
      },
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window.location, 'href', {
    get: () => locationHref,
    set: (val: string) => {
      locationHref = val;
    },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════
// Server online — Web Flow redirect
// ═══════════════════════════════════════════════════════════════════

describe('Login — server online', () => {
  it('shows "Sign in with GitHub" button when server is available (S-R3.1)', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(true);

    renderLogin();

    // Wait for server check to resolve
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sign in with GitHub/i })).toBeInTheDocument();
    });

    // Should NOT show PAT form elements
    expect(screen.queryByLabelText(/Personal Access Token/i)).not.toBeInTheDocument();
  });

  it('redirects to server /auth/login when button is clicked (S-R3.3)', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(true);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sign in with GitHub/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sign in with GitHub/i }));

    expect(locationHref).toBe('https://api.javierzader.com/auth/login');
  });

  it('stores redirect destination in sessionStorage before redirect', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(true);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sign in with GitHub/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sign in with GitHub/i }));

    expect(sessionStorage.getItem('ghagga_redirect_after_login')).toBe('/');
  });

  // ─── DSH-A9: do not degrade a previously-stashed destination ─────
  // When the user arrives at /login WITHOUT router state (e.g. after an
  // error/expiry redirect), `from` collapses to '/'. The Web Flow handler
  // must NOT overwrite a good REDIRECT_KEY ('/settings') with '/'.
  it('preserves an existing REDIRECT_KEY when retried without router state (DSH-A9)', async () => {
    sessionStorage.setItem('ghagga_redirect_after_login', '/settings');
    mockIsServerAvailable.mockResolvedValueOnce(true);

    // No state.from → `from` computes to '/'
    renderLogin();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sign in with GitHub/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sign in with GitHub/i }));

    // The stashed destination survives — it is NOT clobbered with '/'.
    expect(sessionStorage.getItem('ghagga_redirect_after_login')).toBe('/settings');
    // Redirect to the OAuth endpoint still happens.
    expect(locationHref).toBe('https://api.javierzader.com/auth/login');
  });

  it('shows "Or enter a Personal Access Token" toggle link', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(true);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Or enter a Personal Access Token/i)).toBeInTheDocument();
    });
  });

  it('does NOT show any Device Flow UI (no user code, no polling) (S-R3.3)', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(true);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sign in with GitHub/i })).toBeInTheDocument();
    });

    // No Device Flow elements should exist
    expect(screen.queryByText(/user code/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for authorization/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/github\.com\/login\/device/i)).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Server checking — spinner
// ═══════════════════════════════════════════════════════════════════

describe('Login — server checking', () => {
  it('shows spinner while checking server availability (S-R3.2)', () => {
    // Never resolve the server check
    mockIsServerAvailable.mockReturnValue(new Promise(() => {}));

    renderLogin();

    expect(screen.getByText('Checking server...')).toBeInTheDocument();

    // Should not show login button or PAT form yet
    expect(screen.queryByRole('button', { name: /Sign in with GitHub/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Personal Access Token/i)).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Server offline — PAT fallback
// ═══════════════════════════════════════════════════════════════════

describe('Login — server offline', () => {
  it('shows PAT form when server is unavailable (S-R7.1)', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(false);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByLabelText(/Personal Access Token/i)).toBeInTheDocument();
    });

    // Should NOT show the Web Flow button
    expect(screen.queryByRole('button', { name: /Sign in with GitHub/i })).not.toBeInTheDocument();
  });

  it('shows "Retry server connection" button when offline', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(false);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Retry server connection/i)).toBeInTheDocument();
    });
  });

  it('shows descriptive text for PAT entry', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(false);

    renderLogin();

    await waitFor(() => {
      expect(
        screen.getByText(/Enter your GitHub Personal Access Token to get started/i),
      ).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// PAT fallback toggle
// ═══════════════════════════════════════════════════════════════════

describe('Login — PAT fallback toggle', () => {
  it('shows PAT form when "Or enter a Personal Access Token" is clicked', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(true);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Or enter a Personal Access Token/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Or enter a Personal Access Token/i));

    expect(screen.getByLabelText(/Personal Access Token/i)).toBeInTheDocument();
    expect(screen.getByText(/Enter Personal Access Token/i)).toBeInTheDocument();
  });

  it('shows "Back to GitHub login" link in PAT fallback view', async () => {
    mockIsServerAvailable.mockResolvedValueOnce(true);

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText(/Or enter a Personal Access Token/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Or enter a Personal Access Token/i));

    expect(screen.getByText(/Back to GitHub login/i)).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PAT login — preserves stashed destination (DSH-A9 gap fix)
// ═══════════════════════════════════════════════════════════════════
//
// DSH-A9 only wired redirect-preservation into the Web Flow handler. The PAT
// login path used to navigate to `from` (which collapses to '/' on an
// error/expiry retry) and so LOST the stashed destination. The unified `dest`
// now makes PAT honor REDIRECT_KEY too.

describe('Login — PAT login preserves destination', () => {
  it('navigates to the stashed REDIRECT_KEY after a successful PAT login', async () => {
    // User was headed to /settings (stashed by ProtectedRoute / 401 handler),
    // then arrived at /login WITHOUT router state → `from` collapses to '/'.
    sessionStorage.setItem('ghagga_redirect_after_login', '/settings');
    // Server offline → the PAT form renders directly (no toggle needed).
    mockIsServerAvailable.mockResolvedValueOnce(false);
    mockLoginWithToken.mockResolvedValueOnce(undefined);

    renderLogin();

    const input = await screen.findByLabelText(/Personal Access Token/i);
    fireEvent.change(input, { target: { value: 'ghp_validtoken' } });
    fireEvent.click(screen.getByRole('button', { name: /Connect with GitHub/i }));

    await waitFor(() => {
      expect(mockLoginWithToken).toHaveBeenCalledWith('ghp_validtoken');
    });
    // PAT login returns the user to the stashed destination, NOT '/'.
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings', { replace: true });
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/', { replace: true });
  });
});
