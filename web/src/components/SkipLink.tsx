'use client';

import { useT } from '@/lib/i18n';

/** First tab stop on every page: jumps keyboard users past the header to <main id="main">. */
export function SkipLink() {
  const { t } = useT();
  return (
    <a
      href="#main"
      className="sr-only rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]"
    >
      {t('skip_to_content')}
    </a>
  );
}
