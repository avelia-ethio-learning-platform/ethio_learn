'use client';

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { useStoredSetting, writeStoredSetting } from '@/lib/stored-setting';
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT, THEME_STORAGE_KEY as STORAGE_KEY } from '@/lib/theme-script';

/**
 * Light/dark/system theme, ported from the template's DarkModeProvider.
 * The `.dark` class is applied to <html>; an inline script in layout.tsx
 * applies it before hydration so there is no flash of the wrong theme.
 */
export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'system',
  setTheme: () => undefined,
  isDark: false,
});

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystemDark(onChange: () => void) {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/**
 * The viewport export renders one theme-color meta per colour scheme, chosen by the
 * OS media query. An explicit theme overrides both; `system` restores each to its own scheme.
 */
export function syncThemeColorMeta(theme: Theme) {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    if (theme === 'light') meta.content = THEME_COLOR_LIGHT;
    else if (theme === 'dark') meta.content = THEME_COLOR_DARK;
    else meta.content = meta.media.includes('dark') ? THEME_COLOR_DARK : THEME_COLOR_LIGHT;
  });
}

function parseTheme(saved: string | null): Theme {
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The saved theme (the pre-hydration script already set the class); `system` in the server HTML.
  const theme = parseTheme(useStoredSetting('localStorage', STORAGE_KEY));
  // Follows the OS preference live; only used in `system` mode.
  const systemDark = useSyncExternalStore(subscribeSystemDark, () => window.matchMedia(DARK_QUERY).matches, () => false);
  const isDark = theme === 'dark' || (theme === 'system' && systemDark);

  // Reflect state onto <html>.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  // Next re-creates the theme-color metas with the server's colours whenever a
  // client navigation remounts the route head, so re-apply the theme to new ones.
  useEffect(() => {
    syncThemeColorMeta(theme);
    const observer = new MutationObserver((records) => {
      const added = records.some((r) => Array.from(r.addedNodes).some((n) => n instanceof HTMLMetaElement && n.name === 'theme-color'));
      if (added) syncThemeColorMeta(theme);
    });
    observer.observe(document.head, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [theme]);

  const setTheme = useCallback((next: Theme) => writeStoredSetting('localStorage', STORAGE_KEY, next), []);

  return <ThemeContext.Provider value={{ theme, setTheme, isDark }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
