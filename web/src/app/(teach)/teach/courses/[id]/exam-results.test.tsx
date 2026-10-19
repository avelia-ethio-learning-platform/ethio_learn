import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { ExamResults } from './exam-results';

const row = (over: Record<string, unknown> = {}) => ({
  attempt_id: 'at1',
  assessment_type: 'quiz',
  proctored: true,
  learner_name: 'Abebe Bekele',
  score: 55,
  passed: false,
  flagged: true,
  terminated: false,
  violation_count: 2,
  submitted_at: '2026-10-01T10:00:00Z',
  ...over,
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ExamResults courseId="c1" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Exam results/ }));
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

describe('ExamResults', () => {
  it('asks nothing until opened', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExamResults courseId="c1" />
      </QueryClientProvider>,
    );
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('renders rows with flags, and "Learner" when the name is missing', async () => {
    apiMock.mockResolvedValue({ items: [row(), row({ attempt_id: 'at2', learner_name: null, proctored: false, flagged: false, violation_count: 0, passed: true, score: 90 })] });
    mount();
    expect(await screen.findByText('Abebe Bekele')).toBeTruthy();
    expect(screen.getAllByText('Learner')).toHaveLength(2); // the column head and the fallback name
    expect(screen.getByText('Flagged · 2 violations')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/attempts');
    expect(screen.getAllByRole('button', { name: /^Proctor report/ })).toHaveLength(1);
  });

  it('shows the empty state', async () => {
    apiMock.mockResolvedValue([]);
    mount();
    expect(await screen.findByText('No submitted attempts yet.')).toBeTruthy();
  });

  it('loads the proctor report on expand and links the snapshots', async () => {
    apiMock.mockImplementation(async (path: string) =>
      path.startsWith('/attempts/')
        ? { termination_reason: null, events: [{ type: 'tab_switch', description: 'Left the exam tab', at: '2026-10-01T10:05:00Z', screenshot_url: 'https://s.test/1.jpg' }] }
        : [row()],
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Proctor report/ }));
    expect(await screen.findByText('Left the exam tab')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Snapshot' }).getAttribute('href')).toBe('https://s.test/1.jpg');
    expect(apiMock).toHaveBeenCalledWith('/attempts/at1/proctor-report');
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => row({ attempt_id: `r${i}`, learner_name: `Learner ${i + 1}` }));

  it('pages a long list on the client, from one fetch', async () => {
    apiMock.mockResolvedValue(many(51));
    mount();
    expect(await screen.findByText('Showing 1–50 of 51')).toBeTruthy();
    expect(screen.queryByText('Learner 51')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Learner 51')).toBeTruthy();
    expect(screen.getByText('Showing 51–51 of 51')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Learner 1')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('exactly one full page has no Next to follow', async () => {
    apiMock.mockResolvedValue(many(50));
    mount();
    expect(await screen.findByText('Showing 1–50 of 50')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
