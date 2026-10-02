import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  { membership_id: 'm5', status: 'removed', status_reason: null, email: 'gone@x.et', user: { id: 'u5', name: 'Gone', role: 'educator' } },
];

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => (opts?.method ? {} : MEMBERS));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderManager() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InstructorManager institutionId="inst1" />
    </QueryClientProvider>,
  );
  await screen.findByTestId('member-m1');
}

const row = (id: string) => within(screen.getByTestId(`member-${id}`));
const actions = (id: string) => row(id).queryAllByRole('button').map((b) => b.textContent);
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

  it('sends nothing when the suspend reason prompt is cancelled', async () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    await renderManager();
    fireEvent.click(row('m2').getByRole('button', { name: 'Suspend' }));
    expect(writes()).toEqual([]);
  });

  it('suspends the membership by its id, with the reason', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'late grading'));
    await renderManager();
    fireEvent.click(row('m2').getByRole('button', { name: 'Suspend' }));
    await waitFor(() =>
      expect(writes()).toEqual([['/institutions/inst1/instructors/m2/status', { method: 'POST', body: { status: 'suspended', reason: 'late grading' } }]]),
    );
  });

  it('cancels an invitation without asking, and asks before removing a member', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderManager();
    fireEvent.click(row('m1').getByRole('button', { name: 'Cancel invite' }));
    await waitFor(() => expect(writes()).toEqual([['/institutions/inst1/instructors/m1/status', { method: 'POST', body: { status: 'removed', reason: undefined } }]]));
    fireEvent.click(row('m2').getByRole('button', { name: 'Remove' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(1);
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
