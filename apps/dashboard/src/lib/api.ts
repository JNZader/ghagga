import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Installation,
  InstallationSettings,
  MemorySession,
  Observation,
  Repository,
  RepositorySettings,
  Review,
  ReviewsResponse,
  SaaSProvider,
  Stats,
  ValidationResponse,
  WorkflowInstallResult,
  WorkflowStatus,
} from './types';
import { notifySessionExpired } from './session-expired';

const API_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://api.javierzader.com');

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('ghagga_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    // ── Global 401 handler: clear auth state and redirect to login ──
    if (response.status === 401) {
      const currentPath = window.location.hash;
      if (!currentPath.includes('/login') && !currentPath.includes('/auth/callback')) {
        localStorage.removeItem('ghagga_token');
        localStorage.removeItem('ghagga_user');
        // Clear the in-memory auth state too (AuthProvider listens for this
        // event). Without it, React still considers the user authenticated,
        // Login bounces back to "/", queries refetch, 401 again → loop.
        notifySessionExpired();
        window.location.hash = '#/login?expired=1';
      }
      throw new ApiError(401, 'Session expired');
    }

    let message = 'Request failed';
    try {
      const body = await response.text();
      // Try to parse JSON error response and extract the error field
      const parsed = JSON.parse(body);
      message = parsed.error ?? parsed.message ?? body;
    } catch {
      // If parsing fails, keep the default message
    }
    throw new ApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

/**
 * Unwrap server responses that use `{ data: T }` envelope.
 * All GET endpoints return `{ data: ... }` for consistency.
 */
async function fetchData<T>(path: string, options?: RequestInit): Promise<T> {
  const result = await fetchApi<{ data: T }>(path, options);
  return result.data;
}

// ─── Reviews ──────────────────────────────────────────────

export function useReviews(repo?: string, page: number = 1) {
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  params.set('page', String(page));

  return useQuery<ReviewsResponse>({
    queryKey: ['reviews', repo, page],
    queryFn: async () => {
      const result = await fetchApi<{
        data: Review[];
        pagination: { page: number; limit: number; offset: number };
      }>(`/api/reviews?${params.toString()}`);
      return {
        reviews: result.data,
        total: result.data.length,
        page: result.pagination.page,
        pageSize: result.pagination.limit,
      };
    },
  });
}

export function useDeleteRepoReviews() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      repoFullName,
      includeMemory,
    }: {
      repoFullName: string;
      includeMemory?: boolean;
    }) => {
      const url = `/api/reviews/${encodeURIComponent(repoFullName)}${includeMemory ? '?includeMemory=true' : ''}`;
      return fetchData<{ deletedReviews: number; clearedMemory: number | null }>(url, {
        method: 'DELETE',
      });
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', variables.repoFullName] });
      if (variables.includeMemory) {
        void queryClient.invalidateQueries({ queryKey: ['memory'] });
      }
    },
  });
}

// ─── Stats ────────────────────────────────────────────────

export function useStats(repo: string) {
  return useQuery<Stats>({
    queryKey: ['stats', repo],
    queryFn: () => fetchData<Stats>(`/api/stats?repo=${encodeURIComponent(repo)}`),
    enabled: !!repo,
  });
}

// ─── Repositories ─────────────────────────────────────────

export function useRepositories() {
  return useQuery<Repository[]>({
    queryKey: ['repositories'],
    queryFn: () => fetchData<Repository[]>('/api/repositories'),
  });
}

// ─── Settings ─────────────────────────────────────────────

export function useSettings(repo: string) {
  return useQuery<RepositorySettings>({
    queryKey: ['settings', repo],
    queryFn: () => fetchData<RepositorySettings>(`/api/settings?repo=${encodeURIComponent(repo)}`),
    enabled: !!repo,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Record<string, unknown> & { repoFullName: string }) =>
      fetchApi<{ data: { message: string } }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['settings', variables.repoFullName],
      });
    },
  });
}

export function useCopySettingsToGlobal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ repoId }: { repoId: number }) =>
      fetchApi<{ data: { message: string } }>('/api/settings/copy-to-global', {
        method: 'POST',
        body: JSON.stringify({ repoId }),
      }),
    onSuccess: () => {
      // Invalidate both installation-level and repo-level caches
      void queryClient.invalidateQueries({ queryKey: ['installation-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

// ─── Provider Validation ──────────────────────────────────

export function useValidateProvider() {
  return useMutation({
    mutationFn: (payload: { provider: SaaSProvider; apiKey?: string }) =>
      fetchApi<ValidationResponse>('/api/providers/validate', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  });
}

// ─── Available Keys (for key selector dropdown) ───────────

/** Masked key info returned by GET /api/providers/keys */
export interface AvailableKeyInfo {
  maskedApiKey: string;
  source: 'global';
}

/** Map of provider → masked key info for all saved keys */
export type AvailableKeysMap = Record<string, AvailableKeyInfo>;

/**
 * Fetches all saved (masked) API keys for the current user, grouped by provider.
 * Used to populate the key-selector dropdown in ProviderEntry without re-entering keys.
 */
export function useAvailableKeys() {
  return useQuery<AvailableKeysMap>({
    queryKey: ['providers', 'keys'],
    queryFn: () => fetchData<AvailableKeysMap>('/api/providers/keys'),
    staleTime: 60_000, // 1 minute — keys don't change often
  });
}

// ─── Installations ────────────────────────────────────────

export function useInstallations() {
  return useQuery<Installation[]>({
    queryKey: ['installations'],
    queryFn: () => fetchData<Installation[]>('/api/installations'),
  });
}

export function useInstallationSettings(installationId: number) {
  return useQuery<InstallationSettings>({
    queryKey: ['installation-settings', installationId],
    queryFn: () =>
      fetchData<InstallationSettings>(
        `/api/installation-settings?installation_id=${installationId}`,
      ),
    enabled: !!installationId,
  });
}

export function useUpdateInstallationSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Record<string, unknown> & { installationId: number }) =>
      fetchApi<{ data: { message: string } }>('/api/installation-settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['installation-settings', variables.installationId],
      });
      // Also invalidate repo settings since they may show global values
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

// ─── Memory ───────────────────────────────────────────────

export function useMemorySessions(project: string) {
  return useQuery<MemorySession[]>({
    queryKey: ['memory', 'sessions', project],
    queryFn: () =>
      fetchData<MemorySession[]>(`/api/memory/sessions?project=${encodeURIComponent(project)}`),
    enabled: !!project,
  });
}

export function useObservations(sessionId: number) {
  return useQuery<Observation[]>({
    queryKey: ['memory', 'observations', sessionId],
    queryFn: () => fetchData<Observation[]>(`/api/memory/sessions/${sessionId}/observations`),
    enabled: !!sessionId,
  });
}

// ─── Memory Management Mutations ──────────────────────────

export function useDeleteObservation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ observationId }: { observationId: number }) =>
      fetchData<{ deleted: boolean }>(`/api/memory/observations/${observationId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory', 'observations'] });
      void queryClient.invalidateQueries({ queryKey: ['memory', 'sessions'] });
    },
  });
}

export function useClearRepoMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ project }: { project: string }) =>
      fetchData<{ cleared: number }>(
        `/api/memory/projects/${encodeURIComponent(project)}/observations`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory', 'observations'] });
      void queryClient.invalidateQueries({ queryKey: ['memory', 'sessions'] });
    },
  });
}

export function usePurgeAllMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchData<{ cleared: number }>('/api/memory/observations', {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
    },
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId }: { sessionId: number }) =>
      fetchData<{ deleted: boolean }>(`/api/memory/sessions/${sessionId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory', 'sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['memory', 'observations'] });
    },
  });
}

export function useCleanupEmptySessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ project }: { project?: string } = {}) =>
      fetchData<{ deletedCount: number }>(
        `/api/memory/sessions/empty${project ? `?project=${encodeURIComponent(project)}` : ''}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory', 'sessions'] });
    },
  });
}

// ─── Granular & Batch Deletes ─────────────────────────────

export function useDeleteReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reviewId }: { reviewId: number }) =>
      fetchData<{ deleted: boolean }>(`/api/reviews/${reviewId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useBatchDeleteReviews() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids }: { ids: number[] }) =>
      fetchData<{ deletedCount: number }>('/api/reviews/batch', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useBatchDeleteObservations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids }: { ids: number[] }) =>
      fetchData<{ deletedCount: number }>('/api/memory/observations/batch', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory', 'observations'] });
      void queryClient.invalidateQueries({ queryKey: ['memory', 'sessions'] });
    },
  });
}

// ─── Workflow Installation ─────────────────────────────────

export function useWorkflowStatus(owner?: string, repo?: string) {
  return useQuery<WorkflowStatus>({
    queryKey: ['workflow', 'status', owner, repo],
    queryFn: () =>
      fetchData<WorkflowStatus>(`/api/runner/install-workflow/status/${owner}/${repo}`),
    enabled: !!owner && !!repo,
    staleTime: 30_000,
  });
}

export function useInstallWorkflow(owner: string, repo: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      fetchApi<{ data: WorkflowInstallResult }>(`/api/runner/install-workflow/${owner}/${repo}`, {
        method: 'POST',
      }).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflow', 'status', owner, repo] });
    },
  });
}

export { ApiError };
