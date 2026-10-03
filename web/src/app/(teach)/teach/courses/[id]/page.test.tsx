import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, search, uploads, FakeUpload } = vi.hoisted(() => {
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
  return { apiMock: vi.fn(), search: { value: '' }, uploads, FakeUpload };
});

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('@/lib/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload')>()),
  ResumableUpload: FakeUpload,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/teach/courses/c1',
  useParams: () => ({ id: 'c1' }),
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
// The extractor would load pdf.js; nothing here reads a file.
vi.mock('@/lib/extract-text', () => ({ extractDocument: vi.fn(), textToBlocks: () => [] }));

import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import ManageCoursePage from './page';
import { resetLessonUploadsForTests } from './video-upload';
import type { KnowledgeDoc, WorkingCourse } from './working';

const working = (over: Partial<WorkingCourse> = {}): WorkingCourse => ({
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
  pending_fields: [],
  has_pending_changes: true,
  revision: { id: 'r1', status: 'draft', changelog_summary: null, major: false, submitted_at: null, decision_notes: null },
  pending_assessments_count: 0,
  pending_knowledge_count: 0,
  sections: [
    {
      id: 's1',
      title: 'Soil',
      order: 0,
      is_free_preview: true,
      pending_state: null,
      changed_fields: [],
      lessons: [
        { id: 'l1', title: 'What soil is', summary: 'Soil is alive.', duration_seconds: 300, order: 0, has_video: true, video_pending: true, pending_state: null, changed_fields: ['video_s3_key'] },
        { id: 'l2', title: 'Old lesson', summary: null, duration_seconds: 0, order: 1, has_video: false, video_pending: false, pending_state: 'removed', changed_fields: [] },
        { id: 'l3', title: 'Testing soil', summary: null, duration_seconds: 0, order: 2, has_video: false, video_pending: false, pending_state: 'added', changed_fields: [] },
      ],
    },
  ],
  ...over,
});

function respond(course: WorkingCourse, knowledge: KnowledgeDoc[] = []) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/courses/c1/working') return course;
    if (path === '/courses/c1/knowledge') return knowledge;
    if (path.startsWith('/assessments')) return [];
    if (path.endsWith('/changelog') || path.endsWith('/knowledge') || path.endsWith('/pending-projects')) return [];
    if (path.endsWith('/reviews')) return { reviews: [], average_rating: null, review_count: 0 };
    return {};
  });
}

const dialog = () => document.querySelector('dialog')!;
const inDialog = (name: string) => within(dialog()).getByRole('button', { name });
const settle = () => act(async () => {});

/** The add forms are disabled through their <fieldset>, which disables every control inside. */
const fieldsetDisabled = (buttonName: string) => !!screen.getByRole('button', { name: buttonName }).closest('fieldset')?.disabled;

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ManageCoursePage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(() => {
  apiMock.mockReset();
  search.value = '';
  localStorage.setItem('el_auth', JSON.stringify({ access_token: 't', user: { id: 'u1', name: 'Almaz', email: 'a@x.et', role: 'educator' } }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetLessonUploadsForTests();
  uploads.length = 0;
  vi.unstubAllGlobals();
});

const inReview = { id: 'r1', status: 'submitted', changelog_summary: null, major: false, submitted_at: '2026-09-20T10:00:00Z', decision_notes: null };
const faqPair: KnowledgeDoc[] = [
  { source: 'notes', title: 'FAQ', state: 'live', chunks: 4 },
  { source: 'notes', title: 'FAQ', state: 'pending', chunks: 5 },
];

describe('course authoring page', () => {
  it('loads the working copy and marks staged changes', async () => {
    respond(working());
    await renderPage();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/working');
    expect(screen.getByText(/your edits are staged and go live after a quality review/)).toBeTruthy();
    expect(screen.getByText('You have unpublished changes')).toBeTruthy();
    expect(screen.getByText('New video pending')).toBeTruthy();
    expect(screen.getByText('Removing')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Old lesson').className).toContain('line-through');
    // A lesson being removed has no editing tools.
    expect(screen.getAllByRole('button', { name: 'remove' })).toHaveLength(2);
    expect(fieldsetDisabled('Add section')).toBe(false);
  });

  it('locks the editor while the update is in review', async () => {
    respond(working({ revision: inReview }));
    await renderPage();
    expect(screen.getByText('Your changes are in review')).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: 'remove' })) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Edit details/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(fieldsetDisabled('Add section')).toBe(true);
  });

  it('locks a first-time submission in review', async () => {
    respond(working({ status: 'submitted', revision: null, has_pending_changes: false }));
    await renderPage();
    expect(screen.getByText(/This course is in review, so editing is locked/)).toBeTruthy();
    expect(screen.queryByText(/your edits are staged/)).toBeNull();
    expect(fieldsetDisabled('Add section')).toBe(true);
  });

  it('locks tutor-note removal while the update is in review (web-ui-2)', async () => {
    respond(working({ revision: inReview }), faqPair);
    await renderPage();
    const remove = (await screen.findByRole('button', { name: 'Remove tutor note FAQ' })) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toMatch(/Withdraw your changes from review to remove notes/);
    fireEvent.click(remove);
    await act(async () => {});
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/knowledge/FAQ'), expect.anything());
  });

  it('removes only the pending copy of a note that is also live, and says so (web-ui-1)', async () => {
    respond(working(), faqPair);
    await renderPage();
    // Of the pair only the pending row can be removed: one button, not two.
    const remove = (await screen.findByRole('button', { name: 'Remove tutor note FAQ' })) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    await settle();
    expect(dialog().textContent).toContain('Remove your pending note “FAQ”? Learners never saw it; the live “FAQ” note they use stays as it is.');
    fireEvent.click(inDialog('Remove note'));
    await settle();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/knowledge/FAQ?state=pending', { method: 'DELETE' });
  });

  it('asks before removing a live note, which learners lose at once', async () => {
    respond(working(), [{ source: 'notes', title: 'Glossary', state: 'live', chunks: 2 }]);
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove tutor note Glossary' }));
    await settle();
    expect(dialog().textContent).toMatch(/Learners lose it right away/);
    fireEvent.click(inDialog('Cancel'));
    await settle();
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/knowledge/Glossary'), expect.anything());
  });

  it('keeps a draft from being submitted while a lesson video is still uploading', async () => {
    respond(working({ status: 'draft', revision: null, has_pending_changes: false }));
    await renderPage();
    const submit = screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    const input = screen.getAllByText('upload video')[0].closest('label')!.querySelector('input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'lecture.mp4', { type: 'video/mp4' })], configurable: true });
    fireEvent.change(input);
    await act(async () => {});
    expect(uploads).toHaveLength(1);
    expect(submit.disabled).toBe(true);
    expect(submit.title).toMatch(/Wait for the video upload to finish/);
    expect(screen.getByText(/Wait for the video upload to finish before submitting/)).toBeTruthy();

    await act(async () => uploads[0].settle.resolve({ key: 'videos/u1/k', size: 1, lesson_updated: true }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(submit.disabled).toBe(false);
  });

  it('opens the outline generator from ?generate=1', async () => {
    search.value = 'generate=1';
    respond(working({ status: 'draft', revision: null, has_pending_changes: false }));
    await renderPage();
    expect(screen.getByText('Upload PDF / Word / notes')).toBeTruthy();
    expect(screen.getByPlaceholderText(/paste your document/)).toBeTruthy();
  });
  it('archive asks first: Cancel sends nothing, Confirm archives', async () => {
    respond(working({ status: 'draft', revision: null, has_pending_changes: false }));
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await settle();
    expect(dialog().textContent).toContain('Archive “Farming 101”?');
    fireEvent.click(inDialog('Cancel'));
    await settle();
    expect(apiMock).not.toHaveBeenCalledWith('/courses/c1/archive', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await settle();
    fireEvent.click(inDialog('Archive course'));
    await settle();
    expect(apiMock).toHaveBeenCalledWith('/courses/c1/archive', { method: 'POST', body: undefined });
    expect(screen.getByText('Course archived.')).toBeTruthy();
  });

  it('unpublish asks first and says enrolled learners keep access', async () => {
    respond(working({ has_pending_changes: false, revision: null }));
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await settle();
    expect(dialog().textContent).toContain('enrolled learners keep access');
    fireEvent.click(inDialog('Cancel'));
    await settle();
    expect(apiMock).not.toHaveBeenCalledWith('/courses/c1/unpublish', expect.anything());
  });

  it('shows a failed action as an alert', async () => {
    respond(working({ status: 'unlisted', revision: null, has_pending_changes: false }));
    await renderPage();
    apiMock.mockRejectedValueOnce(new Error('Not allowed'));
    fireEvent.click(screen.getByRole('button', { name: 'Re-publish' }));
    await settle();
    expect(within(screen.getAllByRole('alert').find((n) => n.textContent)!).getByText('Not allowed')).toBeTruthy();
  });

  it('links to the learner preview', async () => {
    respond(working({ status: 'draft', revision: null, has_pending_changes: false }));
    await renderPage();
    expect(screen.getByRole('link', { name: /Preview as learner/ }).getAttribute('href')).toBe('/preview/c1');
  });

  it('names every control of the quiz builder', async () => {
    respond(working({ status: 'draft', revision: null, has_pending_changes: false }));
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '+ Add question manually' }));
    expect(screen.getByRole('textbox', { name: 'Question 1 prompt' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Option 2 of question 1' })).toBeTruthy();
    expect(screen.getAllByRole('radio', { name: 'Correct answer for question 1' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove option 1 of question 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove question 1' })).toBeTruthy();
    expect(screen.getByLabelText('Assessment type')).toBeTruthy();
    expect(screen.getByLabelText('Pass score')).toBeTruthy();
    expect(screen.getByLabelText('Max attempts')).toBeTruthy();
  });
});
