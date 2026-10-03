import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import { ResendVerification } from './ResendVerification';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMock }));

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const click = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
};

describe('<ResendVerification />', () => {
  it('shows the server message, then disables with a countdown until 60 s pass', async () => {
    apiMock.mockResolvedValue({ message: 'Sent, if it exists.' });
    render(<ResendVerification email="a@example.com" />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
    await click();
    expect(apiMock).toHaveBeenCalledWith('/auth/resend-verification', { method: 'POST', auth: false, body: { email: 'a@example.com' } });
    expect(screen.getByRole('status').textContent).toBe('Sent, if it exists.');
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Resend in 60 s');
    act(() => {
      vi.advanceTimersByTime(18_000);
    });
    expect(button.textContent).toBe('Resend in 42 s');
    act(() => {
      vi.advanceTimersByTime(42_000);
    });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Resend email');
  });

  it('starts cooled down when asked, and the countdown is not in a live region', () => {
    render(<ResendVerification email="a@example.com" startCooledDown />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Resend in 60 s');
    expect(button.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });

  it('shows a plain error for a 400 and for a 429, and does not start the cooldown', async () => {
    render(<ResendVerification email="nope" />);
    apiMock.mockRejectedValueOnce(new ApiError(400, 'email must be an email'));
    await click();
    expect(screen.getByRole('alert').textContent).toBe('Enter a valid email address.');
    apiMock.mockRejectedValueOnce(new ApiError(429, 'ThrottlerException'));
    await click();
    expect(screen.getByRole('alert').textContent).toBe('Too many requests. Wait a minute and try again.');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('any other failure (a 404 while auth deploys, a 500) is the plain "try again" line, not the raw message', async () => {
    render(<ResendVerification email="a@example.com" />);
    apiMock.mockRejectedValueOnce(new ApiError(404, 'Cannot POST /api/v1/auth/resend-verification'));
    await click();
    expect(screen.getByRole('alert').textContent).toBe("Couldn't send right now. Try again in a minute.");
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Internal server error'));
    await click();
    expect(screen.getByRole('alert').textContent).toBe("Couldn't send right now. Try again in a minute.");
  });
});
