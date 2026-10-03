import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, putFileMock } = vi.hoisted(() => ({ apiMock: vi.fn(), putFileMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock('@/lib/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload')>()),
  putFile: (...args: unknown[]) => putFileMock(...args),
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
  putFileMock.mockReset();
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
    await waitFor(() => expect(status.textContent).toBe('Score: 90 — PASSED'));
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

describe('AssessmentsPanel project', () => {
  const project = { id: 'p1', type: 'project', is_required: false, pass_score: 70 };
  const opened = { attempt_id: 't9', file_key: 'k/9', max_bytes: 52428800, instructions: 'Zip your work.' };
  const started = { ...opened, upload_url: 'https://storage.test/put' };
  const posts = () => apiMock.mock.calls.filter(([, o]) => o?.method === 'POST');

  function setup(start: () => unknown = () => started) {
    const answer = (opts: { body?: unknown }) => (opts.body ? start() : opened);
    apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.startsWith('/assessments?')) return [project];
      if (path.startsWith('/attempts/mine')) return [];
      if (opts?.method === 'POST') {
        const r = answer(opts as { body?: unknown });
        if (r instanceof Error) throw r;
        return r;
      }
      if (opts?.method === 'PUT') return { pending_review: true };
      throw new Error(`unexpected ${path}`);
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AssessmentsPanel courseId="c1" />
      </QueryClientProvider>,
    );
  }
  const file = (size: number) => new File([new Uint8Array(size)], 'work.zip');
  async function openAndPick(f: File) {
    fireEvent.click(await screen.findByRole('button', { name: 'Start Project' }));
    const input = await screen.findByLabelText('Project file');
    fireEvent.change(input, { target: { files: [f] } });
    return input as HTMLInputElement;
  }

  it('Start posts with no body, then shows the brief and the picker before any file is chosen', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Start Project' }));
    expect(await screen.findByLabelText('Project file')).toBeTruthy();
    expect(await screen.findByText('Zip your work.')).toBeTruthy();
    expect(posts()).toEqual([['/assessments/p1/attempts', { method: 'POST' }]]);
    expect(putFileMock).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Submit project' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('choosing a file starts with its size, uploads to the returned URL, then Submit sends the file key to that attempt', async () => {
    let release!: () => void;
    putFileMock.mockImplementation(() => new Promise<void>((r) => (release = r)));
    setup();
    await openAndPick(file(1234));
    await waitFor(() => expect(putFileMock).toHaveBeenCalled());
    expect(posts()[1]).toEqual(['/assessments/p1/attempts', { method: 'POST', body: { file_size: 1234 } }]);
    expect(putFileMock.mock.calls[0][0]).toBe('https://storage.test/put');
    expect(await screen.findByText('Zip your work.')).toBeTruthy();
    const submit = screen.getByRole('button', { name: /Uploading|Submit project/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    release();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Submit project' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Submit project' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/attempts/t9/submit', { method: 'PUT', body: { file_key: 'k/9' } }));
  });

  it('Submit goes to the attempt the file was uploaded to, when the sized start answers a different one', async () => {
    putFileMock.mockResolvedValueOnce(undefined);
    setup(() => ({ ...started, attempt_id: 't10', file_key: 'k/10' }));
    await openAndPick(file(10));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Submit project' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Submit project' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/attempts/t10/submit', { method: 'PUT', body: { file_key: 'k/10' } }));
    expect(apiMock.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(1);
  });

  it('a start refusal shows the server message, clears the picker and uploads nothing', async () => {
    setup(() => new Error('Project files can be up to 50 MB.'));
    const input = await openAndPick(file(10));
    expect(await screen.findByText('Project files can be up to 50 MB.')).toBeTruthy();
    expect(putFileMock).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect((screen.getByRole('button', { name: 'Submit project' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('choosing another file starts again and resets the uploaded state until that upload succeeds', async () => {
    putFileMock.mockResolvedValueOnce(undefined);
    setup();
    const input = await openAndPick(file(10));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Submit project' }) as HTMLButtonElement).disabled).toBe(false));
    let release!: () => void;
    putFileMock.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    fireEvent.change(input, { target: { files: [file(20)] } });
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2][1].body).toEqual({ file_size: 20 });
    expect((screen.getByRole('button', { name: /Uploading|Submit project/ }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Submit project' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a quiz Start still posts with no body', async () => {
    respondWith({});
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AssessmentsPanel courseId="c1" />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start Quiz' }));
    await screen.findByLabelText('4');
    expect(apiMock).toHaveBeenCalledWith('/assessments/a1/attempts', { method: 'POST' });
  });
});
