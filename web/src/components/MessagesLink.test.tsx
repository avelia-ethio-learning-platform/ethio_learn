import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, auth } = vi.hoisted(() => ({ apiMock: vi.fn(), auth: { user: { id: 'u1' } as { id: string } | null } }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: auth.user, ready: true }) }));

import { MessagesLink } from './MessagesLink';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessagesLink />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  apiMock.mockReset();
  auth.user = { id: 'u1' };
});
afterEach(cleanup);

describe('MessagesLink', () => {
  it('links to /messages, with the count in the name and on the badge (capped at 9+)', async () => {
    apiMock.mockResolvedValue({ unread: 12 });
    const client = mount();
    const link = await screen.findByRole('link', { name: 'Messages, 12 unread' });
    expect(link.getAttribute('href')).toBe('/messages');
    expect(link.textContent).toBe('9+');
    // The key the messages page invalidates when a thread is opened, per user.
    expect(client.getQueryData(['dm-unread', 'u1'])).toEqual({ unread: 12 });
    expect(apiMock).toHaveBeenCalledWith('/messages/unread-count');
  });

  it('with nothing unread it is plain "Messages" with no badge', async () => {
    apiMock.mockResolvedValue({ unread: 0 });
    mount();
    const link = await screen.findByRole('link', { name: 'Messages' });
    expect(link.textContent).toBe('');
  });

  it('signed out: renders nothing and asks nothing', () => {
    auth.user = null;
    mount();
    expect(screen.queryByRole('link')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
