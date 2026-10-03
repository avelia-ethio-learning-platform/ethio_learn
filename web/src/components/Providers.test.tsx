import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MotionConfigContext } from 'framer-motion';
import { useContext } from 'react';
import { Providers } from './Providers';

function ReducedMotionProbe() {
  return <p data-testid="probe">{String(useContext(MotionConfigContext).reducedMotion)}</p>;
}

beforeEach(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('Providers', () => {
  it('follows the visitor\'s reduced-motion setting for every framer animation', () => {
    render(
      <Providers>
        <ReducedMotionProbe />
      </Providers>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('user');
  });

  it('keeps the skip link before the page content', () => {
    render(
      <Providers>
        <button>page content</button>
      </Providers>,
    );
    const link = screen.getByRole('link', { name: /skip/i });
    const button = screen.getByRole('button', { name: 'page content' });
    expect(link.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
