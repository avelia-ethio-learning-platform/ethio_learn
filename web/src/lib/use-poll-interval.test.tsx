import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { usePageVisible, usePollInterval } from './use-poll-interval';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe('usePollInterval', () => {
  it('is the interval while the tab shows, false while it is hidden', () => {
    const { result } = renderHook(() => usePollInterval(4_000));
    expect(result.current).toBe(4_000);
    act(() => setHidden(true));
    expect(result.current).toBe(false);
    act(() => setHidden(false));
    expect(result.current).toBe(4_000);
  });

  it('reports visibility', () => {
    const { result } = renderHook(() => usePageVisible());
    expect(result.current).toBe(true);
    act(() => setHidden(true));
    expect(result.current).toBe(false);
  });

  it('stops polling while hidden, and refetches once when the tab is visible again', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => 'x');
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000 } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(
      () => useQuery({ queryKey: ['poll'], queryFn: fetcher, refetchInterval: usePollInterval(4_000), refetchOnWindowFocus: 'always' }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(fetcher).toHaveBeenCalledTimes(2);

    act(() => setHidden(true));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Back on screen: one refresh at once (the data is not stale yet), then the polling goes on.
    act(() => setHidden(false));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
