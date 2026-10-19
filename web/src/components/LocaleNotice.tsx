'use client';

import { usePathname } from 'next/navigation';
import { Languages, X } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { isTranslatedRoute } from '@/lib/i18n-routes';
import { useStoredSetting, writeStoredSetting } from '@/lib/stored-setting';

const DISMISSED = 'el_locale_notice_dismissed';

/** In Amharic mode, on a page not translated yet: one line saying it is in English for now. Dismissed per session. */
export function LocaleNotice() {
  const { locale, t } = useT();
  const pathname = usePathname() ?? '/';
  // With storage blocked, dismissed until the page reloads.
  const dismissed = useStoredSetting('sessionStorage', DISMISSED) === '1';

  if (locale !== 'am' || dismissed || isTranslatedRoute(pathname)) return null;

  const dismiss = () => writeStoredSetting('sessionStorage', DISMISSED, '1');

  return (
    <div className="mx-auto mb-4 w-full max-w-6xl px-4 sm:px-6">
      <p role="status" className="badge-info flex w-full items-center gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm">
        <Languages className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1">{t('locale_notice')}</span>
        <button type="button" onClick={dismiss} aria-label={t('dismiss')} className="shrink-0 rounded-lg p-1 transition-colors duration-fast hover:bg-brand-500/15">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </p>
    </div>
  );
}
