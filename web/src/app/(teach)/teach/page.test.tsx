import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/PendingInvitesBanner', () => ({ PendingInvitesBanner: () => null }));

import TeachPage from './page';

const payout = (i: number) => ({ id: `po${i}`, created_at: '2026-10-01T00:00:00Z', net_amount_etb: 80, gross_amount_etb: 100, status: 'paid', hold_reason: null });

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/payouts/balance') return { pending_net_etb: 0, payment_count: 0, paid_payout_count: 45 };
    if (path.startsWith('/payouts?')) return { items: Array.from({ length: 20 }, (_, i) => payout(i)), total: 45 };
    if (path === '/profiles/me') return {};
    return [];
  });
});
afterEach(cleanup);

describe('Teacher home payouts', () => {
  it('counts every paid payout from the API, not the 20 on the page, and pages older ones', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TeachPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('45')).toBeTruthy();
    expect(await screen.findByText('Showing 1–20 of 45')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/payouts?paged=1&page=2&limit=20'));
  });
});
