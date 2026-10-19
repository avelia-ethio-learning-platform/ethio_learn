import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { ReviewsList, type Review } from './reviews-list';

const review = (n: number): Review => ({ id: `r${n}`, rating: 4, comment: `Review ${n}`, created_at: '2026-10-01T10:00:00Z' });
const PAGE_ONE = Array.from({ length: 20 }, (_, i) => review(i + 1));

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/courses/k1/reviews?page=2') return { reviews: [review(21), review(22)], has_more: false };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

const shown = () => screen.queryAllByText(/^Review \d+$/).length;

describe('ReviewsList', () => {
  it('shows five, then the rest of the first page, then fetches the next page until has_more is false', async () => {
    render(<ReviewsList courseId="k1" initial={PAGE_ONE} hasMore />);
    expect(shown()).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show more reviews' }));
    expect(shown()).toBe(20);
    expect(apiMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show more reviews' }));
    expect(await screen.findByText('Review 22')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/courses/k1/reviews?page=2', { auth: false });
    expect(shown()).toBe(22);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more reviews' })).toBeNull());
  });

  it('has no button when everything is shown and the API has no more', () => {
    render(<ReviewsList courseId="k1" initial={PAGE_ONE.slice(0, 3)} hasMore={false} />);
    expect(shown()).toBe(3);
    expect(screen.queryByRole('button', { name: 'Show more reviews' })).toBeNull();
  });
});
