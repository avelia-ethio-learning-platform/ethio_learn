import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, queuedMock } = vi.hoisted(() => ({ apiMock: vi.fn(), queuedMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/offline-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/offline-queue')>()),
  queuedApi: (...args: unknown[]) => queuedMock(...args),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'c1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: vi.fn(), back: vi.fn(), push: vi.fn() }),
  usePathname: () => '/learn/c1',
}));
vi.mock('@/lib/hooks', () => ({ useAuth: () => ({ user: { role: 'learner', email: 'a@b.test' }, ready: true }) }));
vi.mock('@/lib/wake', () => ({ wakeServices: () => () => undefined }));
vi.mock('hls.js', () => ({ default: class { static isSupported = () => false } }));

import { ApiError, WakingError } from '@/lib/api';
import LearnPage from './page';

const course = {
  id: 'c1',
  title: 'Intro to Farming',
  sections: [
    { id: 's1', title: 'Basics', is_free_preview: false, lessons: [{ id: 'l1', title: 'Soil', duration_seconds: 300, has_video: true }, { id: 'l2', title: 'Seeds', duration_seconds: 300, has_video: true }] },
    { id: 's2', title: 'Advanced', is_free_preview: false, lessons: [{ id: 'l3', title: 'Irrigation', duration_seconds: 300, has_video: true }] },
  ],
};

interface Routes {
  course?: unknown;
  status?: unknown;
  videoProgress?: unknown;
  progress?: unknown;
  certificates?: unknown;
  assessments?: unknown;
}
function route(r: Routes) {
  const answer = async (v: unknown) => {
    if (v instanceof Error) throw v;
    return v;
  };
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/courses/c1') return answer(r.course ?? course);
    if (path.startsWith('/enrollments/status')) return answer(r.status ?? { entitlement_status: 'active', enrollment_id: 'e1' });
    if (path === '/enrollments/e1/video-progress') return answer(r.videoProgress ?? { last_lesson_id: null, lessons: [] });
    if (path === '/enrollments/e1/progress') return answer(r.progress ?? { completed_lessons: [], progress_percent: 0, completed_at: null, changelog_seen_at: null });
    if (path === '/me/certificates') return answer(r.certificates ?? []);
    if (path === '/courses/c1/changelog') return [];
    if (path.startsWith('/assessments')) return answer(r.assessments ?? []);
    if (path.startsWith('/attempts')) return [];
    return {};
  });
}

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <LearnPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  queuedMock.mockReset();
  queuedMock.mockResolvedValue({});
});
afterEach(cleanup);

describe('lesson player states', () => {
  it.each([404, 400])('a %i on the course is "Course not found" with Browse courses', async (status) => {
    route({ course: new ApiError(status, 'nope') });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Course not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse courses' }).getAttribute('href')).toBe('/courses');
  });

  it('another course error is the waking-up state with Retry, not "not found"', async () => {
    route({ course: new ApiError(503, 'down') });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('Course not found')).toBeNull();
  });

  it('an enrollment-status error is waking-up, never "not enrolled"', async () => {
    route({ status: new ApiError(503, 'down') });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(/not enrolled/)).toBeNull();
  });

  it('a failed background refetch keeps a loaded player (no "not found", no waking-up)', async () => {
    route({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    expect(await screen.findByRole('button', { name: 'Start lesson 1' })).toBeTruthy();
    route({ course: new ApiError(404, 'gone'), status: new ApiError(503, 'down') });
    await client.refetchQueries();
    await waitFor(() => expect(client.getQueryState(['course', 'c1'])?.status).toBe('error'));
    await waitFor(() => expect(client.getQueryState(['enrollment-status', 'c1'])?.status).toBe('error'));
    expect(screen.getByRole('button', { name: 'Start lesson 1' })).toBeTruthy();
    expect(screen.queryByText('Course not found')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a successful non-active status is "not enrolled" with a link to the course', async () => {
    route({ status: { entitlement_status: 'none', enrollment_id: null } });
    renderPage();
    expect(await screen.findByRole('heading', { name: "You're not enrolled in this course" })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View the course' }).getAttribute('href')).toBe('/courses/c1');
  });
});

describe('lesson player', () => {
  it('before a lesson is chosen there is no video, and one button says "Start lesson 1"', async () => {
    route({});
    const { container } = renderPage();
    expect(await screen.findByRole('button', { name: 'Start lesson 1' })).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByText(/select a lesson/i)).toBeNull();
  });

  it('with saved progress the button is "Resume: <lesson>"', async () => {
    route({ videoProgress: { last_lesson_id: 'l2', lessons: [] } });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Resume: Seeds' })).toBeTruthy();
  });

  it('choosing a lesson mounts the video at once and marks it aria-current', async () => {
    route({});
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/lessons/l1/stream-url') return new Promise(() => undefined); // the URL never arrives
      if (path === '/courses/c1') return course;
      if (path.startsWith('/enrollments/status')) return { entitlement_status: 'active', enrollment_id: 'e1' };
      if (path.includes('video-progress')) return { last_lesson_id: null, lessons: [] };
      if (path.endsWith('/progress')) return { completed_lessons: [], progress_percent: 0, completed_at: null, changelog_seen_at: null };
      return [];
    });
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Start lesson 1' }));
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(screen.getByText('Loading video…')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Soil/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /Seeds/ }).getAttribute('aria-current')).toBeNull();
  });

  it('the lesson list sits between the player and the panels, with an All lessons disclosure', async () => {
    route({ progress: { completed_lessons: [], progress_percent: 30, completed_at: null, changelog_seen_at: null } });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'All lessons (3)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
    // DOM order: player (h1) < lesson list < review box
    const h1 = screen.getByRole('heading', { level: 1 });
    const review = await screen.findByText('Rate this course');
    expect(h1.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('lesson list', () => {
  it('a finished lesson is announced as Completed, not just shown with an icon', async () => {
    route({ progress: { completed_lessons: [{ lesson_id: 'l1' }], progress_percent: 33, completed_at: null, changelog_seen_at: null } });
    renderPage();
    const soil = (await screen.findByText('Soil')).closest('button')!;
    expect(soil.textContent).toContain('Completed');
    expect(screen.getByText('Seeds').closest('button')!.textContent).not.toContain('Completed');
  });
});

describe('completion', () => {
  const done = { completed_lessons: [], progress_percent: 100, completed_at: '2026-01-01T00:00:00Z', changelog_seen_at: null };

  it('with a certificate for this course: View certificate and Download, no emoji', async () => {
    route({ progress: done, certificates: [{ id: 'x', course_id: 'other', verify_url: '/verify/no' }, { id: 'k1', course_id: 'c1', verify_url: '/verify/abc' }] });
    const { container } = renderPage();
    const view = await screen.findByRole('link', { name: 'View certificate' });
    expect(view.getAttribute('href')).toBe('/verify/abc');
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(container.textContent).not.toContain('🎉');
  });

  it('without one and a required assessment unpassed: says what is missing and links to the assessments', async () => {
    route({ progress: done, assessments: [{ id: 'a1', type: 'quiz', is_required: true, pass_score: 70 }], certificates: [{ id: 'x', course_id: 'other', verify_url: '/verify/no' }] });
    renderPage();
    expect(await screen.findByText(/You've finished the lessons\. Pass the remaining assessments/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to assessments' }).getAttribute('href')).toBe('#assessments');
    expect(screen.queryByRole('link', { name: 'View certificate' })).toBeNull();
  });

  it('without one and no assessments left: says the certificate is being prepared, with no link', async () => {
    route({ progress: done });
    renderPage();
    expect(await screen.findByText('Your certificate is being prepared…')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Go to assessments' })).toBeNull();
  });

  it('keeps asking until the certificate arrives, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route({ progress: done });
      const base = apiMock.getMockImplementation()!;
      let issued = false;
      apiMock.mockImplementation(async (path: string, ...rest: unknown[]) =>
        path === '/me/certificates' ? (issued ? [{ id: 'k1', course_id: 'c1', verify_url: '/verify/abc' }] : []) : base(path, ...rest),
      );
      renderPage();
      expect(await screen.findByText('Your certificate is being prepared…')).toBeTruthy();
      issued = true;
      await vi.advanceTimersByTimeAsync(5100);
      expect(await screen.findByRole('link', { name: 'View certificate' })).toBeTruthy();
      const calls = () => apiMock.mock.calls.filter(([p]) => p === '/me/certificates').length;
      const before = calls();
      await vi.advanceTimersByTimeAsync(20000);
      expect(calls()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking at once when the certificates request fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route({ progress: done });
      const base = apiMock.getMockImplementation()!;
      let failing = false;
      apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
        if (path === '/me/certificates' && failing) throw new Error('outcomes down');
        return base(path, ...rest);
      });
      const calls = () => apiMock.mock.calls.filter(([p]) => p === '/me/certificates').length;
      renderPage();
      expect(await screen.findByText('Your certificate is being prepared…')).toBeTruthy();
      failing = true;
      await vi.advanceTimersByTimeAsync(5100);
      const afterFailure = calls();
      await vi.advanceTimersByTimeAsync(30000);
      expect(calls()).toBe(afterFailure);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls for at most 2 minutes while no certificate comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route({ progress: done });
      const calls = () => apiMock.mock.calls.filter(([p]) => p === '/me/certificates').length;
      renderPage();
      expect(await screen.findByText('Your certificate is being prepared…')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(125_000);
      const atLimit = calls();
      expect(atLimit).toBeGreaterThan(20);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls()).toBe(atLimit);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing about the certificate while the attempts are still loading', async () => {
    route({ progress: done });
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) =>
      path.startsWith('/attempts') ? new Promise(() => undefined) : base(path, ...rest),
    );
    renderPage();
    await waitFor(() => expect(apiMock.mock.calls.some(([p]) => p === '/me/certificates')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Your certificate is being prepared…')).toBeNull();
    expect(screen.queryByText(/Pass the remaining assessments/)).toBeNull();
  });

  it('a failed Download shows a message instead of throwing', async () => {
    route({ progress: done, certificates: [{ id: 'k1', course_id: 'c1', verify_url: '/verify/abc' }] });
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === '/me/certificates/k1/download') throw new Error('boom');
      return base(path, ...rest);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(await screen.findByText('Could not start the download. Please try again.')).toBeTruthy();
    expect(screen.getByText('Could not start the download. Please try again.').getAttribute('role')).toBe('alert');
  });
});

describe('completing a lesson', () => {
  const MSG = 'Finish watching this lesson to complete it.';
  const completeCalls = () => apiMock.mock.calls.filter(([p]) => String(p).endsWith('/complete'));

  /** Opens lesson 1 with a player that holds its video (100 s long, at 95 s). */
  async function openLesson(name = 'Start lesson 1') {
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path.endsWith('/stream-url')) return new Promise(() => undefined);
      return base(path, ...rest);
    });
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name }));
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 95.7, configurable: true, writable: true });
    return video;
  }
  /** Makes /complete answer with the next queued result. */
  function completeAnswers(...results: unknown[]) {
    const base = apiMock.getMockImplementation()!;
    const queue = [...results];
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path.endsWith('/complete')) {
        const r = queue.shift();
        if (r instanceof Error) throw r;
        return r ?? {};
      }
      return base(path, ...rest);
    });
  }
  const refused = (body: Record<string, unknown> = {}) => new ApiError(409, MSG, { statusCode: 409, message: MSG, ...body });
  const markButton = () => screen.getByRole('button', { name: /Mark complete/ });

  it('a video lesson completes through api() with the final position, never the queue', async () => {
    route({});
    await openLesson();
    fireEvent.click(markButton());
    await waitFor(() => expect(completeCalls()).toHaveLength(1));
    expect(completeCalls()[0]).toEqual(['/progress/lessons/l1/complete', { method: 'POST', body: { position_seconds: 95 } }]);
    expect(queuedMock.mock.calls.some(([p]) => String(p).endsWith('/complete'))).toBe(false);
  });

  it('a lesson without video still completes through the queue', async () => {
    route({ course: { ...course, sections: [{ id: 's1', title: 'B', is_free_preview: false, lessons: [{ id: 'n1', title: 'Reading', duration_seconds: 60, has_video: false }] }] } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Start lesson 1' }));
    fireEvent.click(await screen.findByRole('button', { name: /Mark complete/ }));
    await waitFor(() => expect(queuedMock).toHaveBeenCalledWith('/progress/lessons/n1/complete', { method: 'POST' }));
    expect(completeCalls()).toHaveLength(0);
  });

  it('a refusal without a wait shows the server message at once', async () => {
    route({});
    await openLesson();
    completeAnswers(refused());
    fireEvent.click(markButton());
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(completeCalls()).toHaveLength(1);
  });

  it('a refusal with a short wait retries once after that wait, then succeeds and refreshes progress', async () => {
    route({});
    const video = await openLesson();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      completeAnswers(refused({ retry_after_seconds: 30 }), {});
      const progressCalls = () => apiMock.mock.calls.filter(([p]) => p === '/enrollments/e1/progress').length;
      fireEvent.click(markButton());
      await vi.advanceTimersByTimeAsync(29_000);
      (video as any).currentTime = 99.2;
      expect(completeCalls()).toHaveLength(1);
      expect(screen.queryByText(MSG)).toBeNull();
      const before = progressCalls();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(completeCalls()).toHaveLength(2);
      expect(completeCalls()[1][1]).toEqual({ method: 'POST', body: { position_seconds: 99 } });
      await waitFor(() => expect(progressCalls()).toBeGreaterThan(before));
      expect(screen.queryByText(MSG)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second refusal shows the message and does not retry again; a click during the wait starts no second timer', async () => {
    route({});
    await openLesson();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      completeAnswers(refused({ retry_after_seconds: 10 }), refused({ retry_after_seconds: 10 }));
      fireEvent.click(markButton());
      await vi.advanceTimersByTimeAsync(2_000);
      fireEvent.click(markButton());
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await screen.findByText(MSG)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(completeCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wait over 120 seconds shows the message at once with no retry', async () => {
    route({});
    await openLesson();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      completeAnswers(refused({ retry_after_seconds: 300 }));
      fireEvent.click(markButton());
      expect(await screen.findByText(MSG)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(400_000);
      expect(completeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('changing lesson cancels a pending retry and clears the message', async () => {
    route({});
    await openLesson();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      completeAnswers(refused({ retry_after_seconds: 30 }));
      fireEvent.click(markButton());
      await vi.advanceTimersByTimeAsync(1_000);
      fireEvent.click(screen.getByRole('button', { name: /Seeds/ }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(completeCalls()).toHaveLength(1);
      expect(screen.queryByText(MSG)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unmount cancels a pending retry', async () => {
    route({});
    await openLesson();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      completeAnswers(refused({ retry_after_seconds: 30 }));
      fireEvent.click(markButton());
      await vi.advanceTimersByTimeAsync(1_000);
      cleanup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(completeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unreachable server says progress is saved and queues nothing', async () => {
    route({});
    await openLesson();
    completeAnswers(new WakingError());
    fireEvent.click(markButton());
    expect(await screen.findByText("We couldn't reach the server. Your progress is saved, so try again in a moment.")).toBeTruthy();
    expect(queuedMock.mock.calls.some(([p]) => String(p).endsWith('/complete'))).toBe(false);
  });

  it('a network failure reads the same way, and any other error shows its message', async () => {
    route({});
    await openLesson();
    completeAnswers(new TypeError('Failed to fetch'), new ApiError(500, 'Something broke'));
    fireEvent.click(markButton());
    expect(await screen.findByText(/We couldn't reach the server/)).toBeTruthy();
    fireEvent.click(markButton());
    expect(await screen.findByText('Something broke')).toBeTruthy();
    expect(screen.queryByText(/We couldn't reach the server/)).toBeNull();
  });
  /** /complete that stays in flight until `finish` is called with its result. */
  function slowComplete() {
    const base = apiMock.getMockImplementation()!;
    let finish!: (r: unknown) => void;
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path.endsWith('/complete')) return new Promise((resolve, reject) => (finish = (r) => (r instanceof Error ? reject(r) : resolve(r))));
      return base(path, ...rest);
    });
    return (r: unknown) => finish(r);
  }

  it('a refusal that lands after the learner switched lessons shows nothing and never retries', async () => {
    route({});
    await openLesson();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const land = slowComplete();
      fireEvent.click(markButton());
      fireEvent.click(screen.getByRole('button', { name: /Seeds/ }));
      await vi.advanceTimersByTimeAsync(100);
      land(refused({ retry_after_seconds: 30 }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(completeCalls()).toHaveLength(1);
      expect(screen.queryByText(MSG)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a plain refusal that lands after the switch shows no message on the new lesson', async () => {
    route({});
    await openLesson();
    const land = slowComplete();
    fireEvent.click(markButton());
    fireEvent.click(screen.getByRole('button', { name: /Seeds/ }));
    await new Promise((r) => setTimeout(r, 50));
    land(refused());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(MSG)).toBeNull();
  });

  it('a refusal that lands after unmount never retries', async () => {
    route({});
    await openLesson();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const land = slowComplete();
      fireEvent.click(markButton());
      cleanup();
      land(refused({ retry_after_seconds: 30 }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(completeCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starting a new completion clears the previous message', async () => {
    route({});
    await openLesson();
    completeAnswers(refused());
    fireEvent.click(markButton());
    expect(await screen.findByText(MSG)).toBeTruthy();
    const land = slowComplete();
    fireEvent.click(markButton());
    await waitFor(() => expect(screen.queryByText(MSG)).toBeNull());
    land({});
  });
});
