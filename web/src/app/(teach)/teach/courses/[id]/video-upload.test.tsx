import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ResumableUploadInfo, UploadResult, UploadState } from '@/lib/upload';

// vi.mock factories are hoisted above the imports, so everything they use is hoisted too.
const { apiMock, listMock, discardMock, created, FakeUpload } = vi.hoisted(() => {
  interface FakeOpts {
    file: File;
    kind: string;
    lessonId?: string;
    courseId?: string;
    onState: (s: UploadState) => void;
  }
  const created: Array<InstanceType<typeof FakeUpload>> = [];
  class FakeUpload {
    settle!: { resolve: (r: UploadResult) => void; reject: (e: Error) => void };
    resumed = 0;
    cancelled = 0;
    constructor(readonly opts: FakeOpts) {
      created.push(this);
    }
    start() {
      return new Promise<UploadResult>((resolve, reject) => (this.settle = { resolve, reject }));
    }
    pause() {}
    resume() {
      this.resumed++;
    }
    async cancel() {
      this.cancelled++;
    }
  }
  return {
    apiMock: vi.fn(),
    listMock: vi.fn<(userId: string, filter: { lessonId?: string; courseId?: string }) => ResumableUploadInfo[]>(),
    discardMock: vi.fn(async (_key: string) => undefined),
    created,
    FakeUpload,
  };
});

vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => apiMock(...args), ApiError: class extends Error {} }));
vi.mock('@/lib/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload')>()),
  ResumableUpload: FakeUpload,
  listResumableUploads: (userId: string, filter: { lessonId?: string; courseId?: string }) => listMock(userId, filter),
  discardResumableUpload: (key: string) => discardMock(key),
}));

import { UploadCancelledError } from '@/lib/upload';
import {
  LessonUploadStatus,
  LessonUploadsProvider,
  resetLessonUploadsForTests,
  ResumeHints,
  ThumbnailUploader,
  UploadVideoButton,
  useActiveLessonUploads,
} from './video-upload';

function renderLesson() {
  const onChanged = vi.fn();
  render(
    <LessonUploadsProvider courseId="c1" userId="u1" lessonIds={['l1']} onChanged={onChanged}>
      <UploadVideoButton lessonId="l1" hasVideo={false} disabled={false} />
      <LessonUploadStatus lessonId="l1" />
      <ResumeHints lessonId="l1" disabled={false} />
    </LessonUploadsProvider>,
  );
  return { onChanged };
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function choose(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const videoInput = () => screen.getByText('upload video').closest('label')!.querySelector('input') as HTMLInputElement;
const mp4 = (name = 'lecture.mp4') => new File(['x'], name, { type: 'video/mp4' });
const state = (over: Partial<UploadState>): UploadState => ({ phase: 'uploading', loaded: 0, total: 100, percent: 0, speedBps: null, etaSeconds: null, ...over });

beforeEach(() => {
  created.length = 0;
  apiMock.mockReset();
  listMock.mockReset();
  listMock.mockReturnValue([]);
  discardMock.mockClear();
});
afterEach(() => {
  cleanup();
  resetLessonUploadsForTests();
});

describe('lesson video uploads', () => {
  it('uploads into the lesson and saves the key itself on the single-PUT path', async () => {
    const { onChanged } = renderLesson();
    choose(videoInput(), mp4());
    expect(created).toHaveLength(1);
    expect(created[0].opts).toMatchObject({ lessonId: 'l1', courseId: 'c1' });
    expect(screen.getByRole('progressbar')).toBeTruthy();

    apiMock.mockResolvedValue({});
    await act(async () => created[0].settle.resolve({ key: 'videos/u1/k-lecture.mp4', size: 1, lesson_updated: false }));
    await flush();
    expect(apiMock).toHaveBeenCalledWith('/lessons/l1', { method: 'PUT', body: { video_s3_key: 'videos/u1/k-lecture.mp4' } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not touch the lesson when the server attached the video on complete', async () => {
    const { onChanged } = renderLesson();
    choose(videoInput(), mp4());
    await act(async () => created[0].settle.resolve({ key: 'videos/u1/k-lecture.mp4', size: 1, lesson_updated: true }));
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a failed attach instead of claiming success', async () => {
    const { onChanged } = renderLesson();
    choose(videoInput(), mp4());
    apiMock.mockRejectedValue(new Error('Your changes are in review — withdraw them to keep editing.'));
    await act(async () => created[0].settle.resolve({ key: 'k', size: 1, lesson_updated: false }));
    await flush();
    expect(screen.getByText(/could not be attached to the lesson: Your changes are in review/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('clears the row after a cancel', async () => {
    renderLesson();
    choose(videoInput(), mp4());
    expect(screen.getByRole('progressbar')).toBeTruthy();
    await act(async () => created[0].settle.reject(new UploadCancelledError()));
    await flush();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('upload video')).toBeTruthy();
  });

  it('offers Resume for a small video paused while offline (it restarts that single PUT)', () => {
    renderLesson();
    choose(videoInput(), mp4());
    act(() => created[0].opts.onState(state({ phase: 'paused', error: "You're offline — the upload continues automatically when you reconnect." })));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(created[0].resumed).toBe(1);
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
  });

  it('rejects formats the player cannot play before any upload starts', () => {
    renderLesson();
    choose(videoInput(), new File(['x'], 'clip.avi', { type: 'video/x-msvideo' }));
    expect(created).toHaveLength(0);
    expect(screen.getByText(/convert other formats to MP4 \(H\.264\)/)).toBeTruthy();
  });
});

describe('uploads that outlive the page', () => {
  it('shows a still-running upload with live progress after leaving the page and coming back', async () => {
    const first = renderLesson();
    choose(videoInput(), mp4());
    // In-app navigation unmounts the page; the engine keeps running.
    cleanup();

    const { onChanged } = renderLesson();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    // Not offered as idle: no second upload into the lesson, no "Unfinished upload" Discard.
    expect(screen.queryByText('upload video')).toBeNull();
    act(() => created[0].opts.onState(state({ loaded: 40, percent: 40 })));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');

    await act(async () => created[0].settle.resolve({ key: 'videos/u1/k-lecture.mp4', size: 1, lesson_updated: true }));
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(first.onChanged).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
  });

  it('refreshes the course on return when its upload finished while the page was closed', async () => {
    renderLesson();
    choose(videoInput(), mp4());
    cleanup();
    await act(async () => created[0].settle.resolve({ key: 'videos/u1/k-lecture.mp4', size: 1, lesson_updated: true }));
    await flush();

    const { onChanged } = renderLesson();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('counts only this course’s running uploads', async () => {
    function Count({ courseId }: { courseId: string }) {
      return <p>active {courseId}: {useActiveLessonUploads(courseId)}</p>;
    }
    render(
      <>
        <Count courseId="c1" />
        <Count courseId="c2" />
      </>,
    );
    renderLesson();
    choose(videoInput(), mp4());
    expect(screen.getByText('active c1: 1')).toBeTruthy();
    expect(screen.getByText('active c2: 0')).toBeTruthy();
    act(() => created[0].opts.onState(state({ phase: 'paused' })));
    expect(screen.getByText('active c1: 1')).toBeTruthy();
    await act(async () => created[0].settle.reject(new UploadCancelledError()));
    await flush();
    expect(screen.getByText('active c1: 0')).toBeTruthy();
  });
});

describe('course thumbnail', () => {
  function renderThumbnail() {
    const onSaved = vi.fn();
    render(<ThumbnailUploader courseId="c1" publicBaseUrl="https://cdn.test" hasThumbnail={false} disabled={false} onSaved={onSaved} />);
    return { onSaved };
  }
  const picker = () => screen.getByText(/Upload image|Uploading…/).closest('label')!.querySelector('input') as HTMLInputElement;
  const png = () => new File(['x'], 'cover.png', { type: 'image/png' });

  it('uploads and saves the public URL on the course', async () => {
    const { onSaved } = renderThumbnail();
    choose(picker(), png());
    expect(created[0].opts).toMatchObject({ kind: 'thumbnail' });
    apiMock.mockResolvedValue({});
    await act(async () => created[0].settle.resolve({ key: 'thumbnails/u1/k-cover.png', size: 1, lesson_updated: false }));
    await flush();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1', { method: 'PUT', body: { thumbnail_url: 'https://cdn.test/thumbnails/u1/k-cover.png' } });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('gives the picker back with the reason when the upload runs out of retries', async () => {
    renderThumbnail();
    choose(picker(), png());
    expect(picker().disabled).toBe(true);
    const message = 'Upload failed after 6 attempts — check your connection, then choose the file again.';
    await act(async () => {
      created[0].opts.onState(state({ phase: 'failed', error: message }));
      created[0].settle.reject(new Error(message));
    });
    await flush();
    expect(screen.getByText(`Failed: ${message}`)).toBeTruthy();
    expect(screen.getAllByText(new RegExp(message))).toHaveLength(1);
    expect(picker().disabled).toBe(false);
  });

  it('can be resumed or cancelled while paused offline', async () => {
    renderThumbnail();
    choose(picker(), png());
    act(() => created[0].opts.onState(state({ phase: 'paused', error: "You're offline — the upload continues automatically when you reconnect." })));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(created[0].resumed).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(created[0].cancelled).toBe(1);
    await act(async () => created[0].settle.reject(new UploadCancelledError()));
    await flush();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(picker().disabled).toBe(false);
  });
});

describe('unfinished upload hints', () => {
  const hint: ResumableUploadInfo = { storageKey: 'el_upload:v1:u1:video|l1|lecture3.mp4|100|1', fileName: 'lecture3.mp4', size: 100, lessonId: 'l1', courseId: 'c1', percent: 62, createdAt: 1 };

  it('lists this course’s records on the lesson and discards one', async () => {
    listMock.mockReturnValue([hint]);
    renderLesson();
    await flush();
    expect(listMock).toHaveBeenCalledWith('u1', { courseId: 'c1' });
    expect(screen.getByText(/Unfinished upload:/).textContent).toContain('lecture3.mp4 · 62%');

    listMock.mockReturnValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await flush();
    expect(discardMock).toHaveBeenCalledWith(hint.storageKey);
    expect(screen.queryByText(/Unfinished upload:/)).toBeNull();
  });

  it('resumes by choosing the same file', async () => {
    listMock.mockReturnValue([hint]);
    renderLesson();
    await flush();
    const resume = screen.getByText('Resume (choose the same file)').querySelector('input') as HTMLInputElement;
    choose(resume, new File([new Uint8Array(100)], 'lecture3.mp4', { type: 'video/mp4' }));
    expect(created).toHaveLength(1);
    expect(created[0].opts.lessonId).toBe('l1');
    // The running upload replaces the hint on the row.
    expect(screen.queryByText(/Unfinished upload:/)).toBeNull();
  });
});
