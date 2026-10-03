import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => apiMock(...args),
}));
// The upload widgets need the uploads provider; nothing here uploads.
vi.mock('./video-upload', () => ({
  LessonUploadStatus: () => null,
  OrphanUploadHints: () => null,
  ResumeHints: () => null,
  UploadVideoButton: () => null,
  useStartLessonUpload: () => () => null,
  UNSUPPORTED_VIDEO: 'unsupported',
}));

import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { SectionsAndLessons } from './sections-editor';
import type { WorkingCourse } from './working';

const course = {
  id: 'c1',
  sections: [
    {
      id: 's1',
      title: 'Soil',
      order: 0,
      is_free_preview: false,
      pending_state: null,
      changed_fields: [],
      lessons: [{ id: 'l1', title: 'What soil is', summary: null, duration_seconds: 0, order: 0, has_video: false, video_pending: false, pending_state: null, changed_fields: [] }],
    },
  ],
} as unknown as WorkingCourse;

const dialog = () => document.querySelector('dialog')!;
const settle = () => act(async () => {});

function renderEditor(refresh = vi.fn()) {
  render(
    <ConfirmProvider>
      <SectionsAndLessons course={course} edit={{ canEdit: true, locked: false, live: false }} refresh={refresh} />
    </ConfirmProvider>,
  );
  return refresh;
}

beforeEach(() => apiMock.mockReset().mockResolvedValue({}));
afterEach(cleanup);

describe('SectionsAndLessons removal', () => {
  it('Cancel on remove lesson sends nothing; Confirm deletes', async () => {
    const refresh = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove lesson What soil is' }));
    await settle();
    expect(dialog().textContent).toContain('Remove the lesson “What soil is”?');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(apiMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove lesson What soil is' }));
    await settle();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove lesson' }));
    await settle();
    expect(apiMock).toHaveBeenCalledWith('/lessons/l1', { method: 'DELETE' });
    expect(refresh).toHaveBeenCalled();
  });

  it('Cancel on delete section sends nothing, and a failed delete shows an alert', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Delete section/ }));
    await settle();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(apiMock).not.toHaveBeenCalled();

    apiMock.mockRejectedValueOnce(new Error('Section is locked'));
    fireEvent.click(screen.getByRole('button', { name: /Delete section/ }));
    await settle();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete section' }));
    await settle();
    expect(screen.getAllByRole('alert').some((n) => n.textContent === 'Section is locked')).toBe(true);
  });
});

describe('Add section', () => {
  it('a double click posts once while the request runs', async () => {
    let resolve!: (v: unknown) => void;
    apiMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText('New section title'), { target: { value: 'Water' } });
    const add = screen.getByRole('button', { name: 'Add section' });
    fireEvent.click(add);
    fireEvent.click(add);
    await settle();
    expect(apiMock.mock.calls.filter(([path]) => path === '/courses/c1/sections')).toHaveLength(1);
    await act(async () => resolve({}));
  });
});
