'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Hourglass, RefreshCw } from 'lucide-react';
import { wakeServices } from '@/lib/wake';

/**
 * What a page shows when the API is asleep, down or too slow (`serverApi` →
 * `unavailable`, or a client query that gave up), instead of a false 404 or
 * "invalid certificate". It wakes the services on mount. Retry re-renders the
 * page on the server, or calls `onRetry` (the query's `refetch`) on a
 * client-fetched page.
 */
export function WakingUp({ onRetry }: { onRetry?: () => Promise<unknown> }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [refetching, setRefetching] = useState(false);
  const retrying = refreshing || refetching;

  useEffect(() => wakeServices(), []);

  const retry = () => {
    wakeServices();
    if (!onRetry) return startTransition(() => router.refresh());
    setRefetching(true);
    void onRetry().finally(() => setRefetching(false));
  };

  return (
    <div className="page-shell flex min-h-[60vh] items-center justify-center">
      <div role="status" className="card w-full max-w-md animate-fade-in-up !rounded-3xl p-8 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-600">
          <Hourglass className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="text-xl font-bold text-foreground">We&apos;re waking up the server</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          This can take up to a minute after a quiet period. Try again in a moment.
        </p>
        <button type="button" onClick={retry} disabled={retrying} className="btn mt-6 inline-flex !px-8">
          <RefreshCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} aria-hidden />
          {retrying ? 'Checking…' : 'Retry'}
        </button>
      </div>
    </div>
  );
}
