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

import { ApiError } from '@/lib/api';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { InvitesList } from './invites-list';

let memberships: Array<{ id: string; institution: { id: string; name: string }; status: string; joined_at: string }>;
let membershipsGone = false;
let pending: Array<{ id: string; institution: { id: string; name: string }; invited_at: string }>;

beforeEach(() => {
  pending = [
    { id: 'm1', institution: { id: 'i1', name: 'Addis Academy' }, invited_at: '2026-10-01T10:00:00Z' },
    { id: 'm2', institution: { id: 'i2', name: 'Bahir Dar Tech' }, invited_at: '2026-10-02T10:00:00Z' },
  ];
  memberships = [{ id: 'mem1', institution: { id: 'i9', name: 'Gondar College' }, status: 'active', joined_at: '2026-09-01T10:00:00Z' }];
  membershipsGone = false;
  apiMock.mockReset();
  refreshMock.mockReset().mockResolvedValue(true);
  push.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/profiles/me/institution-memberships') {
      if (membershipsGone) throw new ApiError(404, 'Not found');
      return memberships;
    }
    if (path.startsWith('/profiles/me/institution-memberships/')) {
      memberships = [];
      return { status: 'removed' };
    }
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
      <ConfirmProvider>
        <InvitesList />
      </ConfirmProvider>
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
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.includes('memberships')) return [];
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
    memberships = [];
    renderList();
    expect(await screen.findByText('No pending invitations.')).toBeTruthy();
  });

  const dialog = () => document.querySelector('dialog') as HTMLDialogElement;
  const leaveCalls = () => apiMock.mock.calls.filter((c) => String(c[0]).endsWith('/leave'));

  it('lists the institution you teach with and Leave asks first; Cancel sends nothing', async () => {
    renderList();
    const card = within(await screen.findByRole('region', { name: 'Gondar College membership' }));
    fireEvent.click(card.getByRole('button', { name: 'Leave' }));
    expect(within(dialog()).getByText('Leave Gondar College?')).toBeTruthy();
    expect(within(dialog()).getByText(/won't go through their review\. Courses you already made for them stay with them\./)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog().open).toBe(false));
    expect(leaveCalls()).toEqual([]);
  });

  it('Leave then confirm posts, refreshes the section and says so', async () => {
    renderList();
    const card = within(await screen.findByRole('region', { name: 'Gondar College membership' }));
    fireEvent.click(card.getByRole('button', { name: 'Leave' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Leave institution' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Gondar College membership' })).toBeNull());
    expect(leaveCalls()).toEqual([['/profiles/me/institution-memberships/mem1/leave', { method: 'POST' }]]);
    expect(screen.getByText('You left Gondar College.')).toBeTruthy();
  });

  it('shows a refused leave as an error', async () => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/profiles/me/institution-memberships') return memberships;
      if (opts?.method) throw new Error('Not found');
      return pending;
    });
    renderList();
    const card = within(await screen.findByRole('region', { name: 'Gondar College membership' }));
    fireEvent.click(card.getByRole('button', { name: 'Leave' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Leave institution' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => a.textContent === 'Not found')).toBe(true));
  });

  it('hides the section when the memberships endpoint is not there yet (404)', async () => {
    membershipsGone = true;
    renderList();
    expect(await screen.findByRole('region', { name: 'Addis Academy' })).toBeTruthy();
    expect(screen.queryByText('Your institution')).toBeNull();
  });
});
