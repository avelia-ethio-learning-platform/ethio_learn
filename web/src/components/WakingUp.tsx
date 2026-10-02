'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Hourglass, RefreshCw } from 'lucide-react';
import { wakeServices } from '@/lib/wake';

/**
 * What a server-rendered page shows when the API is asleep, down or too slow
 * (`serverApi` → `unavailable`), instead of a false 404 or "invalid
 * certificate". It wakes the services on mount; Retry re-renders the page on
 * the server.
 */
export function WakingUp() {
  const router = useRouter();
  const [retrying, startTransition] = useTransition();

  useEffect(() => wakeServices(), []);

  const retry = () => {
    wakeServices();
    startTransition(() => router.refresh());
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
