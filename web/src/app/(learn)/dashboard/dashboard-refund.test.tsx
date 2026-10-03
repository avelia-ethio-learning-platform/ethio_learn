import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/PendingInvitesBanner', () => ({ PendingInvitesBanner: () => null }));
vi.mock('./wallet-card', () => ({ WalletCard: () => null }));

import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import DashboardPage from './page';

const PAYMENT = { id: 'pay1', course_title: 'Intro to Farming', amount_etb: 300, discount_etb: 0, status: 'confirmed', purpose: 'course', method: 'chapa' };
const dialog = () => document.querySelector('dialog') as HTMLDialogElement;
const refundPosts = () => apiMock.mock.calls.filter((c) => c[0] === '/refunds' && c[1]?.method === 'POST');
let refundResult: () => Promise<unknown>;

beforeEach(() => {
  apiMock.mockReset();
  refundResult = async () => ({ status: 'pending', rule: '' });
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/payments/mine') return [PAYMENT];
    if (path === '/refunds' && opts?.method === 'POST') return refundResult();
    if (path === '/sponsorships/claim') return { claimed: 0 };
    if (path === '/sponsorships/mine') return { sent: [], received: [] };
    if (path === '/referrals/me') return {};
    return [];
  });
});
afterEach(cleanup);

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <DashboardPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe('Learner dashboard refund', () => {
  it('asks with the course and amount, needs a reason of 5+ characters, and Cancel sends nothing', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refund' }));
    expect(within(dialog()).getByText('Request a refund for Intro to Farming?')).toBeTruthy();
    expect(within(dialog()).getByText(/You paid .*300/)).toBeTruthy();
    const submit = within(dialog()).getByRole('button', { name: 'Request refund' }) as HTMLButtonElement;
    fireEvent.change(within(dialog()).getByLabelText('Why do you want a refund?'), { target: { value: ' abc ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog().open).toBe(false));
    expect(refundPosts()).toEqual([]);
  });

  it('sends the trimmed reason and reports the outcome politely', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refund' }));
    fireEvent.change(within(dialog()).getByLabelText('Why do you want a refund?'), { target: { value: '  Wrong course  ' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Request refund' }));
    await waitFor(() => expect(refundPosts()).toEqual([['/refunds', { method: 'POST', body: { payment_id: 'pay1', reason: 'Wrong course' } }]]));
    const ok = await screen.findByText(/Refund request for Intro to Farming/);
    expect(ok.closest('[role="status"]')).not.toBeNull();
  });

  it('shows a refusal as an error', async () => {
    refundResult = async () => {
      throw new Error('Refund window closed');
    };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Refund' }));
    fireEvent.change(within(dialog()).getByLabelText('Why do you want a refund?'), { target: { value: 'Wrong course' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Request refund' }));
    const err = await screen.findByText('Refund window closed');
    expect(err.closest('[role="alert"]')).not.toBeNull();
  });
});
