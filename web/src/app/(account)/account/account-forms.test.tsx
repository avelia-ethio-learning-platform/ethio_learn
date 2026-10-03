import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/BackButton', () => ({ BackButton: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

import Account from './page';
import ChangePasswordPage from './password/page';

const me = { name: 'Abebe Bikila', email: 'a@b.et', phone: '', role: 'learner', created_at: '2026-01-01T00:00:00Z', email_verified: true };

function setup() {
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === 'PUT') return {};
    return me;
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Account />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

describe('Account settings', () => {
  it('labels the profile fields and shows the role as a human label', async () => {
    setup();
    expect((await screen.findByLabelText('Full name')).getAttribute('name')).toBe('name');
    expect(screen.getByLabelText('Phone (optional)').getAttribute('name')).toBe('phone');
    expect((screen.getByLabelText('Email (cannot be changed)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Learner')).toBeTruthy();
  });

  it('announces a failed save as an alert', async () => {
    setup();
    apiMock.mockImplementation(async (_p: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') throw new Error('Name is too short');
      return me;
    });
    const name = await screen.findByLabelText('Full name');
    fireEvent.submit(name.closest('form')!);
    await waitFor(() => expect(screen.getByText('Name is too short').closest('[role="alert"]')).not.toBeNull());
  });

  it('puts a successful save in the polite status region', async () => {
    setup();
    const name = await screen.findByLabelText('Full name');
    fireEvent.submit(name.closest('form')!);
    const ok = await screen.findByText('Profile saved.');
    expect(ok.closest('[role="status"]')).not.toBeNull();
    expect(ok.className).toContain('badge-success');
  });
});

describe('Change password', () => {
  it('a weak password after a server error clears the stale server error', async () => {
    apiMock.mockRejectedValue(new Error('Password was used recently'));
    render(<ChangePasswordPage />);
    const password = screen.getByLabelText('New password');
    const confirm = screen.getByLabelText('Confirm new password');
    fireEvent.change(password, { target: { value: 'Strong-passw0rd' } });
    fireEvent.change(confirm, { target: { value: 'Strong-passw0rd' } });
    fireEvent.submit(password.closest('form')!);
    expect(await screen.findByText('Password was used recently')).toBeTruthy();

    fireEvent.change(password, { target: { value: 'aaaaaaaa' } });
    fireEvent.submit(password.closest('form')!);
    expect(await screen.findByText(/at least 3 of/)).toBeTruthy();
    expect(screen.queryByText('Password was used recently')).toBeNull();
  });
});
