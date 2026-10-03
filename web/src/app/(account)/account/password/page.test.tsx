import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiMock, push, setAuthMock, state } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  push: vi.fn(),
  setAuthMock: vi.fn(),
  state: { search: '', user: { id: 'u1', role: 'learner', must_change_password: false } },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
  setAuth: (...args: unknown[]) => setAuthMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

import ChangePasswordPage from './page';

const OLD = 'Strong-passw0rd';
const NEW = 'Another-passw0rd';
const session = { access_token: 'fresh-access', user: { id: 'u1', role: 'learner', must_change_password: false } };

function serve(hasPassword: boolean) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/profiles/me') return { has_password: hasPassword };
    return session;
  });
}

beforeEach(() => {
  apiMock.mockReset();
  push.mockReset();
  setAuthMock.mockReset();
  state.search = '';
  state.user = { id: 'u1', role: 'learner', must_change_password: false };
});
afterEach(cleanup);

describe('Change password page', () => {
  it('asks for the current password when the account has one', async () => {
    serve(true);
    render(<ChangePasswordPage />);
    expect(await screen.findByLabelText('Current password')).toHaveProperty('autocomplete', 'current-password');
    expect(screen.getByLabelText('New password')).toHaveProperty('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm new password')).toBeTruthy();
  });

  it('hides the current password for a Google-only account', async () => {
    serve(false);
    render(<ChangePasswordPage />);
    await screen.findByLabelText('Confirm new password');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/profiles/me'));
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });

  it('hides the current password on the first-login path', async () => {
    state.search = 'first=1';
    serve(true);
    render(<ChangePasswordPage />);
    await screen.findByLabelText('Confirm new password');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/profiles/me'));
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });

  it('blocks a mismatch without calling the server', async () => {
    serve(true);
    render(<ChangePasswordPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: OLD } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: `${NEW}x` } });
    fireEvent.click(screen.getByRole('button', { name: /save password/i }));
    expect(await screen.findByText('The new passwords do not match.')).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalledWith('/profiles/password', expect.anything());
  });

  it('sends the current password, stores the fresh session and leaves', async () => {
    serve(true);
    render(<ChangePasswordPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: OLD } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: NEW } });
    fireEvent.click(screen.getByRole('button', { name: /save password/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(apiMock).toHaveBeenCalledWith('/profiles/password', {
      method: 'PUT',
      body: { current_password: OLD, new_password: NEW },
    });
    expect(setAuthMock).toHaveBeenCalledWith({ access_token: 'fresh-access', user: session.user });
  });

  it('first login sends only the new password and lands where it did before', async () => {
    state.search = 'first=1';
    state.user = { id: 'u1', role: 'learner', must_change_password: true };
    serve(true);
    render(<ChangePasswordPage />);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: NEW } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: NEW } });
    fireEvent.click(screen.getByRole('button', { name: /save password/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(apiMock).toHaveBeenCalledWith('/profiles/password', { method: 'PUT', body: { new_password: NEW } });
  });

  it('shows the server message inline when the current password is wrong', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/profiles/me') return { has_password: true };
      throw new Error('Current password is incorrect.');
    });
    render(<ChangePasswordPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'Wrong-passw0rd' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: NEW } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: NEW } });
    fireEvent.click(screen.getByRole('button', { name: /save password/i }));
    expect(await screen.findByText('Current password is incorrect.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
  it.each([
    ['/profiles/me fails', ''],
    ['the first-login flag is set by hand', 'first=1'],
  ])('reveals the current-password field when the server asks for it (%s)', async (_label, search) => {
    state.search = search;
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/profiles/me') throw new Error('Service waking up');
      throw new Error('Current password is required.');
    });
    render(<ChangePasswordPage />);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: NEW } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: NEW } });
    expect(screen.queryByLabelText('Current password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /save password/i }));
    expect(await screen.findByText('Current password is required.')).toBeTruthy();
    expect(await screen.findByLabelText('Current password')).toBeTruthy();
  });
});
