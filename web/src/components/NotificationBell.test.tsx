import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationBell } from './NotificationBell';

let unread = 0;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'learner' }, ready: true }) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: vi.fn(async (path: string) => (path.includes('unread-count') ? { count: unread } : [])),
}));

function renderBell() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NotificationBell />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('NotificationBell', () => {
  it('names the unread count, which the badge only shows visually', async () => {
    unread = 3;
    renderBell();
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeTruthy();
  });

  it('is plain "Notifications" with nothing unread', async () => {
    unread = 0;
    renderBell();
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });
});
