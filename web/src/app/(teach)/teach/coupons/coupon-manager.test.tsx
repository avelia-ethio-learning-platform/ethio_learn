import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { id: 'adm', role: 'platform_admin' } }) }));

import { CouponManager } from './coupon-manager';

const COUPONS = [
  { id: 'cp1', code: 'ONCE', kind: 'percent', value: 20, course_id: null, uses: 3, max_uses: 50, max_uses_per_user: 1, expires_at: null, active: true, note: '' },
  { id: 'cp2', code: 'OPEN', kind: 'amount', value: 100, course_id: null, uses: 0, max_uses: null, max_uses_per_user: null, expires_at: null, active: true, note: '' },
];

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => (opts?.method ? {} : path === '/coupons' ? COUPONS : []));
});
afterEach(cleanup);

async function renderManager() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CouponManager />
    </QueryClientProvider>,
  );
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
    expect(screen.queryAllByText(/per learner/)).toHaveLength(1);
  });
});
