'use client';

import { useState } from 'react';

/**
 * A panel that couldn't load says so and offers Retry, instead of vanishing
 * or staying blank. `onRetry` is the failing query's `refetch`.
 */
export function PanelError({ panel, onRetry }: { panel: string; onRetry: () => Promise<unknown> | unknown }) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="text-red-600 dark:text-red-400">Couldn&apos;t load {panel}.</p>
      <button type="button" onClick={retry} disabled={retrying} className="btn-secondary !px-3 !py-1 !text-xs">
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
