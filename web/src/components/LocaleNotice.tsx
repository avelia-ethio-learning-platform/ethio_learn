'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Languages, X } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { isTranslatedRoute } from '@/lib/i18n-routes';

const DISMISSED = 'el_locale_notice_dismissed';

/** In Amharic mode, on a page not translated yet: one line saying it is in English for now. Dismissed per session. */
export function LocaleNotice() {
  const { locale, t } = useT();
  const pathname = usePathname() ?? '/';
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISSED) === '1');
    } catch {
      /* storage blocked: keep showing it */
    }
  }, []);

  if (locale !== 'am' || dismissed || isTranslatedRoute(pathname)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED, '1');
    } catch {
      /* storage blocked: dismissed for this page view only */
    }
  };

  return (
    <div className="mx-auto mb-4 w-full max-w-6xl px-4 sm:px-6">
      <p role="status" className="badge-info flex w-full items-center gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm">
        <Languages className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1">{t('locale_notice')}</span>
        <button type="button" onClick={dismiss} aria-label={t('dismiss')} className="shrink-0 rounded-lg p-1 transition-colors hover:bg-brand-500/15">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </p>
    </div>
  );
}
