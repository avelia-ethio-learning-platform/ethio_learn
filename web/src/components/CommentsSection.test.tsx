import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: null, ready: true }) }));

import { CommentsSection, normalizeComments } from './CommentsSection';

const row = (id: string, body: string, created_at: string, parent_id: string | null = null) => ({
  id,
  parent_id,
  author_id: 'u1',
  author_name: 'Abebe',
  author_role: 'learner',
  body,
  deleted: false,
  created_at,
});
const NEW = row('c2', 'Newest question', '2026-10-02T10:00:00Z');
const REPLY = row('c3', 'A reply', '2026-10-02T11:00:00Z', 'c2');
const OLD = row('c1', 'Older question', '2026-10-01T10:00:00Z');

let firstPage: unknown;

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/courses/k1/comments?paged=1') return firstPage;
    if (path === '/courses/k1/comments?before=c2') return { items: [OLD], has_more: false };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

function renderComments() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CommentsSection courseId="k1" />
    </QueryClientProvider>,
  );
}

describe('CommentsSection', () => {
  it('normalizes a bare array (an older API or a cached response) and the paged object', () => {
    expect(normalizeComments([NEW])).toEqual({ items: [NEW], has_more: false });
    expect(normalizeComments({ items: [NEW], has_more: true })).toEqual({ items: [NEW], has_more: true });
  });

  it('renders a bare array with no "Load earlier"', async () => {
    firstPage = [NEW, REPLY];
    renderComments();
    expect(await screen.findByText('Newest question')).toBeTruthy();
    expect(screen.getByText('A reply')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load earlier comments' })).toBeNull();
  });

  it('loads earlier discussions before the oldest one shown, then hides the button', async () => {
    firstPage = { items: [NEW, REPLY], has_more: true };
    renderComments();
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier comments' }));
    expect(await screen.findByText('Older question')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/courses/k1/comments?before=c2', { auth: false });
    expect(screen.getByText('Newest question')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load earlier comments' })).toBeNull());
  });
});
