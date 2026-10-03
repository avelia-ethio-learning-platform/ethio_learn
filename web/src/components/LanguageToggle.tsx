'use client';

import { Languages } from 'lucide-react';
import { useT } from '@/lib/i18n';

/** English ⇄ Amharic switch, styled after the template's LanguageToggle. */
export function LanguageToggle() {
  const { locale, toggle } = useT();

  return (
    <button
      onClick={toggle}
      aria-label="Switch language"
      title={locale === 'en' ? 'ወደ አማርኛ ቀይር' : 'Switch to English'}
      className="glass-secondary flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-brand-600 shadow-glass transition hover:scale-105 hover:text-brand-700 active:scale-[.98]"
    >
      <Languages className="h-4 w-4" />
      <span>{locale === 'en' ? 'አማ' : 'EN'}</span>
    </button>
  );
}
