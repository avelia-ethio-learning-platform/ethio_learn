import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { WalletCard } from './wallet-card';

const tx = (over: Record<string, unknown>) => ({
  id: 't1',
  amount_etb: 25,
  kind: 'cashback',
  note: 'Cashback on "Course"',
  reference: 'pay-1',
  state: 'available',
  available_at: null,
  created_at: '2026-10-01T10:00:00.000Z',
  ...over,
});

function setup(wallet: Record<string, unknown>) {
  apiMock.mockResolvedValue({ user_id: 'u1', balance_etb: 10, pending_etb: 0, transactions: [], cashback_percent: 5, referral_reward_etb: 50, ...wallet });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WalletCard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe('WalletCard pending credits', () => {
  it('shows the pending total under the balance only when there is one', async () => {
    setup({ pending_etb: 30 });
    expect(await screen.findByText('+30 ETB pending')).toBeTruthy();
    cleanup();
    setup({ pending_etb: 0 });
    await screen.findByText('10 ETB');
    expect(screen.queryByText(/pending/)).toBeNull();
  });

  it('labels a pending row with its available date', async () => {
    setup({ transactions: [tx({ state: 'pending', available_at: '2026-10-12T10:00:00.000Z' })] });
    expect(await screen.findByText('Available 12 Oct 2026')).toBeTruthy();
  });

  it('labels a void row as refunded with its amount muted and struck through, and leaves an available row unlabelled', async () => {
    setup({ transactions: [tx({ id: 't1', state: 'void' }), tx({ id: 't2', note: 'Wallet top-up', kind: 'topup' })] });
    expect(await screen.findByText('Refunded')).toBeTruthy();
    expect(screen.queryByText(/Available/)).toBeNull();
    const [voided, available] = screen.getAllByText('+25 ETB');
    expect(voided.className).toContain('line-through');
    expect(voided.className).not.toContain('text-emerald');
    expect(available.className).toContain('text-emerald-700');
  });
});
