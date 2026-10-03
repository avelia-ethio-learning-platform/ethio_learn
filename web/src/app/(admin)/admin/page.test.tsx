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

import { ApiError } from '@/lib/api';
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

/** happy-dom has no dialogs: stand in for window.prompt / window.confirm / window.alert. */
function stubDialog(name: 'prompt' | 'confirm' | 'alert', answer: string | boolean | null) {
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

describe('Admin payments: record a bank transfer', () => {
  const transferCalls = () => apiMock.mock.calls.filter((c) => c[0] === '/admin/payments/bank-transfer');

  /** Opens the Payments tab and picks the learner and the course. */
  async function pickLearnerAndCourse() {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/users?')) return { total: 1, items: [USER] };
      if (path.startsWith('/admin/courses?')) return [{ id: 'c1', title: 'Amharic 101', status: 'published' }];
      return {};
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AdminPage />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Payments' }));
    fireEvent.change(await screen.findByPlaceholderText('search email/name…'), { target: { value: 'ab' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Abebe (a@x.et)' }));
    fireEvent.change(screen.getByPlaceholderText('search title…'), { target: { value: 'am' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Amharic 101 [published]' }));
  }

  it('needs a bank reference before it can be marked', async () => {
    await pickLearnerAndCourse();
    const mark = screen.getByRole('button', { name: 'Mark bank transfer' }) as HTMLButtonElement;
    const reference = screen.getByLabelText('Bank reference') as HTMLInputElement;
    expect(reference.required).toBe(true);
    expect(mark.disabled).toBe(true);
    fireEvent.change(reference, { target: { value: '   ' } });
    expect(mark.disabled).toBe(true);
    fireEvent.change(reference, { target: { value: 'FT-1' } });
    expect(mark.disabled).toBe(false);
  });

  it('sends the learner, the course and the trimmed reference', async () => {
    const alertFn = stubDialog('alert', null);
    await pickLearnerAndCourse();
    fireEvent.change(screen.getByLabelText('Bank reference'), { target: { value: ' FT24123ABC ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark bank transfer' }));
    await waitFor(() =>
      expect(transferCalls()).toEqual([['/admin/payments/bank-transfer', { method: 'POST', body: { learner_id: 'u1', course_id: 'c1', bank_reference: 'FT24123ABC' } }]]),
    );
    await waitFor(() => expect(alertFn).toHaveBeenCalledWith('Bank transfer recorded — entitlement grants via PaymentConfirmed.'));
  });

  it.each([
    [409, 'This learner already owns the course'],
    [503, "Couldn't check enrollment. Try again."],
  ])('shows a %s refusal through alert()', async (status, message) => {
    const alertFn = stubDialog('alert', null);
    await pickLearnerAndCourse();
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === '/admin/payments/bank-transfer') throw new ApiError(status, message);
      return base(path, ...rest);
    });
    fireEvent.change(screen.getByLabelText('Bank reference'), { target: { value: 'FT-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark bank transfer' }));
    await waitFor(() => expect(alertFn).toHaveBeenCalledWith(message));
  });
});
