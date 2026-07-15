'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

/** Consistent back navigation on inner pages. */
export function BackButton({ fallback = '/', label = 'Back' }: { fallback?: string; label?: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => {
        if (typeof window !== 'undefined' && window.history.length > 1) router.back();
        else router.push(fallback);
      }}
      className="group mb-6 inline-flex items-center gap-2 rounded-xl px-2 py-1 text-sm font-medium text-gray-500 transition-colors hover:text-brand-600"
    >
      <ArrowLeft className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-1" />
      {label}
    </button>
  );
}
