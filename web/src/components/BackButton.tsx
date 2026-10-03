'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/hooks';
import { roleHome, roleHomeLabel } from '@/lib/safe-next';
import { useT } from '@/lib/i18n';

/** Consistent back navigation on inner pages. */
export function BackButton({ fallback = '/', label }: { fallback?: string; label?: ReactNode }) {
  const router = useRouter();
  const { t } = useT();
  return (
    <button
      onClick={() => {
        if (typeof window !== 'undefined' && window.history.length > 1) router.back();
        else router.push(fallback);
      }}
      className="group mb-6 inline-flex items-center gap-2 rounded-xl px-2 py-1 text-sm font-medium text-gray-500 transition-colors hover:text-brand-600"
    >
      <ArrowLeft className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-1" />
      {label ?? t('back')}
    </button>
  );
}

/** Back link on pages several roles share: falls back to, and is named after, the viewer's own home. */
export function RoleHomeBackButton({ educatorLabel }: { educatorLabel?: string }) {
  const { user } = useAuth();
  const label = user?.role === 'educator' && educatorLabel ? educatorLabel : roleHomeLabel(user?.role);
  return <BackButton fallback={roleHome(user?.role)} label={label} />;
}
