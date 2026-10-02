import { QueryClient } from '@tanstack/react-query';
import { WakingError } from './api';

/** While the services wake (~25–45 s on the free tier), GET queries retry every 10 s for up to 90 s. */
export const WAKING_RETRY_MS = 10_000;
export const WAKING_RETRIES = 9;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failureCount, error) => (error instanceof WakingError ? failureCount < WAKING_RETRIES : failureCount < 1),
        retryDelay: (failureCount, error) =>
          error instanceof WakingError ? WAKING_RETRY_MS : Math.min(1000 * 2 ** failureCount, 30_000),
      },
      // Mutations keep React Query's default of no retries: they surface the WakingError message.
    },
  });
}
