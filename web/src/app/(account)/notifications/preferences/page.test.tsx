import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'learner' }, ready: true }) }));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/BackButton', () => ({ BackButton: () => null }));

import NotificationPreferencesPage from './page';

const prefs = {
  new_course_categories: ['business'],
  new_course_instructor_ids: [],
  new_course_email: true,
  new_course_in_app: true,
  course_updates_email: true,
  progress_emails: true,
  inactivity_emails: true,
};

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (_path: string, opts?: { method?: string }) => (opts?.method === 'PUT' ? {} : prefs));
});
afterEach(cleanup);

describe('Notification preferences', () => {
  it('announces a save in the polite status region, as a success, and clears it on the next change', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NotificationPreferencesPage />
      </QueryClientProvider>,
    );
    const status = screen.getByRole('status');
    const save = screen.getByRole('button', { name: 'Save preferences' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(status.textContent).toBe('Preferences saved.'));
    expect(status.querySelector('.badge-success')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Email/ }));
    expect(status.textContent).toBe('');
  });
});
