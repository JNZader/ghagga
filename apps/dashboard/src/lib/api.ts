import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DelegatedCiRunsResponse,
  DelegatedCiRunView,
  Installation,
  InstallationSettings,
  MemorySession,
  Observation,
  Repository,
  RepositorySettings,
  Review,
  ReviewsResponse,
  RunnerConfigureResult,
  RunnerCreateResult,
  RunnerStatus,
  SaaSProvider,
  Stats,
  ValidationResponse,
} from './types';

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

// ─── Runner ───────────────────────────────────────────────

export function useRunnerStatus(ownerLogin?: string) {
  return useQuery<RunnerStatus>({
    queryKey: ['runner', 'status', ownerLogin],
    queryFn: () => fetchData<RunnerStatus>('/api/runner/status'),
    enabled: !!ownerLogin,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useCreateRunner() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      fetchApi<{ data: RunnerCreateResult }>('/api/runner/create', {
        method: 'POST',
      }).then((res) => res.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runner', 'status'] });
    },
  });
}

export function useConfigureRunnerSecret() {
  return useMutation({
    mutationFn: () =>
      fetchApi<{ data: RunnerConfigureResult }>('/api/runner/configure-secret', {
        method: 'POST',
      }).then((res) => res.data),
  });
}

// ─── Delegated CI ─────────────────────────────────────────

export function useDelegatedCiRuns(repo: string, page = 1) {
  return useQuery<DelegatedCiRunsResponse>({
    queryKey: ['delegated-ci-runs', repo, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('repo', repo);
      params.set('page', String(page));
      const result = await fetchApi<{
        data: DelegatedCiRunsResponse;
        pagination: { page: number; limit: number; offset: number };
      }>(`/api/delegated-ci/runs?${params.toString()}`);
      return result.data;
    },
    enabled: !!repo,
  });
}

export function useDelegatedCiRun(runId: number) {
  return useQuery<DelegatedCiRunView>({
    queryKey: ['delegated-ci-run', runId],
    queryFn: () => fetchData<DelegatedCiRunView>(`/api/delegated-ci/runs/${runId}`),
    enabled: !!runId,
  });
}

export { ApiError };
