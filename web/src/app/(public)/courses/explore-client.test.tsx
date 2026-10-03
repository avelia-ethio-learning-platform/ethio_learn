import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/CourseCard', () => ({ CourseCard: ({ course }: { course: { title: string } }) => <li>{course.title}</li> }));

import { ExploreClient } from './explore-client';

const courses = [{ id: 'c1', title: 'Intro to Python' }] as never;

function view(filters = {}, over: { total?: number; page?: number; limit?: number } = {}) {
  render(<ExploreClient courses={courses} total={over.total ?? 15} page={over.page ?? 1} limit={over.limit ?? 12} filters={filters} />);
}

beforeEach(() => push.mockReset());
afterEach(cleanup);

describe('catalog', () => {
  it('sort round-trips through the URL and resets to page 1', () => {
    view({ category: 'tech' }, { page: 2 });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'price_asc' } });
    expect(push).toHaveBeenCalledWith('/courses?category=tech&sort=price_asc', { scroll: false });
  });

  it('shows the sort the URL carries, and treats an unknown value as Recommended', () => {
    view({ sort: 'newest-ish' });
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('top');
    cleanup();
    view({ sort: 'popular' });
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('popular');
  });

  it('offers the five sorts and keeps the default out of the URL', () => {
    view({ sort: 'new' });
    expect(Array.from(screen.getByLabelText('Sort by').querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Recommended',
      'Newest',
      'Most popular',
      'Price: low to high',
      'Price: high to low',
    ]);
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'top' } });
    expect(push).toHaveBeenCalledWith('/courses', { scroll: false });
  });

  it('states the range and the total', () => {
    view({}, { page: 2, total: 15 });
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 13–15 of 15 courses');
  });

  it('past the last page there is no range, only "No courses on this page"', () => {
    view({}, { page: 99, total: 10 });
    expect(screen.getByText('No courses on this page')).toBeTruthy();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('pills expose which filter is applied', () => {
    view({ category: 'tech' });
    expect(screen.getByRole('button', { name: 'Tech' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Business' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByRole('button', { name: 'All' })[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('the filters start collapsed on mobile and open when a filter is active', () => {
    view();
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel.className).toContain('hidden md:block');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.className).not.toContain('hidden');
    cleanup();
    view({ pricing_type: 'free' });
    expect(screen.getByRole('button', { name: 'Filters (1 active)' }).getAttribute('aria-expanded')).toBe('true');
  });
});
