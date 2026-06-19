/**
 * Tests for global React Query error handling.
 * Validates that QueryCache and MutationCache onError callbacks fire on failures.
 */

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Global React Query error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('QueryCache onError is called when a query fails', async () => {
    const onError = vi.fn();

    const queryClient = new QueryClient({
      queryCache: new QueryCache({ onError }),
      defaultOptions: {
        queries: { retry: false },
      },
    });

    function wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    renderHook(
      () =>
        useQuery({
          queryKey: ['failing-query'],
          queryFn: () => Promise.reject(new Error('Network failure')),
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    // Verify the first argument is the error with the correct message
    const errorArg = onError.mock.calls[0]![0] as Error;
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toBe('Network failure');

    // Cleanup
    queryClient.clear();
  });

  it('MutationCache onError is called when a mutation fails', async () => {
    const onError = vi.fn();

    const queryClient = new QueryClient({
      mutationCache: new MutationCache({ onError }),
    });

    function wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => Promise.reject(new Error('Mutation failed')),
        }),
      { wrapper },
    );

    // Trigger the mutation and let it fail
    result.current.mutate(undefined, {
      onError: () => {
        // swallow in per-call handler to avoid unhandled rejection
      },
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    // Verify the first argument is the error with the correct message
    const errorArg = onError.mock.calls[0]![0] as Error;
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toBe('Mutation failed');

    // Cleanup
    queryClient.clear();
  });
});
