import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
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

import { ApiError } from '@/lib/api';
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

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LearnPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
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
