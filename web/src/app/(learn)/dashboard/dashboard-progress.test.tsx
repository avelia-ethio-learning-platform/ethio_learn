import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

const ENROLLMENT = { id: 'e1', course_id: 'c1', course_title: 'Intro to Farming', entitlement_status: 'active', completed_at: null };
let enrollments: unknown[] = [];

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/enrollments') return enrollments;
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

describe('Learner dashboard progress', () => {
  it('shows the percentage the API sent', async () => {
    enrollments = [{ ...ENROLLMENT, progress_percent: 40 }];
    renderPage();
    expect(await screen.findByText('40% complete')).toBeTruthy();
  });

  it('shows "—", not 0%, when progress could not be read (null)', async () => {
    enrollments = [{ ...ENROLLMENT, progress_percent: null }];
    renderPage();
    expect(await screen.findByText('— complete')).toBeTruthy();
    expect(screen.queryByText(/0% complete/)).toBeNull();
  });
});
