'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Eye, GitPullRequestArrow, Lock, Radio, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useActiveLessonUploads, WAIT_FOR_UPLOAD } from './video-upload';
import { formatDate, stagedChangeChips, type WorkingCourse } from './working';

/**
 * Staged changes on an approved course: what is waiting, submit / discard,
 * the in-review lock with withdraw, and the reviewer's notes after coaching.
 */
export function RevisionPanel({ course, onChanged }: { course: WorkingCourse; onChanged: (message: string) => void }) {
  const [summary, setSummary] = useState('');
  const [major, setMajor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = course.revision;
  const inReview = !!revision && (revision.status === 'submitted' || revision.status === 'institution_review');
  // Submitting locks editing, so a video that finishes afterwards cannot attach (409) and the
  // reviewer would approve the update without it.
  const uploading = useActiveLessonUploads(course.id) > 0;

  /** POST a revision action; the success message may depend on the response. Resolves false on failure. */
  const call = async <T,>(path: string, done: string | ((res: T) => string), body?: unknown): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const res = await api<T>(`/courses/${course.id}/revisions/${path}`, { method: 'POST', body });
      onChanged(typeof done === 'function' ? done(res) : done);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // The button is disabled then; this also covers a submit by keyboard.
    if (uploading) return;
    const ok = await call<{ status: string }>(
      'submit',
      (res) =>
        res?.status === 'institution_review'
          ? "Changes sent to your institution's reviewers first, then to quality review. Learners keep seeing the current version until they are approved."
          : 'Changes submitted for review. Learners keep seeing the current version until they are approved.',
      { summary: summary.trim() || undefined, major },
    );
    if (ok) {
      setSummary('');
      setMajor(false);
    }
  };

  // Coaching / institution send-back notes live on the revision; the course's
  // review_feedback card usually shows the same text, so only show it here when it differs.
  const notes = revision?.status === 'draft' && revision.decision_notes && revision.decision_notes !== course.review_feedback?.notes ? revision.decision_notes : null;

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-2xl border border-brand-400/30 bg-brand-500/5 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
        <Radio className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        <span>
          <b>Live course</b> — your edits are staged and go live after a quality review. Learners keep seeing the approved version until then.
        </span>
      </p>

      {notes && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <p className="font-semibold">📝 Changes requested on your update</p>
          <p className="mt-1 whitespace-pre-wrap">{notes}</p>
        </div>
      )}

      {inReview && revision ? (
        <div className="card !border-amber-400/40">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold">
            <Lock className="h-4 w-4 text-amber-500" />
            {revision.status === 'institution_review' ? "Your changes are with your institution's reviewers" : 'Your changes are in review'}
            {revision.submitted_at && <span className="text-xs font-normal text-gray-500">In review since {formatDate(revision.submitted_at)}</span>}
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Editing is locked so the reviewer approves exactly what you submitted.
            {revision.major && ' Enrolled learners will be notified when it goes live.'}
          </p>
          {revision.changelog_summary && <p className="mt-2 whitespace-pre-wrap rounded-xl bg-gray-500/5 px-3 py-2 text-sm text-gray-700 dark:text-gray-300">{revision.changelog_summary}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => void call('withdraw', 'Withdrawn — your changes are back in draft and you can keep editing.')}
            >
              <Undo2 className="h-4 w-4" /> Withdraw to keep editing
            </button>
            <PreviewLink courseId={course.id} revisionId={revision.id} />
          </div>
          {error && <p className="mt-2 text-sm font-medium text-red-500">{error}</p>}
        </div>
      ) : course.has_pending_changes ? (
        <form onSubmit={submit} className="card !border-brand-400/40">
          <h2 className="flex items-center gap-2 font-semibold">
            <GitPullRequestArrow className="h-4 w-4 text-brand-500" /> You have unpublished changes
          </h2>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {stagedChangeChips(course).map((chip) => (
              <li key={chip} className="badge-neutral">
                {chip}
              </li>
            ))}
          </ul>
          <label className="label mt-3" htmlFor="revision-summary">
            What changed? (shown to learners in the change log once approved)
          </label>
          <textarea
            id="revision-summary"
            className="input"
            rows={2}
            maxLength={1000}
            placeholder="e.g. 'Added a section on Telebirr integration and re-recorded lesson 3.' Leave empty to use an automatic summary."
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={major} onChange={(e) => setMajor(e.target.checked)} /> Major update — notify enrolled learners
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="btn" disabled={busy || uploading} title={uploading ? WAIT_FOR_UPLOAD : undefined}>
              Submit changes for review
            </button>
            <button
              type="button"
              className="btn-ghost !text-red-500"
              disabled={busy}
              onClick={() => {
                if (confirm('Discard all staged changes? New sections, lessons, videos and notes you added since approval are deleted. This cannot be undone.')) {
                  void call('discard', 'Changes discarded — the course is back to its approved version.');
                }
              }}
            >
              Discard changes
            </button>
            {revision && <PreviewLink courseId={course.id} revisionId={revision.id} />}
          </div>
          {uploading && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{WAIT_FOR_UPLOAD}</p>}
          {error && <p className="mt-2 text-sm font-medium text-red-500">{error}</p>}
        </form>
      ) : null}
    </div>
  );
}

function PreviewLink({ courseId, revisionId }: { courseId: string; revisionId: string }) {
  return (
    <Link href={`/preview/${courseId}?revision=${revisionId}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline">
      <Eye className="h-4 w-4" /> Preview changes
    </Link>
  );
}
