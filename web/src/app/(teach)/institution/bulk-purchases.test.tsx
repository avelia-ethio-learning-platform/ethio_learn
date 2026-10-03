import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { BulkPurchases } from './bulk-purchases';

const ORDER = { id: 'o1', course_title: 'Safety 101', seats: 10, seats_assigned: 0, total_etb: 1000, status: 'active', created_at: '2026-10-01T00:00:00Z', assignments: [] };

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/bulk-purchases/mine') return [ORDER];
    if (path === '/wallet') return { balance_etb: 0 };
    return { assigned: 2, results: [] };
  });
});
afterEach(cleanup);

const dialog = () => document.querySelector('dialog')!;
const assignCalls = () => apiMock.mock.calls.filter((c) => c[0] === '/bulk-purchases/o1/assign');

async function typeEmails(value: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <BulkPurchases organizationName="Acme" />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByLabelText('Staff emails'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: /Assign seats/ }));
}

describe('BulkPurchases assign dialog', () => {
  it('lists the de-duplicated emails, and Cancel sends nothing', async () => {
    await typeEmails('a@x.et, B@x.et A@x.et');
    const d = within(dialog());
    expect(d.getByText('Assign 2 seats of Safety 101?')).toBeTruthy();
    expect(dialog().textContent).toContain('a@x.et, b@x.et');
    expect(dialog().textContent).toContain("Assigned seats can't be moved to someone else.");
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(assignCalls()).toEqual([]);
  });

  it('sends the de-duplicated list once confirmed', async () => {
    await typeEmails('a@x.et a@x.et');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Assign seats' }));
    await screen.findByText(/seat assigned|seats assigned/);
    expect(assignCalls()).toEqual([['/bulk-purchases/o1/assign', { method: 'POST', body: { emails: ['a@x.et'] } }]]);
  });
});
