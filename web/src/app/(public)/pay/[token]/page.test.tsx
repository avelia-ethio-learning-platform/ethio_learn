import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

const { apiMock, wakeServices } = vi.hoisted(() => ({ apiMock: vi.fn(), wakeServices: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/wake', () => ({ wakeServices }));
let auth: { user: { id: string; role: string } | null; ready: boolean } = { user: null, ready: true };
vi.mock('@/lib/hooks', () => ({ useAuth: () => auth }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 't1' }),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { ApiError, WakingError } from '@/lib/api';
import { makeQueryClient, WAKING_RETRY_MS } from '@/lib/query-client';
import PayRequestPage from './page';

const request = {
  token: 't1',
  status: 'pending',
  course_id: 'c1',
  course_title: 'Bookkeeping Basics',
  price_etb: 300,
  requester_name: 'Abebe',
  message: '',
};

function renderPage() {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <PayRequestPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  auth = { user: null, ready: true };
  apiMock.mockReset();
  wakeServices.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Pay-request page', () => {
  it('a dead link (404) says so at once, without retrying', async () => {
    apiMock.mockRejectedValue(new ApiError(404, 'Request not found'));
    renderPage();
    expect(await screen.findByText('Request not found')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('while the services wake, it keeps loading and then shows the request', async () => {
    apiMock.mockRejectedValueOnce(new WakingError()).mockResolvedValue(request);
    renderPage();
    expect(await screen.findByText('Loading request…')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(WAKING_RETRY_MS);
    expect(await screen.findByText('Abebe is asking for your help')).toBeTruthy();
    expect(screen.queryByText('Request not found')).toBeNull();
  });

  it('still asleep after 90 s: says the server is waking up, not that the link is dead, and Retry fetches again', async () => {
    apiMock.mockRejectedValue(new WakingError());
    renderPage();
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await screen.findByRole('status')).textContent).toMatch(/waking up the server/i);
    expect(screen.queryByText('Request not found')).toBeNull();
    expect(apiMock).toHaveBeenCalledTimes(10);

    apiMock.mockResolvedValue(request);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Abebe is asking for your help')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(11);
  });

  it.each([
    [500, 'Internal server error'],
    [429, 'Too many requests'],
  ])('a %i is not a dead link either', async (status, message) => {
    apiMock.mockRejectedValue(new ApiError(status, message));
    renderPage();
    expect((await screen.findByRole('status')).textContent).toMatch(/waking up the server/i);
    expect(screen.queryByText('Request not found')).toBeNull();
  });

  it('a failed payment is announced as an alert', async () => {
    auth = { user: { id: 'u2', role: 'learner' }, ready: true };
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') throw new Error('Chapa is unavailable right now');
      if (path === '/wallet') return { balance_etb: 0 };
      return request;
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /with Chapa/ }));
    const alert = screen.getByRole('alert');
    await vi.waitFor(() => expect(alert.textContent).toBe('Chapa is unavailable right now'));
    expect(alert.querySelector('.badge-danger')).not.toBeNull();
  });
});
