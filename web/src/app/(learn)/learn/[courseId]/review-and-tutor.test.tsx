import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

import { ReviewBox } from './review-box';
import { TutorPanel } from './tutor-panel';

function withQuery(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

describe('ReviewBox', () => {
  it('a saved review is a polite success', async () => {
    apiMock.mockResolvedValue({});
    render(<ReviewBox courseId="c1" progressPercent={50} />);
    const status = screen.getByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }));
    await waitFor(() => expect(status.textContent).toBe('Thanks — your review is in!'));
    expect(status.querySelector('.badge-success')).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('a failed review is an alert, styled as an error', async () => {
    apiMock.mockRejectedValue(new Error('You already reviewed this course'));
    render(<ReviewBox courseId="c1" progressPercent={50} />);
    const alert = screen.getByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }));
    await waitFor(() => expect(alert.textContent).toBe('You already reviewed this course'));
    expect(alert.querySelector('.badge-danger')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('TutorPanel', () => {
  it('a failed question is announced as an alert', async () => {
    apiMock.mockImplementation(async (_path: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') throw new Error('The tutor is busy, try again shortly');
      return [];
    });
    withQuery(<TutorPanel courseId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: /ask the course tutor/i }));
    const alert = screen.getByRole('alert');
    fireEvent.change(screen.getByLabelText('Ask a question about this course'), { target: { value: 'What is lesson 3 about?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(alert.textContent).toBe('The tutor is busy, try again shortly'));
  });
});
