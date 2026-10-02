import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/admin',
}));

import AdminPage from './page';

const USER = { id: 'u1', name: 'Abebe', email: 'a@x.et', role: 'learner', status: 'active', email_verified: true };

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => (path.startsWith('/admin/users?') ? { total: 1, items: [USER] } : {}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** happy-dom has no dialogs: stand in for window.prompt / window.confirm. */
function stubDialog(name: 'prompt' | 'confirm', answer: string | boolean | null) {
  const fn = vi.fn(() => answer);
  vi.stubGlobal(name, fn);
  return fn;
}

async function openUsersTab() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AdminPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Users' }));
  await screen.findByText('Abebe');
}

const statusCalls = () => apiMock.mock.calls.filter((c) => c[0] === '/admin/users/u1/status');

describe('Admin users: suspend and ban', () => {
  it('Cancel on the suspend reason prompt sends nothing', async () => {
    const prompt = stubDialog('prompt', null);
    await openUsersTab();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(prompt).toHaveBeenCalled();
    expect(statusCalls()).toEqual([]);
  });

  it('Cancel on the reason prompt after confirming a ban sends nothing', async () => {
    stubDialog('confirm', true);
    stubDialog('prompt', null);
    await openUsersTab();
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    expect(statusCalls()).toEqual([]);
  });

  it('OK sends the status with the reason, or without one when left empty', async () => {
    const prompt = stubDialog('prompt', ' spam ');
    await openUsersTab();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(statusCalls()).toEqual([['/admin/users/u1/status', { method: 'POST', body: { status: 'suspended', reason: 'spam' } }]]));
    prompt.mockReturnValue('' as never);
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(statusCalls()[1]).toEqual(['/admin/users/u1/status', { method: 'POST', body: { status: 'suspended', reason: undefined } }]));
  });
});
