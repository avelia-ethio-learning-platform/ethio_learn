'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { en, type Dictionary, type TKey } from './i18n-en';

/**
 * Lightweight en/am i18n for the UI. Course content itself stays in the
 * language the educator authored it in. Amharic covers the shell and the new
 * learner's path (Phase 10); other pages show LocaleNotice in Amharic mode.
 */
export type Locale = 'en' | 'am';
export type { TKey };
export type Vars = Record<string, string | number>;

/** The Amharic dictionary, fetched once, the first time someone picks Amharic. */
let amLoaded: Dictionary | null = null;
const loadAm = () => import('./i18n-am').then((mod) => (amLoaded = mod.am));

/** The string for `k`, with each `{name}` filled from `vars`. */
export function translate(dict: Dictionary, k: TKey, vars?: Vars): string {
  const text = dict[k] ?? en[k];
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : text;
}

const I18nContext = createContext<{ locale: Locale; t: (k: TKey, vars?: Vars) => string; toggle: () => void }>({
  locale: 'en',
  t: (k, vars) => translate(en, k, vars),
  toggle: () => undefined,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [chosen, setChosen] = useState<Locale>('en');
  const [am, setAm] = useState<Dictionary | null>(amLoaded);

  useEffect(() => {
    const saved = localStorage.getItem('el_locale');
    if (saved === 'am' || saved === 'en') {
      setChosen(saved);
      document.documentElement.lang = saved;
    }
  }, []);

  useEffect(() => {
    if (chosen === 'am' && !am) void loadAm().then(setAm, () => undefined);
  }, [chosen, am]);

  const toggle = useCallback(() => {
    setChosen((prev) => {
      const next = prev === 'en' ? 'am' : 'en';
      localStorage.setItem('el_locale', next);
      document.documentElement.lang = next;
      return next;
    });
  }, []);

  // English until the Amharic strings are in, so text, prices and dates switch together.
  const locale: Locale = chosen === 'am' && am ? 'am' : 'en';
  const dict = locale === 'am' && am ? am : en;
  const t = useCallback((k: TKey, vars?: Vars) => translate(dict, k, vars), [dict]);

  return <I18nContext.Provider value={{ locale, t, toggle }}>{children}</I18nContext.Provider>;
}

export function useT() {
  return useContext(I18nContext);
}

/**
 * Translated text for a server component: English in the server HTML (static
 * and ISR pages can't know the reader's locale), the reader's language after
 * hydration, as in the client components.
 */
export function T({ k, vars }: { k: TKey; vars?: Vars }) {
  const { t } = useT();
  return <>{t(k, vars)}</>;
}
