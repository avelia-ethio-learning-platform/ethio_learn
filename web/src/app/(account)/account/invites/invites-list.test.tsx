import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, refreshMock, push } = vi.hoisted(() => ({ apiMock: vi.fn(), refreshMock: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
  refreshSession: () => refreshMock(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { InvitesList } from './invites-list';

let pending: Array<{ id: string; institution: { id: string; name: string }; invited_at: string }>;

beforeEach(() => {
  pending = [
    { id: 'm1', institution: { id: 'i1', name: 'Addis Academy' }, invited_at: '2026-10-01T10:00:00Z' },
    { id: 'm2', institution: { id: 'i2', name: 'Bahir Dar Tech' }, invited_at: '2026-10-02T10:00:00Z' },
  ];
  apiMock.mockReset();
  refreshMock.mockReset().mockResolvedValue(true);
  push.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (!opts?.method) return pending;
    const id = path.split('/')[4];
    pending = pending.filter((p) => p.id !== id);
    return {};
  });
});
afterEach(cleanup);

function renderList() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InvitesList />
    </QueryClientProvider>,
  );
}

describe('InvitesList', () => {
  it('names each inviting institution', async () => {
    renderList();
    expect(await screen.findByRole('region', { name: 'Addis Academy' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Bahir Dar Tech' })).toBeTruthy();
  });

  it('accepts one invitation, refreshes the session for the new role, then opens the teaching dashboard', async () => {
    renderList();
    const card = within(await screen.findByRole('region', { name: 'Addis Academy' }));
    fireEvent.click(card.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/teach'));
    expect(apiMock).toHaveBeenCalledWith('/profiles/me/institution-invites/m1/accept', { method: 'POST' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
  });

  it('declines and drops the invitation from the list', async () => {
    renderList();
    const card = within(await screen.findByRole('region', { name: 'Bahir Dar Tech' }));
    fireEvent.click(card.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bahir Dar Tech' })).toBeNull());
    expect(apiMock).toHaveBeenCalledWith('/profiles/me/institution-invites/m2/decline', { method: 'POST' });
    expect(push).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows the server’s reason when acceptance is refused', async () => {
    apiMock.mockImplementation(async (_path: string, opts?: { method?: string }) => {
      if (!opts?.method) return pending;
      throw new Error("You're already an active instructor with another institution.");
    });
    renderList();
    const card = within(await screen.findByRole('region', { name: 'Addis Academy' }));
    fireEvent.click(card.getByRole('button', { name: 'Accept' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already an active instructor');
    expect(push).not.toHaveBeenCalled();
  });

  it('says so when nothing is pending', async () => {
    pending = [];
    renderList();
    expect(await screen.findByText('No pending invitations.')).toBeTruthy();
  });
});
