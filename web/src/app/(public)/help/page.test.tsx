import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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
});
