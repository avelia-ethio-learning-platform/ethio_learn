'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import { Hourglass } from 'lucide-react';
import { WakingError } from '@/lib/api';
import { wakeServices } from '@/lib/wake';
import { slowRequestCount, subscribeSlow } from '@/lib/waking';

/**
 * A small fixed notice while an API call has been pending for more than 4 s,
 * or a query is retrying because the services are asleep. Free-tier services
 * sleep after 15 idle minutes and take up to a minute to wake.
 */
export function WakingUpNotice() {
  const slow = useSyncExternalStore(subscribeSlow, slowRequestCount, () => 0);
  const retrying = useIsFetching({ predicate: (q) => q.state.fetchFailureReason instanceof WakingError });
  const visible = slow > 0 || retrying > 0;

  useEffect(() => {
    if (visible) wakeServices();
  }, [visible]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {visible && (
        <p
          className="flex max-w-md items-center gap-2.5 rounded-2xl bg-background px-4 py-3 text-sm text-foreground shadow-floating"
          style={{ border: '1px solid var(--border)' }}
        >
          <Hourglass className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
          Waking up the server. This can take up to a minute on the first visit.
        </p>
      )}
    </div>
  );
}
