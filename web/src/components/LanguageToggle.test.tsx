import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n';
import { LanguageToggle } from './LanguageToggle';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('LanguageToggle', () => {
  it('its accessible name starts with the visible text, in both languages (WCAG 2.5.3)', async () => {
    render(
      <I18nProvider>
        <LanguageToggle />
      </I18nProvider>,
    );
    const button = screen.getByRole('button', { name: 'አማ Switch language' });
    expect(button.querySelector('[lang="am"]')!.textContent).toBe('አማ');
    fireEvent.click(button);
    // The Amharic strings load on first use (lib/i18n.tsx).
    expect((await screen.findByRole('button', { name: 'EN ቋንቋ ቀይር' })).querySelector('[lang="en"]')!.textContent).toBe('EN');
  });
});
