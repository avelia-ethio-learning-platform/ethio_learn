import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import PaymentReturnPage from './page';

const mocks = vi.hoisted(() => ({ api: vi.fn(), search: 'course_id=c1&tx_ref=tx1' }));
vi.mock('@/lib/api', () => ({ api: mocks.api }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.api.mockReset();
  mocks.search = 'course_id=c1&tx_ref=tx1';
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

  it('does not take focus from a control the learner is using elsewhere', async () => {
    let status = 'pending';
    mocks.api.mockImplementation(async (path: string) => (path === '/payments/reconcile' ? { status } : { entitlement_status: 'none' }));
    const other = document.body.appendChild(document.createElement('button'));
    render(<PaymentReturnPage />);
    await act(async () => {});
    other.focus();
    status = 'confirmed';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByRole('link', { name: /start learning/i })).toBeTruthy();
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it.each([
    ['confirmed', "You're in!"],
    ['failed', 'Payment not completed'],
  ])('after the 30 s timeout, "Check again" shows a %s payment', async (later, title) => {
    let status = 'pending';
    mocks.api.mockImplementation(async (path: string) => (path === '/payments/reconcile' ? { status } : { entitlement_status: 'none' }));
    render(<PaymentReturnPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 2500);
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Still processing');

    status = later;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
  });

  it('"Check again" goes back to the timeout state while the payment is still pending', async () => {
    mocks.api.mockImplementation(async (path: string) => (path === '/payments/reconcile' ? { status: 'pending' } : { entitlement_status: 'none' }));
    render(<PaymentReturnPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 2500);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Still processing');
  });

  it('without a course or tx_ref says there is nothing to confirm and links to the dashboard, instead of spinning (P2-02)', async () => {
    mocks.search = '';
    render(<PaymentReturnPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nothing to confirm');
    expect(screen.getByRole('link', { name: /go to dashboard/i }).getAttribute('href')).toBe('/dashboard');
    expect(document.querySelector('.animate-spin')).toBeNull();
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
