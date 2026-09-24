'use client';

import { FormEvent, useState } from 'react';
import { CheckCircle2, Layers, Pencil, Play, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { resolveContentType, VIDEO_ACCEPT } from '@/lib/upload';
import {
  BADGE_CLASS,
  lessonBadges,
  sectionBadges,
  type EditState,
  type PendingState,
  type RowBadge,
  type WorkingCourse,
  type WorkingLesson,
  type WorkingSection,
} from './working';
import { LessonUploadStatus, OrphanUploadHints, ResumeHints, UNSUPPORTED_VIDEO, UploadVideoButton, useStartLessonUpload } from './video-upload';

type Edit = Pick<EditState, 'canEdit' | 'locked' | 'live'>;

function Badges({ badges }: { badges: RowBadge[] }) {
  return (
    <>
      {badges.map((b) => (
        <span key={b.label} className={`${BADGE_CLASS[b.tone]} shrink-0 !text-[10px]`}>
          {b.label}
        </span>
      ))}
    </>
  );
}

const errorText = (err: unknown) => (err as Error)?.message || 'Something went wrong — try again.';

/** The course outline with staged-change markers and the editing tools. */
export function SectionsAndLessons({ course, edit, refresh }: { course: WorkingCourse; edit: Edit; refresh: () => void }) {
  const editable = edit.canEdit && !edit.locked;
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Layers className="h-5 w-5 text-brand-500" /> Sections &amp; lessons
      </h2>
      {edit.canEdit && <OrphanUploadHints />}
      {course.sections.map((section) => (
        <SectionCard key={section.id} section={section} edit={edit} refresh={refresh} />
      ))}
      {!course.sections.length && <p className="text-sm text-gray-500">No sections yet — add one below, or generate an outline with AI.</p>}
      {edit.canEdit && <AddSection courseId={course.id} disabled={!editable} onDone={refresh} />}
    </div>
  );
}

function SectionCard({ section, edit, refresh }: { section: WorkingSection; edit: Edit; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const removing = section.pending_state === 'removed';
  const editable = edit.canEdit && !edit.locked && !removing;

  const remove = async () => {
    const staged = edit.live && section.pending_state !== 'added';
    const question = staged
      ? 'Remove this section and its lessons? Learners keep them until your changes are approved.'
      : 'Delete this section and all its lessons?';
    if (!confirm(question)) return;
    setError('');
    try {
      await api(`/sections/${section.id}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className={`card animate-fade-in-up ${removing ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-2 font-medium">
          <span className={`min-w-0 break-words ${removing ? 'line-through' : ''}`}>{section.title}</span>
          {section.is_free_preview && <span className="badge-info">free preview</span>}
          <Badges badges={sectionBadges(section)} />
          <span className="text-xs font-normal text-gray-400">
            {section.lessons.length} lesson{section.lessons.length === 1 ? '' : 's'}
          </span>
        </p>
        {edit.canEdit && !removing && (
          <span className="flex shrink-0 items-center gap-1">
            <button
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-500/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!editable}
              onClick={() => setEditing((v) => !v)}
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            <button
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!editable}
              onClick={remove}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete section
            </button>
          </span>
        )}
      </div>
      {editing && editable && (
        <EditSectionForm
          section={section}
          onDone={() => {
            setEditing(false);
            refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      {error && <p className="mt-1 text-xs font-medium text-red-500">{error}</p>}
      <ul className="mt-2 space-y-0.5 text-sm text-gray-600">
        {section.lessons.map((lesson) => (
          <LessonRow key={lesson.id} lesson={lesson} sectionState={section.pending_state} edit={edit} refresh={refresh} />
        ))}
        {!section.lessons.length && <li className="px-2 py-1.5 text-xs text-gray-400">No lessons in this section yet.</li>}
      </ul>
      {edit.canEdit && !removing && <AddLesson sectionId={section.id} disabled={!editable} onDone={refresh} />}
    </div>
  );
}

function LessonRow({ lesson, sectionState, edit, refresh }: { lesson: WorkingLesson; sectionState: PendingState; edit: Edit; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const removing = sectionState === 'removed' || lesson.pending_state === 'removed';
  const editable = edit.canEdit && !edit.locked && !removing;

  const remove = async () => {
    const staged = edit.live && lesson.pending_state !== 'added' && sectionState !== 'added';
    if (!confirm(staged ? 'Remove this lesson? Learners keep it until your changes are approved.' : 'Remove this lesson?')) return;
    setError('');
    try {
      await api(`/lessons/${lesson.id}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <li className="rounded-lg px-2 py-1.5 transition-colors hover:bg-brand-500/5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-[10rem] flex-1 items-center gap-2">
          <Play className={`h-3.5 w-3.5 shrink-0 ${lesson.has_video ? 'text-brand-400' : 'text-gray-400'}`} />
          <span className={`min-w-0 truncate ${removing ? 'line-through' : ''}`} title={lesson.title}>
            {lesson.title}
          </span>
          <Badges badges={lessonBadges(lesson, sectionState)} />
          {lesson.has_video ? (
            <span className="badge-success shrink-0 !text-[10px]">
              <CheckCircle2 className="h-2.5 w-2.5" /> video
            </span>
          ) : (
            <span className="badge-warn shrink-0 !text-[10px]">no video</span>
          )}
        </span>
        {edit.canEdit && !removing && (
          <span className="flex shrink-0 items-center gap-1">
            <UploadVideoButton lessonId={lesson.id} hasVideo={lesson.has_video} disabled={!editable} />
            <button
              className="rounded-lg px-2 py-0.5 text-xs font-medium text-brand-600 opacity-80 transition-all hover:bg-brand-500/10 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!editable}
              onClick={() => setEditing((v) => !v)}
            >
              edit
            </button>
            <button
              className="rounded-lg px-2 py-0.5 text-xs font-medium text-red-500 opacity-70 transition-all hover:bg-red-500/10 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!editable}
              onClick={remove}
            >
              remove
            </button>
          </span>
        )}
      </div>
      {lesson.summary && !editing && <p className="ml-5 mt-0.5 line-clamp-2 text-xs text-gray-500">{lesson.summary}</p>}
      {editing && editable && (
        <EditLessonForm
          lesson={lesson}
          onDone={() => {
            setEditing(false);
            refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      {error && <p className="ml-5 mt-1 text-xs font-medium text-red-500">{error}</p>}
      {edit.canEdit && (
        <div className="ml-5">
          <LessonUploadStatus lessonId={lesson.id} />
          {!removing && <ResumeHints lessonId={lesson.id} disabled={!editable} />}
        </div>
      )}
    </li>
  );
}

function EditLessonForm({ lesson, onDone, onCancel }: { lesson: WorkingLesson; onDone: () => void; onCancel: () => void }) {
  const initialMinutes = lesson.duration_seconds ? String(Math.round((lesson.duration_seconds / 60) * 10) / 10) : '';
  const [title, setTitle] = useState(lesson.title);
  const [summary, setSummary] = useState(lesson.summary ?? '');
  const [minutes, setMinutes] = useState(initialMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    // Send only what changed: on a live course every sent field is staged for review.
    const body: Record<string, unknown> = {};
    if (title.trim() !== lesson.title) body.title = title.trim();
    if (summary.trim() !== (lesson.summary ?? '')) body.summary = summary.trim();
    if (minutes !== initialMinutes) body.duration_seconds = Math.max(0, Math.round(Number(minutes || 0) * 60));
    if (!Object.keys(body).length) return onCancel();
    setBusy(true);
    setError('');
    try {
      await api(`/lessons/${lesson.id}`, { method: 'PUT', body });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="glass-secondary ml-5 mt-2 space-y-2 rounded-xl p-3">
      <div className="flex flex-wrap gap-2">
        <input className="input min-w-0 flex-1 text-sm" required minLength={2} maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Lesson title" />
        <input
          className="input w-24 text-sm"
          type="number"
          min={0}
          step="any"
          placeholder="min"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          aria-label="Duration in minutes"
        />
      </div>
      <textarea
        className="input text-xs"
        rows={2}
        maxLength={500}
        placeholder="One-line summary learners see under the lesson title (optional)"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        aria-label="Lesson summary"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary !px-3 !py-1 !text-xs" disabled={busy}>
          {busy ? 'Saving…' : 'Save lesson'}
        </button>
        <button type="button" className="text-xs text-gray-500 hover:underline" onClick={onCancel}>
          Cancel
        </button>
        {error && <span className="text-xs font-medium text-red-500">{error}</span>}
      </div>
    </form>
  );
}

function EditSectionForm({ section, onDone, onCancel }: { section: WorkingSection; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(section.title);
  const [preview, setPreview] = useState(section.is_free_preview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (title.trim() !== section.title) body.title = title.trim();
    if (preview !== section.is_free_preview) body.is_free_preview = preview;
    if (!Object.keys(body).length) return onCancel();
    setBusy(true);
    setError('');
    try {
      await api(`/sections/${section.id}`, { method: 'PUT', body });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="glass-secondary mt-2 flex flex-wrap items-center gap-2 rounded-xl p-3">
      <input className="input min-w-0 flex-1 text-sm" required minLength={2} maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Section title" />
      <label className="flex items-center gap-1 text-sm text-gray-600">
        <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> free preview
      </label>
      <button className="btn-secondary !px-3 !py-1 !text-xs" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="text-xs text-gray-500 hover:underline" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="w-full text-xs font-medium text-red-500">{error}</span>}
    </form>
  );
}

function AddSection({ courseId, disabled, onDone }: { courseId: string; disabled: boolean; onDone: () => void }) {
  const [error, setError] = useState('');
  return (
    <form
      className="card flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const form = new FormData(formEl);
        setError('');
        try {
          await api(`/courses/${courseId}/sections`, { method: 'POST', body: { title: String(form.get('title')).trim(), is_free_preview: form.get('preview') === 'on' } });
          formEl.reset();
          onDone();
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <fieldset disabled={disabled} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <input name="title" required minLength={2} maxLength={160} placeholder="New section title" className="input min-w-0 flex-1" />
        <label className="flex items-center gap-1 text-sm text-gray-600">
          <input type="checkbox" name="preview" /> free preview
        </label>
        <button className="btn-secondary">Add section</button>
      </fieldset>
      {error && <p className="w-full text-xs font-medium text-red-500">{error}</p>}
    </form>
  );
}

/** New lesson; an optional video uploads straight into it once it exists (so the upload can resume by lesson). */
function AddLesson({ sectionId, disabled, onDone }: { sectionId: string; disabled: boolean; onDone: () => void }) {
  const startUpload = useStartLessonUpload();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="mt-3 border-t pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const form = new FormData(formEl);
        const summary = String(form.get('summary') ?? '').trim();
        setBusy(true);
        setError('');
        try {
          const lesson = await api<{ id: string }>(`/sections/${sectionId}/lessons`, {
            method: 'POST',
            body: {
              title: String(form.get('title')).trim(),
              duration_seconds: Math.max(0, Math.round(Number(form.get('minutes') || 0) * 60)),
              ...(summary ? { summary } : {}),
            },
          });
          formEl.reset();
          if (file) {
            const rejected = startUpload(lesson.id, file);
            if (rejected) setError(`The lesson was added, but the video was not uploaded: ${rejected}`);
          }
          setFile(null);
          onDone();
        } catch (err) {
          setError(errorText(err));
        }
        setBusy(false);
      }}
    >
      <fieldset disabled={disabled || busy} className="flex min-w-0 flex-wrap items-center gap-2">
        <input name="title" required minLength={2} maxLength={160} placeholder="Lesson title" className="input min-w-0 flex-1 basis-40" />
        <input name="minutes" type="number" min={0} step="any" placeholder="min" className="input w-20" aria-label="Duration in minutes" />
        <label className={`btn-secondary max-w-full text-xs ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
          <span className="min-w-0 truncate">{file ? `Video: ${file.name}` : 'Choose video (MP4, WebM, MOV)'}</span>
          <input
            type="file"
            accept={VIDEO_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              e.currentTarget.value = '';
              if (picked && !resolveContentType(picked, 'video')) {
                setError(UNSUPPORTED_VIDEO);
                return;
              }
              setError('');
              setFile(picked);
            }}
          />
        </label>
        {file && (
          <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setFile(null)}>
            remove video
          </button>
        )}
        <input name="summary" maxLength={500} placeholder="One-line summary (optional)" className="input min-w-0 basis-full text-xs" />
        <button className="btn-secondary">{busy ? 'Adding…' : file ? 'Add lesson & upload' : 'Add lesson'}</button>
      </fieldset>
      {error && <p className="mt-1 text-xs font-medium text-red-500">{error}</p>}
    </form>
  );
}
