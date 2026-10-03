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
    expect(screen.getByText('Web Development')).toBeTruthy();
    expect(container.textContent).not.toContain('web_development');
  });
});
