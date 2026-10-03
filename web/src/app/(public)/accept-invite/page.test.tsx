import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiMock, push } = vi.hoisted(() => ({ apiMock: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
  setAuth: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams('token=tok'),
}));

import AcceptInvitePage from './page';

function respondWith(role: string, pending: number) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/auth/invite/tok') return { email: 'new@x.et', name: 'New Person', role };
    return { access_token: 'a', user: { id: 'u1', role }, pending_institution_invites: pending };
  });
}

async function setPassword() {
  render(<AcceptInvitePage />);
  const input = await screen.findByLabelText('Choose a password');
  fireEvent.change(input, { target: { value: 'Strong-passw0rd' } });
  fireEvent.click(screen.getByRole('button', { name: /set password/i }));
}

beforeEach(() => {
  apiMock.mockReset();
  push.mockReset();
});
afterEach(cleanup);

describe('Accept invite (set a password)', () => {
  it('sends an institution invitee to accept the invitation by name', async () => {
    respondWith('learner', 1);
    await setPassword();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/account/invites'));
    expect(apiMock).toHaveBeenCalledWith('/auth/accept-invite', { method: 'POST', auth: false, body: { token: 'tok', new_password: 'Strong-passw0rd' } });
  });

  it('names the invited role in words, not as a raw value', async () => {
    respondWith('institution_admin', 0);
    render(<AcceptInvitePage />);
    expect((await screen.findByText('Institution admin')).tagName).toBe('STRONG');
    expect(document.body.textContent).not.toMatch(/institution_admin|institution admin/);
  });

  it('sends staff to their home as before', async () => {
    respondWith('quality_officer', 0);
    await setPassword();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/qa'));
  });
});
