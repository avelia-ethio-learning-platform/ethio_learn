import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { id: 'me', role: 'educator' }, ready: true }) }));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/BackButton', () => ({ BackButton: () => null }));
vi.mock('hls.js', () => ({ default: class { static isSupported = () => false } }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'c1' }),
  useSearchParams: () => new URLSearchParams(''),
}));

import PreviewPage from './page';

const COURSE = {
  id: 'c1',
  title: 'Safety 101',
  description: 'Basics',
  status: 'draft',
  category: 'technology',
  pricing_type: 'paid',
  price_etb: 0,
  thumbnail_url: null,
  sections: [{ id: 's1', title: 'Intro', is_free_preview: false, lessons: [{ id: 'l1', title: 'Welcome', has_video: true }] }],
};

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/courses/c1') return COURSE;
    if (path === '/lessons/l1/stream-url') return { url: 'https://cdn.test/v.mp4' };
    throw new Error('no reviews');
  });
  // happy-dom has no media playback.
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});
afterEach(cleanup);

describe('Preview player', () => {
  it('asks for a lesson until one plays, then marks it as current', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PreviewPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Preview · Draft')).toBeTruthy();
    expect(screen.getByText('Choose a lesson to start the preview')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Intro' })).toBeTruthy();
    const lesson = screen.getByRole('button', { name: /Welcome/ });
    expect(lesson.getAttribute('aria-current')).toBeNull();
    fireEvent.click(lesson);
    await waitFor(() => expect(lesson.getAttribute('aria-current')).toBe('true'));
    expect(screen.queryByText('Choose a lesson to start the preview')).toBeNull();
  });
});
