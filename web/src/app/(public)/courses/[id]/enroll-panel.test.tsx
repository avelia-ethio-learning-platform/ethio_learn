import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'learner' }, ready: true }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { EnrollPanel } from './enroll-panel';

function setup() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <EnrollPanel courseId="c1" pricingType="paid" price={300} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/enrollments/status')) return { entitlement_status: 'none' };
    if (path === '/wallet') return { balance_etb: 0 };
    throw new Error('Coupon not found');
  });
});
afterEach(cleanup);

describe('Enroll panel', () => {
  it('labels the coupon field and announces a rejected coupon on it', async () => {
    setup();
    const coupon = await screen.findByLabelText('Coupon code');
    fireEvent.change(coupon, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    const alert = await screen.findByText('Coupon not found');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(coupon.getAttribute('aria-invalid')).toBe('true');
  });

  it('labels the gift form and announces a failed gift as an alert', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Gift it' }));
    const email = screen.getByLabelText("Recipient's email");
    expect(screen.getByLabelText('Message (optional)')).toBeTruthy();
    fireEvent.change(email, { target: { value: 'friend@x.et' } });
    fireEvent.submit(email.closest('form')!);
    const form = email.closest('form')!;
    await waitFor(() => expect(within(form).getByRole('alert').textContent).not.toBe(''));
  });

  it('puts a sent payment request in the polite status region', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/enrollments/status')) return { entitlement_status: 'none' };
      if (path === '/wallet') return { balance_etb: 0 };
      return { pay_url: 'https://x.et/pay/t' };
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask someone to pay' }));
    const email = screen.getByLabelText('Their email');
    fireEvent.change(email, { target: { value: 'mum@x.et' } });
    fireEvent.submit(email.closest('form')!);
    const ok = await screen.findByText(/Request sent/);
    expect(ok.closest('[role="status"]')).not.toBeNull();
  });
});
