import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import NotFound from './not-found';

afterEach(cleanup);

describe('not-found page', () => {
  it('has one heading and a labelled course search that goes to /courses?q=', () => {
    render(<NotFound />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("We couldn't find that page");
    const input = screen.getByLabelText('Search courses') as HTMLInputElement;
    expect(input.name).toBe('q');
    const form = input.closest('form')!;
    expect(form.getAttribute('action')).toBe('/courses');
    expect(form.getAttribute('method')).toBe('get');
    expect(screen.getByRole('link', { name: 'Browse courses' }).getAttribute('href')).toBe('/courses');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
  });
});
