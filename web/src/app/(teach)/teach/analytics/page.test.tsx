import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/BackButton', () => ({ RoleHomeBackButton: () => null }));

import TeachAnalyticsPage from './page';

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

describe('Teach analytics page', () => {
  it('asks the funnel for at most 25 courses, the API limit', async () => {
    const courses = Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 1}` }));
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/courses') return courses;
      if (path.startsWith('/enrollments/analytics')) return [];
      return { total_gross_etb: 0, total_net_etb: 0, by_month: [] };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TeachAnalyticsPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(apiMock.mock.calls.some(([p]) => String(p).startsWith('/enrollments/analytics'))).toBe(true));
    const path = apiMock.mock.calls.map(([p]) => String(p)).find((p) => p.startsWith('/enrollments/analytics'))!;
    const ids = new URLSearchParams(path.split('?')[1]).get('course_ids')!.split(',');
    expect(ids).toHaveLength(25);
    expect(ids[0]).toBe('c1');
    expect(ids[24]).toBe('c25');
  });

  it('shows the empty state, not a skeleton, when the educator has no courses', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/courses') return [];
      return { total_gross_etb: 0, total_net_etb: 0, by_month: [], by_course: [] };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TeachAnalyticsPage />
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText('Publish a course to see analytics')).length).toBe(2);
    await screen.findByText('No revenue in the last 12 months');
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(apiMock.mock.calls.some(([p]) => String(p).startsWith('/enrollments/analytics'))).toBe(false);
  });

  it('shows "Couldn\'t load" with Retry when the courses query fails', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/courses') throw new Error('boom');
      return { total_gross_etb: 0, total_net_etb: 0, by_month: [], by_course: [] };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TeachAnalyticsPage />
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText("Couldn't load your courses.")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });
});
