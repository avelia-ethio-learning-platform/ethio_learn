import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, auth } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  auth: { user: { id: 'adm', role: 'platform_admin' } as { id: string; role: string } | null, ready: true },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => auth }));

import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { CouponManager } from './coupon-manager';

const COUPONS = [
  { id: 'cp1', code: 'ONCE', kind: 'percent', value: 20, course_id: null, uses: 3, max_uses: 50, max_uses_per_user: 1, expires_at: null, active: true, note: '' },
  { id: 'cp2', code: 'OPEN', kind: 'amount', value: 100, course_id: null, uses: 0, max_uses: null, max_uses_per_user: null, expires_at: null, active: true, note: '' },
];

beforeEach(() => {
  auth.user = { id: 'adm', role: 'platform_admin' };
  auth.ready = true;
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => (opts?.method ? {} : path === '/coupons' ? COUPONS : []));
});
afterEach(cleanup);

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <CouponManager />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

async function renderManager() {
  mount();
  await screen.findByText('ONCE');
}

const creates = () => apiMock.mock.calls.filter((c) => c[0] === '/coupons' && c[1]?.method === 'POST');
const submit = () => fireEvent.click(screen.getByRole('button', { name: /create coupon/i }));

describe('CouponManager: uses per learner', () => {
  it('sends the per-learner limit as max_uses_per_user', async () => {
    await renderManager();
    fireEvent.change(screen.getByLabelText('Uses per learner'), { target: { value: '2' } });
    submit();
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0][1].body).toMatchObject({ max_uses_per_user: 2 });
  });

  it('leaves it out when blank, which means unlimited', async () => {
    await renderManager();
    submit();
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0][1].body.max_uses_per_user).toBeUndefined();
  });

  it.each(['0', '1.5'])('refuses %s without calling the server', async (value) => {
    await renderManager();
    fireEvent.change(screen.getByLabelText('Uses per learner'), { target: { value } });
    fireEvent.submit(screen.getByLabelText('Uses per learner').closest('form')!);
    expect(await screen.findByText('Uses per learner must be a whole number of at least 1.')).toBeTruthy();
    expect(creates()).toHaveLength(0);
  });

  it('shows the limit on coupons that have one', async () => {
    await renderManager();
    expect(screen.getByText(/1 per learner/)).toBeTruthy();
    expect(screen.queryAllByText(/\d per learner/)).toHaveLength(1);
  });
});

describe('CouponManager: admin', () => {
  const courseCalls = () => apiMock.mock.calls.filter((c) => c[0] === '/courses');

  it('makes no GET /courses call for an admin, including while auth is not ready yet', async () => {
    auth.user = null;
    auth.ready = false;
    const { rerender } = mount();
    await screen.findByText('ONCE');
    auth.user = { id: 'adm', role: 'platform_admin' };
    auth.ready = true;
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConfirmProvider>
          <CouponManager />
        </ConfirmProvider>
      </QueryClientProvider>,
    );
    await screen.findByText('ONCE');
    expect(courseCalls()).toEqual([]);
  });

  it('an educator still loads their own courses', async () => {
    auth.user = { id: 'ed', role: 'educator' };
    await renderManager();
    await waitFor(() => expect(courseCalls()).toHaveLength(1));
  });

  it('picks the course by title and sends its id', async () => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) =>
      opts?.method ? {} : path === '/coupons' ? COUPONS : path.startsWith('/admin/courses?') ? [{ id: 'c1', title: 'Amharic 101', pricing_type: 'paid' }] : [],
    );
    await renderManager();
    fireEvent.change(screen.getByRole('combobox', { name: 'Course' }), { target: { value: 'am' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Amharic 101' }));
    submit();
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0][1].body.course_id).toBe('c1');
  });

  it('asks before deactivating; Cancel sends nothing, confirming deactivates', async () => {
    await renderManager();
    const deactivations = () => apiMock.mock.calls.filter((c) => c[0] === '/coupons/cp1/deactivate');
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]);
    const dialog = document.querySelector('dialog')!;
    expect(within(dialog).getByText('Deactivate ONCE?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(deactivations()).toEqual([]);

    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate code' }));
    await waitFor(() => expect(deactivations()).toHaveLength(1));
    expect(await screen.findByText('ONCE deactivated.')).toBeTruthy();
  });

  it('shows a failed deactivation as an error', async () => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/coupons/cp1/deactivate') throw new Error('Coupon not found');
      return opts?.method ? {} : path === '/coupons' ? COUPONS : [];
    });
    await renderManager();
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]);
    fireEvent.click(within(document.querySelector('dialog')!).getByRole('button', { name: 'Deactivate code' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((n) => n.textContent === 'Coupon not found')).toBe(true));
  });
});
