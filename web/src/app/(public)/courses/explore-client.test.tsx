import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { push, pending } = vi.hoisted(() => ({ push: vi.fn(), pending: { value: false } }));
// Lets a test hold the catalog in its "next results loading" state.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useTransition: () => [pending.value, (fn: () => void) => fn()] as const };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/CourseCard', () => ({ CourseCard: ({ course }: { course: { title: string } }) => <li>{course.title}</li> }));

import { ExploreClient } from './explore-client';

const courses = [{ id: 'c1', title: 'Intro to Python' }] as never;

function view(filters = {}, over: { total?: number; page?: number; limit?: number } = {}) {
  render(<ExploreClient courses={courses} total={over.total ?? 15} page={over.page ?? 1} limit={over.limit ?? 12} filters={filters} />);
}

beforeEach(() => {
  push.mockReset();
  pending.value = false;
});
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

  it('while the next results load, a bar shows and the current results stay readable and clickable', () => {
    pending.value = true;
    view();
    const results = screen.getByTestId('results');
    expect(screen.getByTestId('results-loading')).toBeTruthy();
    expect(results.parentElement!.getAttribute('aria-busy')).toBe('true');
    for (let el: HTMLElement | null = results; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/pointer-events-none|opacity-50/);
      expect(el.hasAttribute('inert')).toBe(false);
    }
    expect(screen.getByText('Intro to Python')).toBeTruthy();
  });

  it('the first results paint without an enter; changed results crossfade in', () => {
    const { rerender } = render(<ExploreClient courses={courses} total={15} page={1} limit={12} filters={{}} />);
    expect(screen.getByTestId('results').className).not.toContain('fade-in');
    rerender(<ExploreClient courses={courses} total={15} page={1} limit={12} filters={{ category: 'tech' }} />);
    expect(screen.getByTestId('results').className).toContain('fade-in');
  });

  it('with no results and a filter applied, offers Clear filters', () => {
    render(<ExploreClient courses={[]} total={0} page={1} limit={12} filters={{ category: 'tech' }} />);
    expect(screen.getByText('No published courses match yet.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1)!);
    expect(push).toHaveBeenCalledWith('/courses', { scroll: false });
  });

  it('filters by language through the URL, with a removable chip', () => {
    view({ language: 'am' });
    expect(screen.getByRole('button', { name: 'Amharic' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Amharic' }));
    expect(push).toHaveBeenCalledWith('/courses', { scroll: false });
    cleanup();
    view();
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(push).toHaveBeenCalledWith('/courses?language=en', { scroll: false });
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
