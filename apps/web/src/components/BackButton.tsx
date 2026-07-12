'use client';

import { useRouter } from 'next/navigation';

/** Consistent back navigation on inner pages. */
export function BackButton({ fallback = '/', label = 'Back' }: { fallback?: string; label?: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => {
        if (typeof window !== 'undefined' && window.history.length > 1) router.back();
        else router.push(fallback);
      }}
      className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-700"
    >
      <span aria-hidden>←</span> {label}
    </button>
  );
}
