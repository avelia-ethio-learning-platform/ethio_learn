import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CourseCover } from './CourseCover';

afterEach(cleanup);

const long = 'A very long course title that must stay fully visible and never be cut off by the cover';

describe('CourseCover', () => {
  for (const size of ['card', 'strip'] as const) {
    it(`shows the full title and both category labels at size ${size}`, () => {
      render(<CourseCover title={long} category="healthcare" size={size} />);
      expect(screen.getByText(long)).toBeTruthy();
      expect(screen.getByText('Healthcare')).toBeTruthy();
      expect(screen.getByText('ጤና')).toBeTruthy();
      expect(screen.getByText(long).className).not.toMatch(/line-clamp|truncate/);
    });
  }

  it('uses the other entry for an unknown category', () => {
    render(<CourseCover title="X" category="mystery" />);
    expect(screen.getByText('Other')).toBeTruthy();
    expect(screen.getByText('ሌላ')).toBeTruthy();
  });

  it('is an image with a text alternative, or hidden when decorative', () => {
    const { container, rerender } = render(<CourseCover title="Excel" category="business" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Excel, Business');
    rerender(<CourseCover title="Excel" category="business" decorative />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});
