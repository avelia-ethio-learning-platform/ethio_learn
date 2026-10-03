import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import HelpPage from './page';

afterEach(cleanup);

describe('Help page copy', () => {
  it('shows apostrophes, never a literal &apos; (P0-16)', () => {
    const { container } = render(<HelpPage />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('&apos;');
    expect(text).toContain("What's the difference between free, freemium and paid courses?");
    expect(text).toContain("A video won't play.");
  });

  it('links to the certificate verification form (P0-18)', () => {
    const { container } = render(<HelpPage />);
    expect(container.querySelector('a[href="/verify"]')).not.toBeNull();
  });

  it('a collapsed answer is invisible, so its links are not tab stops, and its button controls it', () => {
    render(<HelpPage />);
    const button = screen.getByRole('button', { name: /Do I get a certificate/ });
    const answer = document.getElementById(button.getAttribute('aria-controls')!)!;
    const link = answer.querySelector('a[href="/verify"]')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(link.closest('.invisible')).not.toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(link.closest('.invisible')).toBeNull();
  });
});
