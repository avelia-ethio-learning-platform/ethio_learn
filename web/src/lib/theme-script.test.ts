import { afterEach, describe, expect, it } from 'vitest';
import { THEME_INIT_SCRIPT } from './theme-script';

const run = () => new Function(THEME_INIT_SCRIPT)();

describe('THEME_INIT_SCRIPT', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.lang = 'en';
    document.documentElement.className = '';
  });

  it('sets <html lang> from the saved locale before React runs', () => {
    localStorage.setItem('el_locale', 'am');
    run();
    expect(document.documentElement.lang).toBe('am');
  });

  it('leaves lang alone without a saved locale, or with an unknown one', () => {
    run();
    expect(document.documentElement.lang).toBe('en');
    localStorage.setItem('el_locale', 'fr');
    run();
    expect(document.documentElement.lang).toBe('en');
  });

  it('still applies the saved dark theme', () => {
    localStorage.setItem('el_theme', 'dark');
    run();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
