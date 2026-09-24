import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { apiMock, uploads, FakeUpload } = vi.hoisted(() => {
  const uploads: Array<InstanceType<typeof FakeUpload>> = [];
  // Stands in for the upload engine: a test settles it by hand.
  class FakeUpload {
    settle!: { resolve: (r: { key: string; size: number; lesson_updated: boolean }) => void; reject: (e: Error) => void };
    constructor() {
      uploads.push(this);
    }
    start() {
      return new Promise<{ key: string; size: number; lesson_updated: boolean }>((resolve, reject) => (this.settle = { resolve, reject }));
    }
    pause() {}
    resume() {}
    async cancel() {}
  }
  return { apiMock: vi.fn(), uploads, FakeUpload };
});
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => apiMock(...args), ApiError: class extends Error {} }));
vi.mock('@/lib/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload')>()),
  ResumableUpload: FakeUpload,
}));

import { RevisionPanel } from './revision-banner';
import { LessonUploadsProvider, resetLessonUploadsForTests, UploadVideoButton } from './video-upload';
import type { WorkingCourse, WorkingRevision } from './working';

const revision = (over: Partial<WorkingRevision> = {}): WorkingRevision => ({
  id: 'r1',
  status: 'draft',
  changelog_summary: null,
  major: false,
  submitted_at: null,
  decision_notes: null,
  ...over,
});

const course = (over: Partial<WorkingCourse> = {}): WorkingCourse => ({
  id: 'c1',
  title: 'Farming 101',
  description: 'A practical course for small farms.',
  category: 'agriculture',
  language: 'en',
  thumbnail_url: null,
  pricing_type: 'free',
  price_etb: null,
  status: 'published',
  review_feedback: null,
  pending_fields: ['title'],
  has_pending_changes: true,
  revision: revision(),
  pending_assessments_count: 0,
  pending_knowledge_count: 0,
  sections: [],
  ...over,
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  apiMock.mockReset();
  uploads.length = 0;
});
afterEach(() => {
  cleanup();
  resetLessonUploadsForTests();
  vi.unstubAllGlobals();
});

/** The course page: the revision panel and a lesson row share the page's upload provider. */
function renderWithLesson(uploadCourseId = 'c1') {
  render(
    <>
      <LessonUploadsProvider courseId="c1" userId="u1" lessonIds={['l1']} onChanged={vi.fn()}>
        <RevisionPanel course={course()} onChanged={vi.fn()} />
      </LessonUploadsProvider>
      <LessonUploadsProvider courseId={uploadCourseId} userId="u1" lessonIds={['l9']} onChanged={vi.fn()}>
        <UploadVideoButton lessonId="l9" hasVideo={false} disabled={false} />
      </LessonUploadsProvider>
    </>,
  );
  const input = screen.getByText('upload video').closest('label')!.querySelector('input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'lecture.mp4', { type: 'video/mp4' })], configurable: true });
  fireEvent.change(input);
}

describe('<RevisionPanel />', () => {
  it('always explains that edits to a live course are staged', () => {
    render(<RevisionPanel course={course({ has_pending_changes: false, revision: null })} onChanged={vi.fn()} />);
    expect(screen.getByText(/your edits are staged and go live after a quality review/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit changes for review' })).toBeNull();
  });

  it('submits the staged changes with a summary and the major flag', async () => {
    const onChanged = vi.fn();
    render(<RevisionPanel course={course()} onChanged={onChanged} />);
    expect(screen.getByText('You have unpublished changes')).toBeTruthy();
    expect(screen.getByText('title edited')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What changed\?/), { target: { value: 'New intro video.' } });
    fireEvent.click(screen.getByLabelText(/Major update — notify enrolled learners/));
    apiMock.mockResolvedValue({ revision_id: 'r1', status: 'submitted' });
    fireEvent.click(screen.getByRole('button', { name: 'Submit changes for review' }));
    await flush();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/revisions/submit', { method: 'POST', body: { summary: 'New intro video.', major: true } });
    expect(onChanged).toHaveBeenCalledWith(expect.stringMatching(/submitted for review/));
  });

  it('blocks submitting while a video of this course is still uploading', async () => {
    renderWithLesson();
    const submit = screen.getByRole('button', { name: 'Submit changes for review' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.title).toMatch(/Wait for the video upload to finish/);
    expect(screen.getByText(/Wait for the video upload to finish before submitting/)).toBeTruthy();
    fireEvent.submit(submit.closest('form')!);
    await flush();
    expect(apiMock).not.toHaveBeenCalledWith('/courses/c1/revisions/submit', expect.anything());

    // Once the video is attached the update can go to review with it.
    await act(async () => uploads[0].settle.resolve({ key: 'videos/u1/k', size: 1, lesson_updated: true }));
    await flush();
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText(/Wait for the video upload to finish/)).toBeNull();
  });

  it('is not blocked by an upload into another course', () => {
    renderWithLesson('c2');
    expect(uploads).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Submit changes for review' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the server message when there is nothing valid to submit', async () => {
    render(<RevisionPanel course={course()} onChanged={vi.fn()} />);
    apiMock.mockRejectedValue(new Error('There are no changes to submit.'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit changes for review' }));
    await flush();
    expect(screen.getByText('There are no changes to submit.')).toBeTruthy();
  });

  it('discards only after confirmation', async () => {
    const confirmSpy = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirmSpy);
    render(<RevisionPanel course={course()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(apiMock).not.toHaveBeenCalled();
    apiMock.mockResolvedValue({ discarded: true });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await flush();
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/revisions/discard', { method: 'POST', body: undefined });
  });

  it('locks while in review and offers withdraw', async () => {
    const onChanged = vi.fn();
    render(
      <RevisionPanel
        course={course({ revision: revision({ status: 'submitted', submitted_at: '2026-09-20T10:00:00Z', changelog_summary: 'New intro video.' }) })}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText('Your changes are in review')).toBeTruthy();
    expect(screen.getByText(/In review since/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit changes for review' })).toBeNull();
    expect(screen.getByRole('link', { name: /Preview changes/ }).getAttribute('href')).toBe('/preview/c1?revision=r1');
    apiMock.mockResolvedValue({ status: 'draft' });
    fireEvent.click(screen.getByRole('button', { name: /Withdraw to keep editing/ }));
    await flush();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/revisions/withdraw', { method: 'POST', body: undefined });
    expect(onChanged).toHaveBeenCalledWith(expect.stringMatching(/keep editing/));
  });

  it('shows reviewer notes on a returned update unless the feedback card already shows them', () => {
    const notes = 'Please re-record lesson 2 — the audio is unclear.';
    const { unmount } = render(<RevisionPanel course={course({ revision: revision({ decision_notes: notes }) })} onChanged={vi.fn()} />);
    expect(screen.getByText(notes)).toBeTruthy();
    unmount();
    render(
      <RevisionPanel
        course={course({ revision: revision({ decision_notes: notes }), review_feedback: { action: 'coach', notes, reviewed_at: null } })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText(notes)).toBeNull();
  });
});
