/**
 * Tests for the AuthProvider — Web Flow edition.
 *
 * Tests loginFromCallback, reAuthenticate (redirect), logout,
 * and basic useAuth behavior.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRepositories } from './api';
import { AuthProvider, useAuth } from './auth';
import {
  consumeSessionExpired,
  notifySessionExpired,
  SESSION_EXPIRED_EVENT,
} from './session-expired';

// ─── Mock oauth module ──────────────────────────────────────────

const mockFetchGitHubUser = vi.fn();

vi.mock('./oauth', () => ({
  fetchGitHubUser: (...args: unknown[]) => mockFetchGitHubUser(...args),
  API_URL: 'https://api.javierzader.com',
}));

// ─── localStorage mock ──────────────────────────────────────────

const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
};

// ─── sessionStorage mock ────────────────────────────────────────

const sessionStore: Record<string, string> = {};
const mockSessionStorage = {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    sessionStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete sessionStore[key];
  }),
};

// ─── window.location mock ───────────────────────────────────────

let locationHref = '';

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Drain any latched session-expired signal so the sticky module-level flag
  // from a prior test does not bleed into the next AuthProvider mount.
  consumeSessionExpired();
  // Clear stores
  for (const key of Object.keys(store)) delete store[key];
  for (const key of Object.keys(sessionStore)) delete sessionStore[key];

  vi.stubGlobal('localStorage', mockLocalStorage);
  vi.stubGlobal('sessionStorage', mockSessionStorage);

  // Mock window.location.href as a writable property
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

// ─── Wrapper ────────────────────────────────────────────────────

function createAuthWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    );
  };
}

// ═══════════════════════════════════════════════════════════════════
// useAuth — basic
// ═══════════════════════════════════════════════════════════════════

describe('useAuth', () => {
  it('throws when used outside AuthProvider', () => {
    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');
  });

  it('starts with isAuthenticated: false when no stored credentials', () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.token).toBeNull();
  });

  it('restores user and token from localStorage on mount', () => {
    store.ghagga_token = 'existing-token';
    store.ghagga_user = JSON.stringify({
      githubLogin: 'testuser',
      githubUserId: 1,
      avatarUrl: 'https://avatars.example.com/1',
    });

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.githubLogin).toBe('testuser');
    expect(result.current.token).toBe('existing-token');
  });
});

// ═══════════════════════════════════════════════════════════════════
// loginFromCallback
// ═══════════════════════════════════════════════════════════════════

describe('loginFromCallback', () => {
  it('saves credentials and returns true on valid token', async () => {
    mockFetchGitHubUser.mockResolvedValueOnce({
      login: 'newuser',
      id: 42,
      avatar_url: 'https://avatars.example.com/42',
    });

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.loginFromCallback('gho_valid_token');
    });

    expect(success).toBe(true);
    expect(mockFetchGitHubUser).toHaveBeenCalledWith('gho_valid_token');
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('ghagga_token', 'gho_valid_token');
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'ghagga_user',
      expect.stringContaining('"githubLogin":"newuser"'),
    );
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.githubLogin).toBe('newuser');
  });

  it('returns false and does NOT save on invalid token', async () => {
    mockFetchGitHubUser.mockRejectedValueOnce(new Error('Invalid or expired token'));

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.loginFromCallback('bad_token');
    });

    expect(success).toBe(false);
    expect(mockLocalStorage.setItem).not.toHaveBeenCalledWith('ghagga_token', expect.anything());
    expect(result.current.isAuthenticated).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// reAuthenticate
// ═══════════════════════════════════════════════════════════════════

describe('reAuthenticate', () => {
  it('clears stored credentials', () => {
    // Pre-populate credentials
    store.ghagga_token = 'old-token';
    store.ghagga_user = JSON.stringify({
      githubLogin: 'testuser',
      githubUserId: 1,
      avatarUrl: '',
    });

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    act(() => {
      result.current.reAuthenticate();
    });

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_token');
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_user');
  });

  it('redirects to server /auth/login', () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    act(() => {
      result.current.reAuthenticate();
    });

    expect(locationHref).toBe('https://api.javierzader.com/auth/login');
  });
});

// ═══════════════════════════════════════════════════════════════════
// session expiry (401 → SESSION_EXPIRED_EVENT)
// ═══════════════════════════════════════════════════════════════════

describe('session expiry', () => {
  it('clears auth state when SESSION_EXPIRED_EVENT is dispatched', () => {
    store.ghagga_token = 'stale-token';
    store.ghagga_user = JSON.stringify({
      githubLogin: 'testuser',
      githubUserId: 1,
      avatarUrl: '',
    });

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    expect(result.current.isAuthenticated).toBe(true);

    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_token');
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_user');
  });

  it('drains a 401 that fired BEFORE the provider mounted (cold-boot race)', () => {
    store.ghagga_token = 'stale-token';
    store.ghagga_user = JSON.stringify({
      githubLogin: 'testuser',
      githubUserId: 1,
      avatarUrl: '',
    });

    // 401 fires (latches the sticky flag) BEFORE AuthProvider renders — the
    // live event listener does not exist yet, so without the sticky flag this
    // signal would be lost and auth state would stay stale.
    notifySessionExpired();

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    // The mount effect drains the latched signal → auth state ends cleared.
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_token');
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_user');
  });

  it('clears auth state when fetchApi receives a 401, breaking the redirect loop', async () => {
    store.ghagga_token = 'stale-token';
    store.ghagga_user = JSON.stringify({
      githubLogin: 'testuser',
      githubUserId: 1,
      avatarUrl: '',
    });

    // Writable location so the global 401 handler can set the hash redirect
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/', search: '', hash: '#/dashboard', hostname: 'localhost' },
      writable: true,
      configurable: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <MemoryRouter>
          <AuthProvider>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
          </AuthProvider>
        </MemoryRouter>
      );
    }

    const { result } = renderHook(() => ({ auth: useAuth(), repos: useRepositories() }), {
      wrapper: Wrapper,
    });

    // Starts "authenticated" with stale credentials
    expect(result.current.auth.isAuthenticated).toBe(true);

    await waitFor(() => expect(result.current.repos.isError).toBe(true));

    // Auth state cleared → ProtectedRoute redirects and Login no longer
    // sees isAuthenticated === true (no bounce back to "/")
    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(false));
    expect(result.current.auth.token).toBeNull();
    expect(result.current.auth.user).toBeNull();

    // The redirect target still carries the expired banner param
    expect(window.location.hash).toBe('#/login?expired=1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// logout
// ═══════════════════════════════════════════════════════════════════

describe('logout', () => {
  it('clears localStorage and sessionStorage', () => {
    store.ghagga_token = 'some-token';
    store.ghagga_user = JSON.stringify({ githubLogin: 'user', githubUserId: 1, avatarUrl: '' });
    sessionStore.ghagga_redirect_after_login = '/settings';

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    act(() => {
      result.current.logout();
    });

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_token');
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_user');
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('ghagga_redirect_after_login');
  });

  it('sets user to null and isAuthenticated to false', () => {
    store.ghagga_token = 'some-token';
    store.ghagga_user = JSON.stringify({ githubLogin: 'user', githubUserId: 1, avatarUrl: '' });

    const { result } = renderHook(() => useAuth(), {
      wrapper: createAuthWrapper(),
    });

    // Should start authenticated
    expect(result.current.isAuthenticated).toBe(true);

    act(() => {
      result.current.logout();
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.token).toBeNull();
  });
});
