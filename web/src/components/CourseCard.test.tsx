import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CourseCard, type CourseSummary } from './CourseCard';

afterEach(cleanup);

const course: CourseSummary = {
  id: 'c1',
  title: 'Build a website',
  description: 'HTML, CSS and a little JavaScript.',
  category: 'web_development',
  thumbnail_url: null,
  pricing_type: 'free',
  price_etb: null,
};

describe('CourseCard', () => {
  it('shows the category by its human name, never the raw value', () => {
    const { container } = render(<CourseCard course={course} />);
    expect(screen.getAllByText('Web Development').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('web_development');
  });

  it('shows the generated cover when the thumbnail is missing or a placeholder', () => {
    for (const thumbnail_url of [null, 'https://placehold.co/640x360?text=x']) {
      const { container } = render(<CourseCard course={{ ...course, thumbnail_url }} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('የድር ልማት');
      cleanup();
    }
  });

  it('shows an uploaded thumbnail instead of the cover', () => {
    const { container } = render(<CourseCard course={{ ...course, thumbnail_url: 'https://cdn.example.com/a.jpg' }} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/a.jpg');
    expect(container.textContent).not.toContain('የድር ልማት');
  });
});
