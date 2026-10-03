'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { PageShell } from '@/components/PageChrome';
import { useT } from '@/lib/i18n';

/**
 * Real bugs land here. A sleeping API doesn't: pages render `<WakingUp />`
 * themselves, because in production this boundary only gets a sanitized
 * message and can't tell a cold start from a bug.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useT();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageShell className="flex min-h-[60vh] items-center justify-center">
      <div className="card w-full max-w-md animate-fade-in-up !rounded-3xl p-8 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-500">
          <TriangleAlert className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="text-xl font-bold text-foreground">{t('error_title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">{t('error_body')}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={reset} className="btn !px-6">
            {t('retry')}
          </button>
          <Link href="/" className="btn-ghost">
            {t('home')}
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
