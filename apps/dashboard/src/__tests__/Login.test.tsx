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

vi.mock('@/lib/auth', () => ({
  REDIRECT_KEY: 'ghagga_redirect_after_login',
  useAuth: () => ({
    isAuthenticated: false,
    loginWithToken: mockLoginWithToken,
    error: null,
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
