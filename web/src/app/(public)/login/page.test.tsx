import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import LoginPage from './page';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/GoogleSignInButton', () => ({ GoogleSignInButton: () => null }));

beforeEach(() => apiMock.mockReset());
afterEach(cleanup);

const submitLogin = async (message: string) => {
  apiMock.mockRejectedValueOnce(new ApiError(401, message));
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  await screen.findByText(message);
};

describe('login page resend link', () => {
  it('offers "Resend verification email" for the unverified error, with the typed email', async () => {
    await submitLogin('Email not verified. Check your inbox for the link.');
    apiMock.mockResolvedValueOnce({ message: 'ok' });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenLastCalledWith('/auth/resend-verification', { method: 'POST', auth: false, body: { email: 'a@example.com' } }),
    );
  });

  it('does not offer it for a wrong password', async () => {
    await submitLogin('Invalid credentials');
    expect(screen.queryByRole('button', { name: 'Resend verification email' })).toBeNull();
  });
});
