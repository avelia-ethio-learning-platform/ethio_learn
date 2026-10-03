import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
  setAuth: vi.fn(),
}));
vi.mock('@/components/GoogleSignInButton', () => ({ GoogleSignInButton: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import LoginPage from './login/page';
import SignupPage from './signup/page';
import ResetPasswordPage from './reset-password/page';

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

describe('Auth forms', () => {
  it('login: fields have labels, names stay, and a failure is announced as an alert', async () => {
    apiMock.mockImplementation(async (path: string) => {
      throw new Error('Invalid email or password');
    });
    render(<LoginPage />);
    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    expect(email.getAttribute('name')).toBe('email');
    expect(password.getAttribute('name')).toBe('password');
    fireEvent.change(email, { target: { value: 'a@b.et' } });
    fireEvent.change(password, { target: { value: 'x' } });
    fireEvent.submit(email.closest('form')!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid email or password'));
  });

  it('signup: every control is labelled and a weak password is announced on its field', async () => {
    render(<SignupPage />);
    expect(screen.getByLabelText('Full name').getAttribute('name')).toBe('name');
    expect(screen.getByLabelText('Email').getAttribute('name')).toBe('email');
    expect(screen.getByLabelText('I am joining as').getAttribute('name')).toBe('role');
    const password = screen.getByLabelText(/^Password/);
    fireEvent.change(password, { target: { value: 'aaaaaaaa' } });
    fireEvent.submit(password.closest('form')!);
    const alert = await screen.findByText(/at least 3 of/);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(password.getAttribute('aria-invalid')).toBe('true');
  });

  it('signup: a weak password after a server error clears the stale server error', async () => {
    apiMock.mockRejectedValue(new Error('That email is already registered'));
    render(<SignupPage />);
    const password = screen.getByLabelText(/^Password/);
    fireEvent.change(password, { target: { value: 'Strong-passw0rd' } });
    fireEvent.submit(password.closest('form')!);
    expect(await screen.findByText('That email is already registered')).toBeTruthy();

    fireEvent.change(password, { target: { value: 'aaaaaaaa' } });
    fireEvent.submit(password.closest('form')!);
    expect(await screen.findByText(/at least 3 of/)).toBeTruthy();
    expect(screen.queryByText('That email is already registered')).toBeNull();
  });

  it('reset password: a success lands in the polite status region, not an alert', async () => {
    apiMock.mockResolvedValue({ message: 'If that account exists, a link is on its way.' });
    render(<ResetPasswordPage />);
    const email = screen.getByLabelText('Account email');
    fireEvent.change(email, { target: { value: 'a@b.et' } });
    fireEvent.submit(email.closest('form')!);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('a link is on its way'));
    expect(screen.getByRole('alert').textContent).toBe('');
  });
});
