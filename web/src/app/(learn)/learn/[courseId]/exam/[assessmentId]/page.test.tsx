import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'c1', assessmentId: 'a1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/RequireRole', () => ({
  RequireRole: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import ExamPage from './page';

const attempt = {
  attempt_id: 't1',
  questions: [{ index: 0, kind: 'mcq', prompt: 'Two plus two?', options: ['3', '4'], points: 1 }],
  pass_score: 70,
  proctored: false,
  time_limit_minutes: null,
  warning_limit: 3,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

describe('exam submit retry', () => {
  it('a successful retry clears the earlier submit error and shows Submitting… while it runs', async () => {
    const retry = deferred<Record<string, unknown>>();
    let puts = 0;
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.startsWith('/assessments?')) return [{ id: 'a1', type: 'quiz', proctored: false, question_count: 1, pass_score: 70 }];
      if (path.endsWith('/proctor-report')) return { events: [], terminated: false, termination_reason: null };
      if (path.endsWith('/study-plan')) throw new Error('not needed');
      if (opts?.method === 'POST') return attempt;
      if (opts?.method === 'PUT') {
        puts += 1;
        if (puts === 1) throw new Error('Network down');
        return retry.promise;
      }
      throw new Error(`unexpected ${path}`);
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ExamPage />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start exam' }));
    fireEvent.click(await screen.findByLabelText('4'));
    fireEvent.click(screen.getByRole('button', { name: /Submit exam/ }));

    const alert = () => screen.getAllByRole('alert').find((el) => el.textContent) ?? screen.getAllByRole('alert')[0];
    await waitFor(() => expect(alert().textContent).toBe('Network down'));

    fireEvent.click(screen.getByRole('button', { name: 'Try submitting again' }));
    // During the retry the old error is gone and the progress line is back.
    await waitFor(() => expect(screen.getByText('Submitting…')).toBeTruthy());
    expect(screen.getAllByRole('alert').map((el) => el.textContent).join('')).toBe('');

    await act(async () => retry.resolve({ score: 100, passed: true, flagged: false, terminated: false }));
    await waitFor(() => expect(screen.getByText('100%')).toBeTruthy());
    expect(screen.getAllByRole('alert').map((el) => el.textContent).join('')).toBe('');
  });
});
