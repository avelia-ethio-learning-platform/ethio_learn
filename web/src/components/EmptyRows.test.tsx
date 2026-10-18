import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SearchX } from 'lucide-react';
import { EmptyRows } from './EmptyRows';

afterEach(cleanup);

describe('<EmptyRows />', () => {
  it('renders the label, the given icon and the next action', () => {
    const { container } = render(<EmptyRows label="No courses yet" icon={SearchX} action={<a href="/courses">Browse all courses</a>} />);
    expect(screen.getByText('No courses yet')).toBeTruthy();
    expect(container.querySelector('svg.lucide-search-x')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Browse all courses' }).getAttribute('href')).toBe('/courses');
  });

  it('without an action renders no action slot', () => {
    const { container } = render(<EmptyRows label="Nothing here" />);
    expect(container.querySelector('a, button')).toBeNull();
    expect(container.querySelector('svg.lucide-inbox')).not.toBeNull();
  });
});
