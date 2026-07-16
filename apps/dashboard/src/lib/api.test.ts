/**
 * Tests for dashboard API hooks.
 *
 * Uses vi.stubGlobal('fetch') to mock network calls since the hooks
 * use fetchApi/fetchData which call the global fetch.
 */

import type { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient, createWrapper } from '../test/test-utils';
import {
  ApiError,
  useApproveIssueDraft,
  useBatchDeleteObservations,
  useBatchDeleteReviews,
  useCleanupEmptySessions,
  useClearRepoMemory,
  useDeleteObservation,
  useDeleteRepoReviews,
  useDeleteReview,
  useDeleteSession,
  useEditIssueDraft,
  useInstallationSettings,
  useInstallations,
  useIssueDrafts,
  useMemorySessions,
  useObservations,
  usePurgeAllMemory,
  useRejectIssueDraft,
  useRepositories,
  useReviews,
  useSettings,
  useStats,
  useUpdateInstallationSettings,
  useUpdateSettings,
  useValidateProvider,
} from './api';
import { REDIRECT_KEY } from './auth';
import { SESSION_EXPIRED_EVENT } from './session-expired';

// ─── Mocks ──────────────────────────────────────────────────────

const mockFetch = vi.fn();
let mockLocalStorage: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  // Set up localStorage token (required by fetchApi)
  mockLocalStorage = {
    getItem: vi.fn().mockReturnValue('ghp_test-token'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  vi.stubGlobal('localStorage', mockLocalStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ────────────────────────────────────────────────────

function mockJsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ═══════════════════════════════════════════════════════════════════
// fetchApi — Global 401 Handler
// ═══════════════════════════════════════════════════════════════════

describe('fetchApi 401 handler', () => {
  it('clears token and redirects to login on 401', async () => {
    // Simulate being on a dashboard page
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/dashboard' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Should clear both token and user from localStorage
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_token');
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('ghagga_user');

    // Should redirect to login with expired param
    expect(window.location.hash).toBe('#/login?expired=1');
  });

  it('does NOT redirect if already on login page', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/login' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Should NOT have cleared localStorage (we're already on login)
    expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();

    // Hash should remain on login (no redirect loop)
    expect(window.location.hash).toBe('#/login');
  });

  it('does NOT redirect if on auth callback page', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/auth/callback?token=abc' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Should NOT redirect
    expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/auth/callback?token=abc');
  });

  it('dispatches the session-expired event so AuthProvider clears React state', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/dashboard' },
      writable: true,
    });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: SESSION_EXPIRED_EVENT }),
    );
    dispatchSpy.mockRestore();
  });

  it('does NOT dispatch the session-expired event when already on the login page', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/login' },
      writable: true,
    });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: SESSION_EXPIRED_EVENT }),
    );
    dispatchSpy.mockRestore();
  });

  it('throws ApiError with status 401 and "Session expired" message', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/login' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as InstanceType<typeof ApiError>).status).toBe(401);
    expect(result.current.error?.message).toBe('Session expired');
  });
});

// ═══════════════════════════════════════════════════════════════════
// fetchApi 401 handler — redirect-after-login preservation (DSH-A9)
// ═══════════════════════════════════════════════════════════════════
//
// On session expiry the global 401 handler bounces the user to #/login. It
// must FIRST stash the current route in REDIRECT_KEY so a successful
// re-login lands the user back where they were — not on '/'. Today the
// handler never writes REDIRECT_KEY, so the destination is lost.

describe('fetchApi 401 handler — redirect preservation (DSH-A9)', () => {
  let mockSessionStorage: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    const store: Record<string, string> = {};
    mockSessionStorage = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    };
    vi.stubGlobal('sessionStorage', mockSessionStorage);
  });

  it('stashes the current route in REDIRECT_KEY before redirecting on 401', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/settings' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // The route was normalized (leading '#' stripped) and stored so re-login
    // returns the user to /settings instead of collapsing to '/'.
    expect(mockSessionStorage.getItem(REDIRECT_KEY)).toBe('/settings');
    // And it redirects to login as before.
    expect(window.location.hash).toBe('#/login?expired=1');
  });

  it('does NOT write REDIRECT_KEY when already on the login page', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/login' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Being on /login is not a meaningful redirect target — the handler must
    // not clobber a previously-stashed destination with '/login'.
    expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    expect(mockSessionStorage.getItem(REDIRECT_KEY)).toBeNull();
  });

  it('does NOT write REDIRECT_KEY when on the auth callback page', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/auth/callback?token=abc' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('does NOT stash a bare "/" route (nothing meaningful to preserve)', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/' },
      writable: true,
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // A redirect to '/' is the default anyway — don't overwrite a possibly
    // better stored value with '/'.
    expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    // Redirect still happens.
    expect(window.location.hash).toBe('#/login?expired=1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// useDeleteReview
// ═══════════════════════════════════════════════════════════════════

describe('useDeleteReview', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/reviews/:reviewId', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deleted: true } }));

    const { result } = renderHook(() => useDeleteReview(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ reviewId: 42 });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/reviews/42');
    expect(options.method).toBe('DELETE');
  });

  it('invalidates reviews and stats cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deleted: true } }));

    const { result } = renderHook(() => useDeleteReview(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ reviewId: 42 });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['reviews'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['stats'] });
  });

  it('reports error on API failure (404)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 }),
    );

    const { result } = renderHook(() => useDeleteReview(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ reviewId: 999 });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Issue-triage draft hooks
// ═══════════════════════════════════════════════════════════════════

describe('useIssueDrafts', () => {
  it('GETs /api/issue-drafts with the status filter and unwraps data', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: [{ id: 9, status: 'DRAFT' }] }));

    const { result } = renderHook(() => useIssueDrafts('DRAFT'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/issue-drafts?status=DRAFT');
    expect(result.current.data).toEqual([{ id: 9, status: 'DRAFT' }]);
  });
});

describe('useEditIssueDraft', () => {
  it('PATCHes the body and invalidates issue-drafts', async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { id: 9, body: 'x' } }));

    const { result } = renderHook(() => useEditIssueDraft(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 9, body: 'x' });
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/issue-drafts/9');
    expect(options.method).toBe('PATCH');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['issue-drafts'] });
  });
});

describe('useApproveIssueDraft', () => {
  it('POSTs to /approve and invalidates issue-drafts', async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { id: 9, status: 'POSTED' } }));

    const { result } = renderHook(() => useApproveIssueDraft(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 9 });
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/issue-drafts/9/approve');
    expect(options.method).toBe('POST');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['issue-drafts'] });
  });

  it('invalidates issue-drafts on FAILURE (e.g. 409 concurrent decision) so the stale row refetches (REL-002)', async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'ALREADY_DECIDED' }), { status: 409 }),
    );

    const { result } = renderHook(() => useApproveIssueDraft(), {
      wrapper: createWrapper(queryClient),
    });
    act(() => {
      result.current.mutate({ id: 9 });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The list must refetch so a draft another maintainer already decided stops
    // showing as an actionable DRAFT.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['issue-drafts'] });
  });
});

describe('useRejectIssueDraft', () => {
  it('POSTs to /reject and invalidates issue-drafts', async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { id: 9, status: 'REJECTED' } }));

    const { result } = renderHook(() => useRejectIssueDraft(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 9 });
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/issue-drafts/9/reject');
    expect(options.method).toBe('POST');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['issue-drafts'] });
  });

  it('invalidates issue-drafts on FAILURE (e.g. 409 concurrent decision) so the stale row refetches (REL-002)', async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'ALREADY_DECIDED' }), { status: 409 }),
    );

    const { result } = renderHook(() => useRejectIssueDraft(), {
      wrapper: createWrapper(queryClient),
    });
    act(() => {
      result.current.mutate({ id: 9 });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['issue-drafts'] });
  });
});

// ═══════════════════════════════════════════════════════════════════
// useBatchDeleteReviews
// ═══════════════════════════════════════════════════════════════════

describe('useBatchDeleteReviews', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/reviews/batch with JSON body', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 3 } }));

    const { result } = renderHook(() => useBatchDeleteReviews(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ ids: [10, 20, 30] });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/reviews/batch');
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body)).toEqual({ ids: [10, 20, 30] });
  });

  it('invalidates reviews and stats cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 2 } }));

    const { result } = renderHook(() => useBatchDeleteReviews(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ ids: [10, 20] });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['reviews'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['stats'] });
  });

  it('returns the response data on success', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 5 } }));

    const { result } = renderHook(() => useBatchDeleteReviews(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ ids: [1, 2, 3, 4, 5] });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ deletedCount: 5 });
  });

  it('reports error on API failure (400)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'VALIDATION_ERROR' }), { status: 400 }),
    );

    const { result } = renderHook(() => useBatchDeleteReviews(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ ids: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════════
// useBatchDeleteObservations
// ═══════════════════════════════════════════════════════════════════

describe('useBatchDeleteObservations', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/memory/observations/batch with JSON body', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 3 } }));

    const { result } = renderHook(() => useBatchDeleteObservations(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ ids: [5, 10, 15] });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/memory/observations/batch');
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body)).toEqual({ ids: [5, 10, 15] });
  });

  it('invalidates observations and sessions cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 2 } }));

    const { result } = renderHook(() => useBatchDeleteObservations(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ ids: [5, 10] });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['memory', 'observations'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['memory', 'sessions'] });
  });

  it('returns the response data on success', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 4 } }));

    const { result } = renderHook(() => useBatchDeleteObservations(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ ids: [1, 2, 3, 4] });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ deletedCount: 4 });
  });

  it('reports error on API failure (500)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'DELETE_FAILED' }), { status: 500 }),
    );

    const { result } = renderHook(() => useBatchDeleteObservations(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ ids: [1, 2, 3] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
// ═══════════════════════════════════════════════════════════════════
// useReviews
// ═══════════════════════════════════════════════════════════════════

describe('useReviews', () => {
  it('returns paginated reviews', async () => {
    const reviews = [
      {
        id: 1,
        repo: 'acme/app',
        prNumber: 42,
        status: 'PASSED',
        mode: 'simple',
        summary: 'All good',
        findings: [],
        createdAt: '2026-01-01',
      },
    ];
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        data: reviews,
        pagination: { page: 1, limit: 20, offset: 0, total: 1 },
      }),
    );

    const { result } = renderHook(() => useReviews('acme/app', 1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      reviews,
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('omits the repo param and uses the server-populated repo for "All repositories"', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        data: [
          {
            id: 1,
            repo: 'acme/app',
            prNumber: 10,
            status: 'PASSED',
            mode: 'simple',
            summary: 'ok',
            findings: [],
            createdAt: '2026-01-01',
          },
          {
            id: 2,
            repo: 'acme/api',
            prNumber: 20,
            status: 'FAILED',
            mode: 'workflow',
            summary: 'issues',
            findings: [],
            createdAt: '2026-01-02',
          },
        ],
        pagination: { page: 1, limit: 50, offset: 0, total: 2 },
      }),
    );

    const { result } = renderHook(() => useReviews(undefined, 1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // No repo param → cross-installation listing endpoint
    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain('repo=');

    // Each row carries its repo fullName, populated by the server
    expect(result.current.data?.reviews.map((r) => r.repo)).toEqual(['acme/app', 'acme/api']);
  });

  it('uses the server-provided repo verbatim — no client-side fallback or relabeling', async () => {
    // The row's repo intentionally differs from the requested filter: the
    // contract says the SERVER populates repo, so the client must never
    // overwrite or fall back to the query param.
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        data: [
          {
            id: 1,
            repo: 'acme/api',
            prNumber: 10,
            status: 'PASSED',
            mode: 'simple',
            summary: 'ok',
            findings: [],
            createdAt: '2026-01-01',
          },
        ],
        pagination: { page: 1, limit: 50, offset: 0, total: 1 },
      }),
    );

    const { result } = renderHook(() => useReviews('acme/app', 1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.reviews[0]?.repo).toBe('acme/api');
  });

  it('maps total from the server pagination, not the page row count', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        data: [
          {
            id: 1,
            repo: 'acme/app',
            prNumber: 42,
            status: 'PASSED',
            mode: 'simple',
            summary: 'All good',
            findings: [],
            createdAt: '2026-01-01',
          },
        ],
        pagination: { page: 1, limit: 50, offset: 0, total: 120 },
      }),
    );

    const { result } = renderHook(() => useReviews('acme/app', 1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // total must come from pagination.total (120), NOT data.length (1)
    expect(result.current.data?.total).toBe(120);
    expect(result.current.data?.pageSize).toBe(50);
  });

  it('passes repo filter param in URL', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: [], pagination: { page: 1, limit: 20, offset: 0, total: 0 } }),
    );

    const { result } = renderHook(() => useReviews('acme/app'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('repo=acme%2Fapp');
  });

  it('passes page param in URL', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: [], pagination: { page: 3, limit: 20, offset: 40, total: 0 } }),
    );

    const { result } = renderHook(() => useReviews(undefined, 3), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('page=3');
  });

  // ─── PRODOPS-005: forward-compatible limit/status/search options ────

  it('forwards limit, status and search as query params when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: [], pagination: { page: 1, limit: 100, offset: 0, total: 0 } }),
    );

    const { result } = renderHook(
      () => useReviews('acme/app', 1, { limit: 100, status: 'FAILED', search: 'security issue' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('limit=100');
    expect(url).toContain('status=FAILED');
    expect(url).toContain('q=security+issue');
  });

  it('omits limit/status/q params when options are not provided', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: [], pagination: { page: 1, limit: 20, offset: 0, total: 0 } }),
    );

    const { result } = renderHook(() => useReviews('acme/app', 1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain('limit=');
    expect(url).not.toContain('status=');
    expect(url).not.toContain('q=');
  });

  it('scopes the query cache by filter options so different filters never share stale data', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockJsonResponse({ data: [], pagination: { page: 1, limit: 20, offset: 0, total: 0 } }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({ data: [], pagination: { page: 1, limit: 100, offset: 0, total: 0 } }),
      );

    const wrapper = createWrapper();
    const { result: unfiltered } = renderHook(() => useReviews('acme/app', 1), { wrapper });
    await waitFor(() => expect(unfiltered.current.isSuccess).toBe(true));

    const { result: filtered } = renderHook(
      () => useReviews('acme/app', 1, { limit: 100, status: 'FAILED' }),
      { wrapper },
    );
    await waitFor(() => expect(filtered.current.isSuccess).toBe(true));

    // Two distinct fetches — the filtered query key did not hit the
    // unfiltered query's cache entry.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// useStats
// ═══════════════════════════════════════════════════════════════════

describe('useStats', () => {
  it('returns stats when repo is provided', async () => {
    const stats = {
      totalReviews: 10,
      passed: 8,
      failed: 2,
      needsHumanReview: 0,
      skipped: 0,
      passRate: 80,
      reviewsByDay: [],
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: stats }));

    const { result } = renderHook(() => useStats('acme/app'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(stats);
  });

  it('does not fetch when repo is empty string (enabled: false)', () => {
    const { result } = renderHook(() => useStats(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// useRepositories
// ═══════════════════════════════════════════════════════════════════

describe('useRepositories', () => {
  it('returns repository list', async () => {
    const repos = [{ id: 1, fullName: 'acme/app', owner: 'acme', name: 'app', isActive: true }];
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: repos }));

    const { result } = renderHook(() => useRepositories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(repos);
  });
});

// ═══════════════════════════════════════════════════════════════════
// useSettings
// ═══════════════════════════════════════════════════════════════════

describe('useSettings', () => {
  it('returns settings when repo is provided', async () => {
    const settings = {
      repoId: 1,
      repoFullName: 'acme/app',
      useGlobalSettings: true,
      aiReviewEnabled: true,
      providerChain: [],
      reviewMode: 'simple',
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: false,
      enableMemory: true,
      customRules: '',
      ignorePatterns: [],
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: settings }));

    const { result } = renderHook(() => useSettings('acme/app'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(settings);
  });

  it('does not fetch when repo is empty string (enabled: false)', () => {
    const { result } = renderHook(() => useSettings(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// useUpdateSettings
// ═══════════════════════════════════════════════════════════════════

describe('useUpdateSettings', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends PUT to /api/settings with JSON body', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { message: 'Settings updated' } }));

    const { result } = renderHook(() => useUpdateSettings(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        repoFullName: 'acme/app',
        enableSemgrep: false,
      });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/settings');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({
      repoFullName: 'acme/app',
      enableSemgrep: false,
    });
  });

  it('invalidates settings cache for the repo on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { message: 'Settings updated' } }));

    const { result } = renderHook(() => useUpdateSettings(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ repoFullName: 'acme/app' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['settings', 'acme/app'],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// useValidateProvider
// ═══════════════════════════════════════════════════════════════════

describe('useValidateProvider', () => {
  it('sends POST to /api/providers/validate with payload', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ valid: true, models: ['gpt-4o'] }));

    const { result } = renderHook(() => useValidateProvider(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({ provider: 'openai' as const, apiKey: 'sk-test' });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/providers/validate');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ provider: 'openai', apiKey: 'sk-test' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// useInstallations
// ═══════════════════════════════════════════════════════════════════

describe('useInstallations', () => {
  it('returns installation list', async () => {
    const installations = [{ id: 100, accountLogin: 'acme', accountType: 'Organization' }];
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: installations }));

    const { result } = renderHook(() => useInstallations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(installations);
  });
});

// ═══════════════════════════════════════════════════════════════════
// useInstallationSettings
// ═══════════════════════════════════════════════════════════════════

describe('useInstallationSettings', () => {
  it('returns settings when installationId is provided', async () => {
    const settings = {
      installationId: 100,
      accountLogin: 'acme',
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: false,
      enableMemory: true,
      customRules: '',
      ignorePatterns: [],
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: settings }));

    const { result } = renderHook(() => useInstallationSettings(100), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(settings);
  });

  it('does not fetch when installationId is 0 (enabled: false)', () => {
    const { result } = renderHook(() => useInstallationSettings(0), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// useUpdateInstallationSettings
// ═══════════════════════════════════════════════════════════════════

describe('useUpdateInstallationSettings', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends PUT to /api/installation-settings', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { message: 'Settings updated' } }));

    const { result } = renderHook(() => useUpdateInstallationSettings(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        installationId: 100,
        aiReviewEnabled: false,
      });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/installation-settings');
    expect(options.method).toBe('PUT');
  });

  it('invalidates both installation-settings and settings cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { message: 'Settings updated' } }));

    const { result } = renderHook(() => useUpdateInstallationSettings(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ installationId: 100 });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['installation-settings', 100],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['settings'],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// useMemorySessions
// ═══════════════════════════════════════════════════════════════════

describe('useMemorySessions', () => {
  it('returns sessions when project is provided', async () => {
    const sessions = [
      {
        id: 1,
        project: 'acme/app',
        prNumber: 42,
        summary: 'Learned patterns',
        createdAt: '2026-01-01',
        observationCount: 5,
      },
    ];
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: sessions }));

    const { result } = renderHook(() => useMemorySessions('acme/app'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sessions);
  });

  it('does not fetch when project is empty string (enabled: false)', () => {
    const { result } = renderHook(() => useMemorySessions(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// useObservations
// ═══════════════════════════════════════════════════════════════════

describe('useObservations', () => {
  it('returns observations when sessionId is provided', async () => {
    const observations = [
      {
        id: 1,
        sessionId: 1,
        type: 'pattern',
        title: 'Uses async/await',
        content: 'Prefers async',
        filePaths: ['src/index.ts'],
        createdAt: '2026-01-01',
      },
    ];
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: observations }));

    const { result } = renderHook(() => useObservations(1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(observations);
  });

  it('does not fetch when sessionId is 0 (enabled: false)', () => {
    const { result } = renderHook(() => useObservations(0), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// useDeleteObservation
// ═══════════════════════════════════════════════════════════════════

describe('useDeleteObservation', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/memory/observations/:id', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deleted: true } }));

    const { result } = renderHook(() => useDeleteObservation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ observationId: 42 });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/memory/observations/42');
    expect(options.method).toBe('DELETE');
  });

  it('invalidates observations and sessions cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deleted: true } }));

    const { result } = renderHook(() => useDeleteObservation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ observationId: 42 });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory', 'observations'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory', 'sessions'],
    });
  });

  it('reports error on API failure (404)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Observation not found' }), { status: 404 }),
    );

    const { result } = renderHook(() => useDeleteObservation(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ observationId: 999 });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════════
// useClearRepoMemory
// ═══════════════════════════════════════════════════════════════════

describe('useClearRepoMemory', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/memory/projects/:project/observations with URL-encoded project', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { cleared: 15 } }));

    const { result } = renderHook(() => useClearRepoMemory(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ project: 'acme/widgets' });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/memory/projects/acme%2Fwidgets/observations');
    expect(options.method).toBe('DELETE');
  });

  it('invalidates observations and sessions cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { cleared: 10 } }));

    const { result } = renderHook(() => useClearRepoMemory(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ project: 'acme/app' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory', 'observations'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory', 'sessions'],
    });
  });

  it('reports error on API failure (403)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    );

    const { result } = renderHook(() => useClearRepoMemory(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ project: 'secret/repo' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════════
// usePurgeAllMemory
// ═══════════════════════════════════════════════════════════════════

describe('usePurgeAllMemory', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/memory/observations', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { cleared: 50 } }));

    const { result } = renderHook(() => usePurgeAllMemory(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/memory/observations');
    // Should NOT contain a project segment or :id
    expect(url).not.toContain('/projects/');
    expect(options.method).toBe('DELETE');
  });

  it('invalidates ALL memory queries on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { cleared: 50 } }));

    const { result } = renderHook(() => usePurgeAllMemory(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory'],
    });
  });

  it('reports error on API failure (401)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const { result } = renderHook(() => usePurgeAllMemory(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════════
// useDeleteSession
// ═══════════════════════════════════════════════════════════════════

describe('useDeleteSession', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/memory/sessions/:id', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deleted: true } }));

    const { result } = renderHook(() => useDeleteSession(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ sessionId: 7 });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/memory/sessions/7');
    expect(options.method).toBe('DELETE');
  });

  it('invalidates sessions and observations cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deleted: true } }));

    const { result } = renderHook(() => useDeleteSession(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ sessionId: 7 });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory', 'sessions'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory', 'observations'],
    });
  });

  it('reports error on API failure (404)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 }),
    );

    const { result } = renderHook(() => useDeleteSession(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ sessionId: 999 });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════════
// useCleanupEmptySessions
// ═══════════════════════════════════════════════════════════════════

describe('useCleanupEmptySessions', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/memory/sessions/empty with project param', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 3 } }));

    const { result } = renderHook(() => useCleanupEmptySessions(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ project: 'acme/app' });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/memory/sessions/empty?project=acme%2Fapp');
    expect(options.method).toBe('DELETE');
  });

  it('sends DELETE without project param when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 5 } }));

    const { result } = renderHook(() => useCleanupEmptySessions(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/memory/sessions/empty');
    expect(url).not.toContain('?project');
    expect(options.method).toBe('DELETE');
  });

  it('invalidates sessions cache on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: { deletedCount: 2 } }));

    const { result } = renderHook(() => useCleanupEmptySessions(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ project: 'acme/app' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['memory', 'sessions'],
    });
  });

  it('reports error on API failure (500)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const { result } = renderHook(() => useCleanupEmptySessions(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ project: 'acme/app' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════════
// useDeleteRepoReviews
// ═══════════════════════════════════════════════════════════════════

describe('useDeleteRepoReviews', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  it('sends DELETE to /api/reviews/:repoFullName with URL-encoded name', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: { deletedReviews: 5, clearedMemory: null } }),
    );

    const { result } = renderHook(() => useDeleteRepoReviews(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ repoFullName: 'acme/widgets' });
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/reviews/acme%2Fwidgets');
    expect(url).not.toContain('includeMemory');
    expect(options.method).toBe('DELETE');
  });

  it('appends includeMemory=true when requested', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: { deletedReviews: 3, clearedMemory: 10 } }),
    );

    const { result } = renderHook(() => useDeleteRepoReviews(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ repoFullName: 'acme/widgets', includeMemory: true });
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/reviews/acme%2Fwidgets?includeMemory=true');
  });

  it('invalidates reviews and stats cache on success (without memory)', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: { deletedReviews: 5, clearedMemory: null } }),
    );

    const { result } = renderHook(() => useDeleteRepoReviews(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ repoFullName: 'acme/widgets' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['reviews'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['stats', 'acme/widgets'] });
    // Should NOT invalidate memory
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['memory'] });
  });

  it('also invalidates memory cache when includeMemory is true', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: { deletedReviews: 3, clearedMemory: 10 } }),
    );

    const { result } = renderHook(() => useDeleteRepoReviews(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ repoFullName: 'acme/widgets', includeMemory: true });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['reviews'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['stats', 'acme/widgets'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['memory'] });
  });

  it('returns the response data on success', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ data: { deletedReviews: 7, clearedMemory: null } }),
    );

    const { result } = renderHook(() => useDeleteRepoReviews(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ repoFullName: 'acme/widgets' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ deletedReviews: 7, clearedMemory: null });
  });

  it('reports error on API failure (404)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Repository not found' }), { status: 404 }),
    );

    const { result } = renderHook(() => useDeleteRepoReviews(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ repoFullName: 'unknown/repo' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('reports error on API failure (500)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'DELETE_FAILED' }), { status: 500 }),
    );

    const { result } = renderHook(() => useDeleteRepoReviews(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ repoFullName: 'acme/widgets' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
