'use client';

import { Languages } from 'lucide-react';
import { useT } from '@/lib/i18n';

/** English ⇄ Amharic switch, styled after the template's LanguageToggle. */
export function LanguageToggle() {
  const { locale, toggle, t } = useT();
  // The visible text names the language it switches to, so it opens the accessible name (WCAG 2.5.3).
  const target = locale === 'en' ? { lang: 'am', short: 'አማ' } : { lang: 'en', short: 'EN' };

  return (
    <button
      onClick={toggle}
      title={locale === 'en' ? 'ወደ አማርኛ ቀይር' : 'Switch to English'}
      className="glass-secondary flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-brand-600 shadow-glass transition hover:scale-105 hover:text-brand-700 active:scale-[.98]"
    >
      <Languages className="h-4 w-4" aria-hidden />
      <span lang={target.lang}>{target.short}</span>
      <span className="sr-only">{t('switch_language')}</span>
    </button>
  );
}
