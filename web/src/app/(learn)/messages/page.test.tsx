import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { id: 'me', role: 'learner' }, ready: true }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

import MessagesPage from './page';

const THREAD = { thread_id: 't1', peer: { id: 'p1', name: 'Selam', role: 'educator' }, last_preview: 'Newest', last_message_at: null, unread: 0 };
const msg = (id: string, body: string, created_at: string) => ({ id, sender_id: 'p1', mine: false, body, created_at });
let latest: { thread: typeof THREAD; messages: ReturnType<typeof msg>[]; has_more?: boolean };

beforeEach(() => {
  apiMock.mockReset();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/messages/threads') return [THREAD];
    if (path === '/messages/threads/t1') return latest;
    if (path === '/messages/threads/t1?before=m2') return { thread: THREAD, messages: [msg('m1', 'Oldest', '2026-10-01T09:00:00Z')], has_more: false };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MessagesPage />
    </QueryClientProvider>,
  );
}

describe('Messages: load earlier', () => {
  it('prepends the page before the oldest message shown, then hides the button', async () => {
    latest = { thread: THREAD, messages: [msg('m2', 'Middle', '2026-10-01T10:00:00Z'), msg('m3', 'Newest', '2026-10-01T11:00:00Z')], has_more: true };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Selam/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText('Oldest')).toBeTruthy();
    const bodies = Array.from(document.querySelectorAll('p.whitespace-pre-wrap')).map((p) => p.textContent);
    expect(bodies).toEqual(['Oldest', 'Middle', 'Newest']);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull());
  });

  it('keeps a message that drops off the live page after loading earlier ones', async () => {
    latest = { thread: THREAD, messages: [msg('m2', 'Middle', '2026-10-01T10:00:00Z'), msg('m3', 'Newest', '2026-10-01T11:00:00Z')], has_more: true };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Selam/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText('Oldest')).toBeTruthy();
    // A new message arrives; the live page (4 s refetch) no longer holds m2.
    latest = { thread: THREAD, messages: [msg('m3', 'Newest', '2026-10-01T11:00:00Z'), msg('m4', 'Brand new', '2026-10-01T12:00:00Z')], has_more: true };
    expect(await screen.findByText('Brand new', {}, { timeout: 6000 })).toBeTruthy();
    const bodies = Array.from(document.querySelectorAll('p.whitespace-pre-wrap')).map((p) => p.textContent);
    expect(bodies).toEqual(['Oldest', 'Middle', 'Newest', 'Brand new']);
  }, 10_000);

  it('offers nothing earlier when the API sends no has_more', async () => {
    latest = { thread: THREAD, messages: [msg('m3', 'Newest', '2026-10-01T11:00:00Z')] };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Selam/ }));
    expect(await screen.findByText('Newest', { selector: 'p.whitespace-pre-wrap' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });
});
