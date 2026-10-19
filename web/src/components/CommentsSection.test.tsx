import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
const auth = vi.hoisted(() => ({ user: null as { id: string; role: string } | null }));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: auth.user, ready: true }) }));

import { CommentsSection } from './CommentsSection';

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
  auth.user = null;
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/courses/k1/comments?paged=1') return firstPage;
    if (path === '/courses/k1/comments?before=c2') return { items: [OLD], has_more: false };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

function renderComments() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CommentsSection courseId="k1" />
    </QueryClientProvider>,
  );
  return client;
}

describe('CommentsSection', () => {
  it('renders the last page with no "Load earlier"', async () => {
    firstPage = { items: [NEW, REPLY], has_more: false };
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

  it('keeps a discussion that drops off the live page and shows a reply posted under an earlier one', async () => {
    auth.user = { id: 'u1', role: 'learner' };
    firstPage = { items: [NEW, REPLY], has_more: true };
    const client = renderComments();
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier comments' }));
    expect(await screen.findByText('Older question')).toBeTruthy();

    // A new discussion arrives: the live page no longer holds NEW.
    const NEWER = row('c9', 'Brand new', '2026-10-03T10:00:00Z');
    firstPage = { items: [NEWER], has_more: true };
    await client.invalidateQueries({ queryKey: ['comments', 'k1'] });
    expect(await screen.findByText('Brand new')).toBeTruthy();
    expect(screen.getByText('Newest question')).toBeTruthy();

    // Reply under the earlier-loaded discussion: it shows without the newest page holding it.
    const MINE = row('c10', 'My reply', '2026-10-03T11:00:00Z', 'c1');
    apiMock.mockImplementationOnce(async () => MINE);
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply' })[2]);
    fireEvent.change(screen.getByLabelText('Reply to Abebe'), { target: { value: 'My reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post reply' }));
    expect(await screen.findByText('My reply')).toBeTruthy();
  });
});
