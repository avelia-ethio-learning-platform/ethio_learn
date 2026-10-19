'use client';

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** Whether the tab is showing. True on the server and before hydration. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !document.hidden,
    () => true,
  );
}

/**
 * A `refetchInterval` for a polling query: `ms` while the tab shows, `false`
 * (no timer at all) while it is hidden. Pair it with `refetchOnWindowFocus:
 * 'always'`, so the query refetches once when the tab comes back instead of
 * waiting for the next tick.
 */
export function usePollInterval(ms: number): number | false {
  return usePageVisible() ? ms : false;
}
