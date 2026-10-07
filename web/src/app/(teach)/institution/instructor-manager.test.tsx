import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import type { Membership } from './instructor-manager';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { InstructorManager } from './instructor-manager';

const MEMBERS: Membership[] = [
  { membership_id: 'm1', status: 'invited', status_reason: null, email: 'new@x.et' },
  { membership_id: 'm2', status: 'active', status_reason: null, email: 'abebe@x.et', user: { id: 'u2', name: 'Abebe', role: 'educator' } },
  { membership_id: 'm3', status: 'suspended', status_reason: 'late grading', email: 'sara@x.et', user: { id: 'u3', name: 'Sara', role: 'educator' } },
  { membership_id: 'm4', status: 'declined', status_reason: null, email: 'no@x.et' },
  { membership_id: 'm5', status: 'removed', status_reason: 'Left the institution', email: 'gone@x.et', user: { id: 'u5', name: 'Gone', role: 'educator' } },
];

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => (opts?.method ? {} : MEMBERS));
});
afterEach(() => {
  cleanup();
});

async function renderManager() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <InstructorManager institutionId="inst1" />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  await screen.findByTestId('member-m1');
}

const row = (id: string) => within(screen.getByTestId(`member-${id}`));
const actions = (id: string) => row(id).queryAllByRole('button').map((b) => b.textContent);
const dialog = () => document.querySelector('dialog')!;
const settle = () => act(async () => {});
const writes = () => apiMock.mock.calls.filter((c) => c[1]?.method === 'POST');

describe('InstructorManager', () => {
  it('offers the actions each membership status allows, and no platform ban', async () => {
    await renderManager();
    expect(actions('m1')).toEqual(['Cancel invite']);
    expect(actions('m2')).toEqual(['Suspend', 'Remove']);
    expect(actions('m3')).toEqual(['Reactivate', 'Remove']);
    expect(actions('m4')).toEqual(['Re-invite']);
    expect(actions('m5')).toEqual(['Re-invite']);
    expect(screen.queryByRole('button', { name: /ban/i })).toBeNull();
  });

  it('shows only the email for an invitation, and the name once accepted', async () => {
    await renderManager();
    expect(screen.getByTestId('member-m1').textContent).toContain('new@x.et');
    expect(screen.getByTestId('member-m2').textContent).toContain('Abebe (abebe@x.et)');
    expect(screen.getByTestId('member-m3').textContent).toContain('late grading');
  });

  it('shows why a removed member is gone', async () => {
    await renderManager();
    expect(screen.getByTestId('member-m5').textContent).toContain('Left the institution');
  });

  it('sends nothing when the suspend dialog is cancelled', async () => {
    await renderManager();
    fireEvent.click(row('m2').getByRole('button', { name: 'Suspend' }));
    expect(within(dialog()).getByText('Suspend Abebe?')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(writes()).toEqual([]);
  });

  it('suspends the membership by its id, with the reason typed in the dialog', async () => {
    await renderManager();
    fireEvent.click(row('m2').getByRole('button', { name: 'Suspend' }));
    fireEvent.change(within(dialog()).getByLabelText('Reason (optional)'), { target: { value: 'late grading' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Suspend' }));
    await waitFor(() =>
      expect(writes()).toEqual([['/institutions/inst1/instructors/m2/status', { method: 'POST', body: { status: 'suspended', reason: 'late grading' } }]]),
    );
  });

  it('cancels an invitation without asking, and asks before removing a member', async () => {
    await renderManager();
    fireEvent.click(row('m1').getByRole('button', { name: 'Cancel invite' }));
    await waitFor(() => expect(writes()).toEqual([['/institutions/inst1/instructors/m1/status', { method: 'POST', body: { status: 'removed', reason: undefined } }]]));
    fireEvent.click(row('m2').getByRole('button', { name: 'Remove' }));
    expect(within(dialog()).getByText('Remove Abebe from your institution?')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(writes()).toHaveLength(1);
  });

  it('shows a failed status change as an alert', async () => {
    await renderManager();
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (opts?.method) throw new Error('Not allowed');
      return MEMBERS;
    });
    fireEvent.click(row('m3').getByRole('button', { name: 'Reactivate' }));
    expect((await screen.findAllByRole('alert')).some((n) => n.textContent === 'Not allowed')).toBe(true);
  });

  it('re-invites a declined membership by email', async () => {
    await renderManager();
    fireEvent.click(row('m4').getByRole('button', { name: 'Re-invite' }));
    await waitFor(() => expect(writes()).toEqual([['/institutions/inst1/instructors', { method: 'POST', body: { email: 'no@x.et', name: undefined } }]]));
  });

  it('invites from the form and says the person still has to accept', async () => {
    await renderManager();
    fireEvent.change(screen.getByLabelText('Instructor email'), { target: { value: 'tigist@x.et' } });
    fireEvent.change(screen.getByLabelText('Instructor name'), { target: { value: 'Tigist' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite instructor' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Invitation sent. They need to accept it.');
    expect(writes()).toEqual([['/institutions/inst1/instructors', { method: 'POST', body: { email: 'tigist@x.et', name: 'Tigist' } }]]);
  });
});
