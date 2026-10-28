import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Create a fresh QueryClient configured for tests (no retries, no GC).
 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Wrapper component for renderHook / render that provides QueryClient.
 */
export function createWrapper(queryClient?: QueryClient) {
  const client = queryClient ?? createTestQueryClient();
  // The wrapper must close over this call's QueryClient. It is created once per
  // renderHook invocation, so its identity stays stable for that test.
  // biome-ignore lint/correctness/noComponentHookFactories: per-call QueryClient
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
