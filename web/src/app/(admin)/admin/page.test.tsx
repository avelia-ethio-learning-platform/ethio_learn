import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, nav } = vi.hoisted(() => ({ apiMock: vi.fn(), nav: { search: '', replace: vi.fn() } }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { id: 'me', name: 'Admin', email: 'admin@x.et', role: 'platform_admin' }, ready: true }) }));
vi.mock('@/components/RequireRole', () => ({ RequireRole: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/admin',
}));

import { ApiError } from '@/lib/api';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import AdminPage from './page';

const USER = { id: 'u1', name: 'Abebe', email: 'a@x.et', role: 'learner', status: 'active', email_verified: true };
const ME = { id: 'me', name: 'Admin', email: 'admin@x.et', role: 'platform_admin', status: 'active', email_verified: true };

/** Answers the reads every tab makes; a test's own answers (by path prefix) win. An Error is thrown. */
function respond(extra: Record<string, unknown> = {}) {
  apiMock.mockImplementation(async (path: string) => {
    for (const [prefix, value] of Object.entries(extra)) {
      if (path.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    if (path.startsWith('/admin/users?')) return { total: 1, items: [USER] };
    if (path === '/admin/analytics/financial') return { by_month: [], by_purpose: {}, by_course: [] };
    if (path === '/admin/enrollments/analytics') return { enrollments_by_month: [] };
    return {};
  });
}

beforeEach(() => {
  apiMock.mockReset();
  nav.replace.mockReset();
  respond();
});
afterEach(cleanup);

function renderAdmin(search = '') {
  nav.search = search;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <AdminPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

const dialog = () => document.querySelector('dialog')!;
const pressCancel = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
/** happy-dom doesn't turn Escape into `cancel`, so the test sends the event the browser would. */
const escape = () =>
  act(() => {
    dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
  });
const settle = () => act(async () => {});
const hasAlert = (text: string) => screen.getAllByRole('alert').some((n) => n.textContent === text);

async function openUsersTab() {
  renderAdmin('tab=users');
  await screen.findByText('Abebe');
}

const statusCalls = () => apiMock.mock.calls.filter((c) => c[0] === '/admin/users/u1/status');

describe('Admin tabs', () => {
  it('?tab=users opens Users', async () => {
    renderAdmin('tab=users');
    const users = screen.getByRole('tab', { name: 'Users' });
    expect(users.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(users.id);
    expect(await screen.findByText('Abebe')).toBeTruthy();
  });

  it('an unknown tab falls back to Analytics', () => {
    renderAdmin('tab=nope');
    expect(screen.getByRole('tab', { name: 'Analytics' }).getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowRight moves to and opens the next tab and writes it to the URL; Home and End jump', () => {
    renderAdmin();
    const analytics = screen.getByRole('tab', { name: 'Analytics' });
    expect(analytics.tabIndex).toBe(0);
    analytics.focus();
    fireEvent.keyDown(analytics, { key: 'ArrowRight' });
    const payments = screen.getByRole('tab', { name: 'Payments' });
    expect(payments.getAttribute('aria-selected')).toBe('true');
    expect(payments.tabIndex).toBe(0);
    expect(analytics.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(payments);
    expect(nav.replace).toHaveBeenLastCalledWith('?tab=payments', { scroll: false });

    fireEvent.keyDown(payments, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Announce' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Analytics' }).getAttribute('aria-selected')).toBe('true');
  });

  it('the tablist is named, and empty analytics lists say so', async () => {
    renderAdmin();
    expect(screen.getByRole('tablist', { name: 'Admin sections' })).toBeTruthy();
    expect(await screen.findByText('No confirmed payments yet.')).toBeTruthy();
    expect(screen.getByText('No course revenue yet.')).toBeTruthy();
  });
});

describe('Admin users: suspend and ban', () => {
  it('Cancel on the suspend dialog sends nothing', async () => {
    await openUsersTab();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(within(dialog()).getByText('Suspend Abebe?')).toBeTruthy();
    pressCancel();
    await settle();
    expect(statusCalls()).toEqual([]);
  });

  it('Escape on the ban dialog sends nothing', async () => {
    await openUsersTab();
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    expect(within(dialog()).getByText('Ban Abebe?')).toBeTruthy();
    escape();
    await settle();
    expect(statusCalls()).toEqual([]);
  });

  it('sends the reason typed in the dialog, or none when it is left empty', async () => {
    await openUsersTab();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    fireEvent.change(within(dialog()).getByLabelText('Reason (optional)'), { target: { value: ' spam ' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Suspend user' }));
    await waitFor(() => expect(statusCalls()).toEqual([['/admin/users/u1/status', { method: 'POST', body: { status: 'suspended', reason: 'spam' } }]]));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Ban' }).getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Ban user' }));
    await waitFor(() => expect(statusCalls()[1]).toEqual(['/admin/users/u1/status', { method: 'POST', body: { status: 'banned', reason: undefined } }]));
  });

  it('returns focus to the Suspend button after a confirmed suspend', async () => {
    await openUsersTab();
    const suspend = screen.getByRole('button', { name: 'Suspend' });
    suspend.focus();
    fireEvent.click(suspend);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Suspend user' }));
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    await waitFor(() => expect(suspend.getAttribute('aria-disabled')).toBe('false'));
    expect(document.activeElement).toBe(suspend);
  });

  it('shows a refusal as an error', async () => {
    await openUsersTab();
    respond({ '/admin/users/u1/status': new ApiError(400, 'Cannot change this account') });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Suspend user' }));
    await waitFor(() => expect(hasAlert('Cannot change this account')).toBe(true));
  });

  it('shows no Suspend or Ban on your own row, and marks it "You"', async () => {
    respond({ '/admin/users?': { total: 2, items: [ME, USER] } });
    renderAdmin('tab=users');
    const myRow = (await screen.findByText('You')).closest('div')!;
    expect(within(myRow).getByText('Admin')).toBeTruthy();
    expect(within(myRow).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Suspend' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Ban' })).toHaveLength(1);
  });

  it('pages past 20 rows', async () => {
    respond({ '/admin/users?': { total: 45, items: [USER] } });
    renderAdmin('tab=users');
    expect(await screen.findByText('Showing 1–20 of 45')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 21–40 of 45')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/admin/users?q=&page=2&limit=20');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search users' }), { target: { value: 'abebe' } });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/users?q=abebe&page=1&limit=20'));
    expect(apiMock).not.toHaveBeenCalledWith('/admin/users?q=abebe&page=2&limit=20');
  });
});

describe('Admin payouts', () => {
  const HELD = { id: 'po1', payee_type: 'educator', payee_id: 'c536c035-0000-4000-8000-000000000000', net_amount_etb: 1200, status: 'held', hold_reason: 'kyc_required' };

  it('the release dialog names the payee, the net amount and the hold reason; Cancel sends nothing', async () => {
    respond({ '/payouts': [HELD] });
    renderAdmin('tab=payouts');
    expect(await screen.findByText(/KYC required/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(within(dialog()).getByText('Release the payout to Educator · c536c035?')).toBeTruthy();
    expect(within(dialog()).getByText(/^Net .*1,200.*\. Held: KYC required\. Releasing clears any hold, KYC included, and pays it out now\.$/)).toBeTruthy();
    pressCancel();
    await settle();
    expect(apiMock.mock.calls.filter((c) => c[0] === '/payouts/po1/release')).toEqual([]);
  });

  it('releases after "Release payout" and says so', async () => {
    respond({ '/payouts': [HELD] });
    renderAdmin('tab=payouts');
    fireEvent.click(await screen.findByRole('button', { name: 'Release' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release payout' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/payouts/po1/release', { method: 'POST' }));
    expect(await screen.findByText('Payout to Educator · c536c035 released.')).toBeTruthy();
  });

  it('asks before a payout run; Escape sends nothing', async () => {
    respond({ '/payouts': [] });
    renderAdmin('tab=payouts');
    fireEvent.click(screen.getByRole('button', { name: 'Run payouts now' }));
    expect(within(dialog()).getByText('Pay every eligible educator and institution now?')).toBeTruthy();
    escape();
    await settle();
    expect(apiMock.mock.calls.filter((c) => c[0] === '/payouts/run')).toEqual([]);
  });
});

describe('Admin fraud: resolve', () => {
  it('names the signal and subject and says what resolving does', async () => {
    respond({ '/fraud/flags': [{ id: 'f1', signal_type: 'refund_abuse', subject_type: 'user', subject_id: 'abcdef12-0000-4000-8000-000000000000', detail: '3 refunds' }] });
    renderAdmin('tab=fraud');
    expect(await screen.findByText('Repeated refunds')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(within(dialog()).getByText('Resolve “Repeated refunds on user abcdef12”?')).toBeTruthy();
    expect(
      within(dialog()).getByText(
        'Clears this flag. Payouts held for fraud go out once this payee has no open flags. Payouts over the KYC limit still wait for KYC.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Resolve flag' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/fraud/flags/f1/resolve', { method: 'POST' }));
  });
});

describe('Admin payments: record a bank transfer', () => {
  const transferCalls = () => apiMock.mock.calls.filter((c) => c[0] === '/admin/payments/bank-transfer');

  /** Opens the Payments tab and picks the learner and the course. */
  async function pickLearnerAndCourse(extra: Record<string, unknown> = {}) {
    respond({ '/admin/courses?': [{ id: 'c1', title: 'Amharic 101', status: 'published' }], '/admin/payments?': { total: 0, items: [] }, ...extra });
    renderAdmin('tab=payments');
    fireEvent.change(screen.getByRole('combobox', { name: 'Learner' }), { target: { value: 'ab' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Abebe (a@x.et)' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Course' }), { target: { value: 'am' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Amharic 101 (Published)' }));
  }

  it('searches learners on the server', async () => {
    await pickLearnerAndCourse();
    expect(apiMock).toHaveBeenCalledWith('/admin/users?q=ab&role=learner');
  });

  it('needs a bank reference before it can be marked', async () => {
    await pickLearnerAndCourse();
    const mark = screen.getByRole('button', { name: 'Mark bank transfer' }) as HTMLButtonElement;
    const reference = screen.getByLabelText('Bank reference') as HTMLInputElement;
    expect(reference.required).toBe(true);
    expect(mark.disabled).toBe(true);
    fireEvent.change(reference, { target: { value: '   ' } });
    expect(mark.disabled).toBe(true);
    fireEvent.change(reference, { target: { value: 'FT-1' } });
    expect(mark.disabled).toBe(false);
  });

  it('asks first, naming the learner, course and reference, then sends them', async () => {
    await pickLearnerAndCourse();
    fireEvent.change(screen.getByLabelText('Bank reference'), { target: { value: ' FT24123ABC ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark bank transfer' }));
    expect(within(dialog()).getByText('Abebe (a@x.et) gets Amharic 101 (Published), bank reference FT24123ABC. This grants access now.')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as paid' }));
    await waitFor(() =>
      expect(transferCalls()).toEqual([['/admin/payments/bank-transfer', { method: 'POST', body: { learner_id: 'u1', course_id: 'c1', bank_reference: 'FT24123ABC' } }]]),
    );
    expect(await screen.findByText('Bank transfer recorded. Abebe (a@x.et) has access to Amharic 101 (Published) now.')).toBeTruthy();
  });

  it('Cancel sends nothing', async () => {
    await pickLearnerAndCourse();
    fireEvent.change(screen.getByLabelText('Bank reference'), { target: { value: 'FT-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark bank transfer' }));
    pressCancel();
    await settle();
    expect(transferCalls()).toEqual([]);
  });

  it.each([
    [409, 'This learner already owns the course'],
    [503, "Couldn't check enrollment. Try again."],
  ])('shows a %s refusal as an error', async (status, message) => {
    await pickLearnerAndCourse({ '/admin/payments/bank-transfer': new ApiError(status, message) });
    fireEvent.change(screen.getByLabelText('Bank reference'), { target: { value: 'FT-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark bank transfer' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark as paid' }));
    await waitFor(() => expect(hasAlert(message)).toBe(true));
  });
});

describe('Admin refunds: decide', () => {
  it('the approve dialog names the course, the amount and the reason; a refusal shows as an error', async () => {
    const message = 'This payment has already been paid out to the educator. Contact support from Help to request a refund.';
    respond({
      '/refunds/pending': [{ id: 'r1', reason: 'Not what I expected', amount_etb: '500.00', course_title: 'Amharic 101' }],
      '/refunds/r1/decide': new ApiError(400, message),
    });
    renderAdmin('tab=refunds');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(within(dialog()).getByText('Approve the refund for Amharic 101?')).toBeTruthy();
    expect(within(dialog()).getByText(/500.* goes back to the learner\. Learner's reason: “Not what I expected”/)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Approve refund' }));
    await waitFor(() => expect(hasAlert(message)).toBe(true));
    expect(apiMock).toHaveBeenCalledWith('/refunds/r1/decide', { method: 'POST', body: { action: 'approve' } });
  });

  it('leaves out a missing course and amount', async () => {
    respond({ '/refunds/pending': [{ id: 'r1', reason: 'Changed my mind', amount_etb: null, course_title: null }] });
    renderAdmin('tab=refunds');
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(within(dialog()).getByText('Deny this refund?')).toBeTruthy();
    expect(within(dialog()).getByText('Learner\'s reason: “Changed my mind”')).toBeTruthy();
  });
});
