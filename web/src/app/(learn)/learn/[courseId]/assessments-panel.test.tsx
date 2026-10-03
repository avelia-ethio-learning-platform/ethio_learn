import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { AssessmentsPanel } from './assessments-panel';

const quiz = { id: 'a1', type: 'quiz', is_required: true, pass_score: 70 };
const attempt = { attempt_id: 't1', questions: [{ prompt: 'Two plus two?', options: ['3', '4'] }] };

function respondWith(result: Record<string, unknown>) {
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path.startsWith('/assessments?')) return [quiz];
    if (path.startsWith('/attempts/mine')) return [];
    if (opts?.method === 'POST') return attempt;
    if (opts?.method === 'PUT') return result;
    throw new Error(`unexpected ${path}`);
  });
}

async function takeQuiz() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AssessmentsPanel courseId="c1" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Start Quiz' }));
  fireEvent.click(await screen.findByLabelText('4'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit quiz' }));
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

describe('AssessmentsPanel results', () => {
  it('a score that did not pass is announced politely in warning colours, not as a success', async () => {
    respondWith({ score: 40, passed: false });
    await takeQuiz();
    const status = screen.getByRole('status');
    await waitFor(() => expect(status.textContent).toBe('Score: 40 — not passed yet'));
    expect(status.querySelector('.badge-warn')).not.toBeNull();
    expect(status.querySelector('.badge-success')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('a pass is a success', async () => {
    respondWith({ score: 90, passed: true });
    await takeQuiz();
    const status = screen.getByRole('status');
    await waitFor(() => expect(status.textContent).toBe('Score: 90 — PASSED 🎉'));
    expect(status.querySelector('.badge-success')).not.toBeNull();
  });
});

describe('AssessmentsPanel load failure', () => {
  it('shows its own error with Retry that refetches', async () => {
    apiMock.mockRejectedValue(new Error('down'));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AssessmentsPanel courseId="c1" />
      </QueryClientProvider>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load assessments.");
    respondWith({});
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Start Quiz' })).toBeTruthy();
  });
});
