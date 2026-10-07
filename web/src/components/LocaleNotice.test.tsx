import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n';
import { isTranslatedRoute } from '@/lib/i18n-routes';
import { LocaleNotice } from './LocaleNotice';

let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

function renderAt(path: string, locale: 'en' | 'am') {
  pathname = path;
  localStorage.setItem('el_locale', locale);
  return render(
    <I18nProvider>
      <LocaleNotice />
    </I18nProvider>,
  );
}

describe('LocaleNotice', () => {
  it('says an untranslated page is in English, in Amharic mode', async () => {
    renderAt('/teach', 'am');
    expect((await screen.findByRole('status')).textContent).toBe('ይህ ገጽ ለጊዜው በእንግሊዝኛ ብቻ ነው።');
  });

  it('stays away from the translated path and from English mode', async () => {
    for (const [path, locale] of [['/courses', 'am'], ['/teach', 'en']] as const) {
      renderAt(path, locale);
      // Long enough for the Amharic strings to load (the first test shows they do).
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole('status'), `${path} in ${locale}`).toBeNull();
      cleanup();
    }
  });

  it('once dismissed, stays dismissed for the session', async () => {
    renderAt('/account', 'am');
    fireEvent.click(await screen.findByRole('button', { name: 'ዝጋ' }));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    renderAt('/messages', 'am');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('isTranslatedRoute', () => {
  it('covers the new learner path and the pages under it, nothing else', () => {
    for (const p of ['/', '/login', '/signup', '/reset-password', '/verify-email', '/courses', '/courses/abc', '/payment/return', '/dashboard']) {
      expect(isTranslatedRoute(p), p).toBe(true);
    }
    for (const p of ['/teach', '/learn/abc', '/account', '/help', '/educators', '/coursesx', '/verify', '/admin']) {
      expect(isTranslatedRoute(p), p).toBe(false);
    }
  });
});
