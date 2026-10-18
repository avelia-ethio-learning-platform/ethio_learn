import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import PaymentReturnPage from './page';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks.api }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('course_id=c1&tx_ref=tx1') }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.api.mockReset();
});

describe('payment return', () => {
  it('moves from polling to active, fading the new state in and focusing "Start learning"', async () => {
    let status = 'pending';
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/payments/reconcile') return { status };
      return { entitlement_status: 'none' };
    });
    render(<PaymentReturnPage />);
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/confirm/i);
    expect(screen.queryByRole('link', { name: /start learning/i })).toBeNull();

    status = 'confirmed';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    const start = screen.getByRole('link', { name: /start learning/i });
    expect(document.activeElement).toBe(start);
    expect(start.parentElement!.className).toContain('fade-in');
  });
});
