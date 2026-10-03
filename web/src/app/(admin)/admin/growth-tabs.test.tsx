import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatETB } from '@/lib/format';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { AnalyticsTab } from './growth-tabs';

const FIN = {
  total_gross_etb: 1000,
  total_net_etb: 800,
  payment_count: 4,
  pending_count: 0,
  failed_count: 0,
  coupon_discount_total_etb: 0,
  wallet: { outstanding_balance_etb: 50, pending_rewards_etb: 125 },
  by_month: [],
  by_purpose: {},
  by_course: [],
};
const ENR = { active: 0, completed: 0, distinct_learners: 0, active_last_7d: 0, sponsored: 0, enrollments_by_month: [] };

afterEach(cleanup);

function renderTab() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AnalyticsTab />
    </QueryClientProvider>,
  );
}

/** The value shown on the tile with this label. */
const tileValue = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('Admin analytics: Pending rewards tile', () => {
  it('shows the pending cashback and referral rewards from the financial analytics', async () => {
    apiMock.mockImplementation(async (path: string) => (path === '/admin/analytics/financial' ? FIN : ENR));
    renderTab();
    await screen.findByText('Revenue by month (ETB)');
    await vi.waitFor(() => expect(tileValue('Pending rewards')).toBe(formatETB(125, 'en')));
    expect(screen.getByText('cashback and referral rewards not yet spendable')).toBeTruthy();
  });

  it('shows zero while the analytics have no wallet figures', async () => {
    apiMock.mockImplementation(async (path: string) => (path === '/admin/analytics/financial' ? { ...FIN, wallet: undefined } : ENR));
    renderTab();
    await vi.waitFor(() => expect(tileValue('Pending rewards')).toBe(formatETB(0, 'en')));
  });
});
