import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

const { wakeServices } = vi.hoisted(() => ({ wakeServices: vi.fn() }));
vi.mock('@/lib/wake', () => ({ wakeServices }));

import { WakingError } from '@/lib/api';
import { makeQueryClient, WAKING_RETRY_MS } from '@/lib/query-client';
import { SLOW_NOTICE_MS, trackRequest } from '@/lib/waking';
import { WakingUpNotice } from './WakingUpNotice';

function renderNotice() {
  const client = makeQueryClient();
  render(
    <QueryClientProvider client={client}>
      <WakingUpNotice />
    </QueryClientProvider>,
  );
  return client;
}

const notice = () => screen.queryByText(/waking up the server/i);

beforeEach(() => {
  vi.useFakeTimers();
  wakeServices.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<WakingUpNotice />', () => {
  it('stays hidden for requests that settle within 4 s', async () => {
    renderNotice();
    const settle = trackRequest();
    await act(() => vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS - 1));
    act(() => settle());
    await act(() => vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS));
    expect(notice()).toBeNull();
    expect(wakeServices).not.toHaveBeenCalled();
  });

  it('shows after 4 s in a polite live region, wakes the services, and hides when the request settles', async () => {
    renderNotice();
    const settle = trackRequest();
    await act(() => vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS));
    expect(notice()).not.toBeNull();
    expect(notice()!.closest('[aria-live="polite"]')).not.toBeNull();
    expect(wakeServices).toHaveBeenCalledTimes(1);

    act(() => settle());
    expect(notice()).toBeNull();
  });

  it('shows while a query waits to retry a WakingError', async () => {
    const client = renderNotice();
    let asleep = true;
    const fn = vi.fn(async () => {
      if (asleep) throw new WakingError();
      return 'ok';
    });
    void client.fetchQuery({ queryKey: ['dashboard'], queryFn: fn });

    await act(() => vi.advanceTimersByTimeAsync(1)); // first try failed, retry pending
    expect(notice()).not.toBeNull();

    asleep = false;
    await act(() => vi.advanceTimersByTimeAsync(WAKING_RETRY_MS));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(notice()).toBeNull();
  });
});
