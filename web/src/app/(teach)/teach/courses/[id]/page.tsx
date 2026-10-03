'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { CheckCircle2, Eye, FilePenLine, Flag, Hourglass, ImagePlus, Lock, Sparkles, Undo2, X, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { assessmentTypeLabel, pricingLabel } from '@/lib/labels';
import { useAuth } from '@/lib/hooks';
import { RequireRole } from '@/components/RequireRole';
import { RoleHomeBackButton } from '@/components/BackButton';
import { PageShell, StatusBadge } from '@/components/PageChrome';
import { ChangelogTool, TutorKnowledgeTool } from './course-tools';
import { CourseDetails, EditedChip } from './course-details';
import { RevisionPanel } from './revision-banner';
import { SectionsAndLessons } from './sections-editor';
import { StructureGenerator } from './structure-generator';
import { LessonUploadsProvider, ThumbnailUploader, useActiveLessonUploads, WAIT_FOR_UPLOAD } from './video-upload';
import { COURSE_IN_REVIEW, editState, REVISION_IN_REVIEW, type ReviewFeedbackView, type WorkingCourse } from './working';
import { formatDate, formatETB } from '@/lib/format';
import { useT } from '@/lib/i18n';

const S3_PUBLIC_URL = process.env.NEXT_PUBLIC_S3_PUBLIC_URL ?? 'http://localhost:9000/ethiopialearn';

function ManageCourse({ courseId, generate }: { courseId: string; generate: boolean }) {
  const { locale } = useT();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const ask = useConfirm();
  const [status, setOk, setError, clearStatus] = useFormStatus();
  const [acting, setActing] = useState(false);
  // The working copy: live values overlaid with staged edits (what the educator edits).
  const { data: course, error: loadError } = useQuery({
    queryKey: ['manage-course', courseId],
    queryFn: () => api<WorkingCourse>(`/courses/${courseId}/working`),
  });
  const { data: reviews } = useQuery({ queryKey: ['reviews', courseId], queryFn: () => api<any>(`/courses/${courseId}/reviews`), retry: false });
  const { data: pendingProjects } = useQuery({ queryKey: ['pending-projects', courseId], queryFn: () => api<any[]>(`/courses/${courseId}/pending-projects`), retry: false });
  // A lesson video still uploading is not attached yet, so a submission now would go to review without it.
  const uploading = useActiveLessonUploads(courseId) > 0;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['manage-course', courseId] });
  /** After anything that changes the course's status, title or staged state. */
  const refreshAll = () => {
    refresh();
    queryClient.invalidateQueries({ queryKey: ['own-courses'] });
    queryClient.invalidateQueries({ queryKey: ['assessments', courseId] });
    queryClient.invalidateQueries({ queryKey: ['knowledge', courseId] });
    queryClient.invalidateQueries({ queryKey: ['changelog', courseId] });
  };

  if (!course) {
    return (
      <PageShell>
        {loadError ? (
          <p className="badge-danger w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm">
            Could not load this course: {(loadError as Error).message}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="skeleton h-9 w-72" />
            <div className="skeleton h-40 w-full" />
            <div className="skeleton h-40 w-full" />
          </div>
        )}
      </PageShell>
    );
  }
  const isDraft = course.status === 'draft';
  const edit = editState(course);
  const { live, canEdit, locked } = edit;
  const revisionInReview = !!course.revision && REVISION_IN_REVIEW.includes(course.revision.status);
  const lessonIds = course.sections.flatMap((s) => s.lessons.map((l) => l.id));

  const action = async (path: string, ok: string, body?: any) => {
    if (acting) return;
    setActing(true);
    clearStatus();
    try {
      await api(`/courses/${courseId}/${path}`, { method: 'POST', body });
      setOk(ok);
      refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  };

  const unpublish = async () => {
    if (!(await ask({ title: `Unpublish “${course.title}”?`, body: 'It’s hidden from the catalog; enrolled learners keep access.', confirmLabel: 'Unpublish' }))) return;
    void action('unpublish', 'Course unpublished (hidden from catalog).');
  };

  const archive = async () => {
    if (!(await ask({ title: `Archive “${course.title}”?`, body: 'Archiving is permanent and can’t be undone.', confirmLabel: 'Archive course', tone: 'danger' }))) return;
    void action('archive', 'Course archived.');
  };

  async function review(attemptId: string, passed: boolean) {
    try {
      await api(`/attempts/${attemptId}/review`, { method: 'PUT', body: { passed } });
    } catch (err) {
      setError((err as Error).message);
    }
    queryClient.invalidateQueries({ queryKey: ['pending-projects', courseId] });
  }

  // Once a coached (or sent-back) update is resubmitted, those notes are history: hide them while it is in review.
  const feedback = course.review_feedback;
  const showFeedback = !!feedback && !(revisionInReview && ['coach', 'institution_reject'].includes(feedback.action));

  return (
    <PageShell>
    <LessonUploadsProvider courseId={courseId} userId={user?.id ?? null} lessonIds={lessonIds} onChanged={refresh}>
    <div className="space-y-6">
      <RoleHomeBackButton educatorLabel="My courses" />
      <div className="flex animate-fade-in-up flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 break-words text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">
            {course.title} <EditedChip course={course} fields={['title']} />
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
            <StatusBadge status={course.status} />
            {revisionInReview && <span className="badge-info">update in review</span>}
            {live && !revisionInReview && course.has_pending_changes && <span className="badge-warn">unpublished changes</span>}
            <span>
              {pricingLabel(course.pricing_type)}
              {course.pricing_type !== 'free' && course.price_etb ? ` · ${formatETB(course.price_etb, locale)}` : ''}
              {reviews?.average_rating ? ` · ★ ${reviews.average_rating} (${reviews.review_count})` : ''}
            </span>
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Link href={`/preview/${courseId}`} className="btn-secondary">
            <Eye className="h-4 w-4" aria-hidden /> Preview as learner
          </Link>
          {isDraft && (
            <button className="btn" disabled={uploading || acting} title={uploading ? WAIT_FOR_UPLOAD : undefined} onClick={() => action('submit', 'Submitted for review.')}>
              Submit for review
            </button>
          )}
          {COURSE_IN_REVIEW.includes(course.status) && (
            <button className="btn-secondary" disabled={acting} onClick={() => action('withdraw', 'Withdrawn to draft — you can edit and resubmit.')}>Withdraw &amp; edit</button>
          )}
          {course.status === 'published' && (
            <button className="btn-secondary" disabled={acting} onClick={unpublish}>Unpublish</button>
          )}
          {course.status === 'unlisted' && (
            <button className="btn" disabled={acting} onClick={() => action('republish', 'Course re-published.')}>Re-publish</button>
          )}
          {(isDraft || course.status === 'unlisted') && (
            <button className="btn-secondary" disabled={acting} onClick={archive}>Archive</button>
          )}
          {course.status === 'archived' && (
            <button className="btn" disabled={acting} onClick={() => action('restore', 'Restored to draft.')}>Restore</button>
          )}
          <button className="btn-secondary" disabled={acting} onClick={() => action('duplicate', 'Duplicated as a new draft — find it in My courses.')}>Duplicate</button>
        </div>
      </div>
      <FormStatus status={status} />
      {isDraft && uploading && <p className="text-sm text-amber-700 dark:text-amber-300">{WAIT_FOR_UPLOAD}</p>}

      {course.status === 'institution_review' && (
        <p className="badge-info w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm">
          <Hourglass className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden /> Awaiting your institution&apos;s internal review. Once they approve, it goes to the platform quality officers.
        </p>
      )}
      {locked && !live && edit.lockReason && (
        <p className="flex w-fit items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          <Lock className="h-4 w-4 shrink-0" aria-hidden /> {edit.lockReason}
        </p>
      )}
      {showFeedback && feedback && <ReviewFeedback feedback={feedback} />}
      {live && (
        <RevisionPanel
          course={course}
          onChanged={(m) => {
            setOk(m);
            refreshAll();
          }}
        />
      )}
      {course.status === 'flagged' && <AppealBox courseId={courseId} onDone={(m) => { setOk(m); refreshAll(); }} />}

      {canEdit && (
        <div className="card animate-fade-in-up">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {course.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={course.thumbnail_url} alt="Course thumbnail" className="h-14 w-24 shrink-0 rounded-xl border object-cover shadow-glass" />
              ) : (
                <span className="glass-secondary flex h-14 w-24 shrink-0 items-center justify-center rounded-xl">
                  <ImagePlus className="h-5 w-5 text-brand-400" aria-hidden />
                </span>
              )}
              <div className="min-w-0">
                <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                  Thumbnail
                  {course.thumbnail_url ? (
                    <span className="badge-success">
                      <CheckCircle2 className="h-3 w-3" aria-hidden /> uploaded
                    </span>
                  ) : (
                    <span className="badge-warn">required before submit</span>
                  )}
                  <EditedChip course={course} fields={['thumbnail_url']} />
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">Shown on the course card in the catalog. JPEG, PNG or WebP up to 5 MB.</p>
              </div>
            </div>
            <ThumbnailUploader
              courseId={courseId}
              publicBaseUrl={S3_PUBLIC_URL}
              hasThumbnail={!!course.thumbnail_url}
              disabled={locked}
              onSaved={() => {
                if (live) setOk('Thumbnail staged — it goes live after review.');
                refreshAll();
              }}
            />
          </div>
        </div>
      )}

      {canEdit && <CourseDetails course={course} live={live} disabled={locked} onSaved={(m) => { setOk(m); refreshAll(); }} />}

      {canEdit && (
        <StructureGenerator courseId={courseId} title={course.title} live={live} disabled={locked} autoOpen={generate} onApplied={refreshAll} />
      )}

      <SectionsAndLessons course={course} edit={edit} refresh={refresh} />

      <LearnerFeedback reviews={reviews} />

      <AssessmentManager courseId={courseId} live={live} locked={locked || !canEdit} onSaved={refresh} />

      <ChangelogTool courseId={courseId} published={course.status === 'published'} />

      <TutorKnowledgeTool courseId={courseId} live={live} locked={locked || !canEdit} />


      {pendingProjects && pendingProjects.length > 0 && (
        <div className="card">
          <h2 className="font-semibold">Project submissions awaiting review</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {pendingProjects.map((p) => (
              <li key={p.attempt_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-brand-500/5">
                <span>Submitted {formatDate(p.submitted_at, locale, 'datetime')}</span>
                <span className="flex gap-2">
                  {p.download_url && <a className="font-medium text-brand-600 hover:underline" href={p.download_url} target="_blank">Download</a>}
                  <button className="font-medium text-emerald-700 hover:underline dark:text-emerald-400" onClick={() => review(p.attempt_id, true)}>Pass</button>
                  <button className="font-medium text-red-600 dark:text-red-400 hover:underline" onClick={() => review(p.attempt_id, false)}>Fail</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
    </LessonUploadsProvider>
    </PageShell>
  );
}

/** Latest reviewer feedback (quality officer or institution) shown on the
 *  course itself, so the educator sees the comments without hunting in
 *  notifications. */
function ReviewFeedback({ feedback }: { feedback: ReviewFeedbackView }) {
  const { locale } = useT();
  const map: Record<string, { tone: string; label: string; Icon: typeof Flag }> = {
    coach: {
      tone: 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      label: 'Changes requested by our quality team',
      Icon: FilePenLine,
    },
    flag: { tone: 'border-red-400/40 bg-red-500/10 text-red-600 dark:text-red-300', label: 'Your course was flagged in review', Icon: Flag },
    institution_reject: {
      tone: 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      label: 'Sent back by your institution',
      Icon: Undo2,
    },
    approve: {
      tone: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      label: 'Approved by quality review',
      Icon: CheckCircle2,
    },
    // A rejected update of a live course: its staged changes were discarded, the course itself is unchanged.
    reject: {
      tone: 'border-red-400/40 bg-red-500/10 text-red-600 dark:text-red-300',
      label: 'Your update was not approved — its changes were discarded',
      Icon: XCircle,
    },
  };
  const meta = map[feedback.action] ?? { tone: 'text-gray-600', label: 'Reviewer feedback', Icon: FilePenLine };
  const when = feedback.reviewed_at ? formatDate(feedback.reviewed_at, locale, 'datetime') : '';
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${meta.tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-semibold">
          <meta.Icon className="h-4 w-4 shrink-0" aria-hidden /> {meta.label}
        </span>
        {when && <span className="text-xs opacity-70">{when}</span>}
      </div>
      {feedback.notes ? (
        <p className="mt-1 whitespace-pre-wrap">{feedback.notes}</p>
      ) : (
        <p className="mt-1 opacity-70">No written notes were left.</p>
      )}
    </div>
  );
}

function LearnerFeedback({ reviews }: { reviews: any }) {
  const { locale } = useT();
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Learner feedback</h2>
        {reviews?.average_rating != null && (
          <span className="text-sm text-gray-600">★ {reviews.average_rating} · {reviews.review_count} review{reviews.review_count === 1 ? '' : 's'}</span>
        )}
      </div>
      {!reviews?.reviews?.length ? (
        <p className="mt-2 text-sm text-gray-500">No reviews yet. Ratings and comments from learners will appear here once they’re ≥20% through the course.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {reviews.reviews.map((r: any) => (
            <li key={r.id} className="border-t pt-2 text-sm first:border-0 first:pt-0">
              <p className="text-amber-700 dark:text-amber-400">{'★'.repeat(r.rating)}<span className="text-gray-500">{'★'.repeat(5 - r.rating)}</span>
                <span className="ml-2 text-xs text-gray-500">{formatDate(r.created_at, locale)}</span>
              </p>
              {r.comment && <p className="mt-1 text-gray-700">{r.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AppealBox({ courseId, onDone }: { courseId: string; onDone: (m: string) => void }) {
  const [note, setNote] = useState('');
  const [status, , setError] = useFormStatus();
  return (
    <div className="card !border-red-400/40 bg-gradient-to-br from-red-500/10 to-transparent">
      <h2 className="font-bold text-red-600 dark:text-red-400">This course was flagged</h2>
      <p className="mt-1 text-sm text-gray-600">Explain the changes you made or why it should be reconsidered. It will go back to the review queue.</p>
      <div className="mt-2">
        <Field label="Your appeal">
          {(ids) => <textarea {...ids} className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain what you changed…" />}
        </Field>
      </div>
      <button
        className="btn mt-2"
        disabled={note.trim().length < 10}
        onClick={async () => {
          try {
            await api(`/courses/${courseId}/appeal`, { method: 'POST', body: { note } });
            onDone('Appeal submitted — a quality officer will re-review your course.');
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        Submit appeal
      </button>
      <FormStatus status={status} />
    </div>
  );
}

interface QDraft { prompt: string; options: string[]; correct_index: number; }

/**
 * Assessments. On a live course a new one is created as 'pending' and joins the
 * staged update (learners cannot start it until the update is approved).
 */
function AssessmentManager({ courseId, live, locked, onSaved }: { courseId: string; live: boolean; locked: boolean; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const { data: assessments } = useQuery({
    queryKey: ['assessments', courseId],
    queryFn: () => api<any[]>(`/assessments?course_id=${courseId}&include_pending=1`),
  });
  const [type, setType] = useState('quiz');
  const [passScore, setPassScore] = useState(60);
  const [questions, setQuestions] = useState<QDraft[]>([]);
  // Anti-cheat settings (server-enforced): attempts, cooldown, time limit, shuffle, pool size, proctoring.
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [cooldown, setCooldown] = useState(0);
  const [timeLimit, setTimeLimit] = useState<number | ''>('');
  const [shuffle, setShuffle] = useState(true);
  const [poolSize, setPoolSize] = useState<number | ''>('');
  const [proctored, setProctored] = useState(false);
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clearStatus, setInfo] = useFormStatus();
  const [vivaTopic, setVivaTopic] = useState('');
  const [projectInstr, setProjectInstr] = useState('');

  const generate = async () => {
    setBusy(true); clearStatus();
    try {
      const res = await api<{ questions: QDraft[]; ai_live: boolean }>(`/assessments/generate`, { method: 'POST', body: { course_id: courseId, topic, count }, slow: true });
      setQuestions((q) => [...q, ...res.questions]);
      if (!res.ai_live) setInfo('AI questions are unavailable right now — add questions manually.');
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true); clearStatus();
    try {
      let config: any = {};
      if (type === 'quiz') {
        if (!questions.length) { setError('Add or generate at least one question.'); setBusy(false); return; }
        config = {
          questions,
          max_attempts: maxAttempts,
          cooldown_minutes: cooldown,
          time_limit_minutes: timeLimit || undefined,
          shuffle,
          pool_size: poolSize || undefined,
          proctored,
        };
      } else if (type === 'ai_viva') config = { topic_context: vivaTopic };
      else config = { instructions: projectInstr };
      const saved = await api<{ state?: string }>('/assessments', { method: 'POST', body: { course_id: courseId, type, pass_score: passScore, is_required: true, config } });
      setQuestions([]); setTopic(''); setVivaTopic(''); setProjectInstr('');
      setOk(
        saved?.state === 'pending'
          ? 'Assessment saved — learners get it once your changes are approved. Submit your changes for review.'
          : 'Assessment saved.',
      );
      queryClient.invalidateQueries({ queryKey: ['assessments', courseId] });
      onSaved();
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };

  return (
    <div className="card">
      <h2 className="font-semibold">Assessments</h2>
      <ul className="mt-2 space-y-1 text-sm text-gray-600">
        {assessments?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden />
            <span>
              {assessmentTypeLabel(a.type)} · pass ≥ {a.pass_score}
              {a.is_required ? ' · required' : ''}
            </span>
            {a.state === 'pending' && <span className="badge-warn ">pending review</span>}
          </li>
        ))}
        {!assessments?.length && <li className="text-gray-500">None yet — certificates issue on lesson completion alone.</li>}
      </ul>

      <div className="mt-3 space-y-3 border-t pt-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Assessment type">
            {(ids) => (
              <select {...ids} value={type} onChange={(e) => setType(e.target.value)} className="input w-48">
                <option value="quiz">Quiz</option>
                <option value="ai_viva">AI oral check (viva)</option>
                <option value="project">Project submission</option>
              </select>
            )}
          </Field>
          <Field label="Pass score">
            {(ids) => <input {...ids} type="number" min={1} max={100} value={passScore} onChange={(e) => setPassScore(+e.target.value)} className="input w-24" />}
          </Field>
        </div>

        {type === 'quiz' && (
          <div className="space-y-2">
            <div className="glass-secondary flex flex-wrap items-end gap-2 rounded-xl p-3">
              <span className="flex w-full items-center gap-1.5 text-sm font-semibold text-foreground">
                <Sparkles className="h-4 w-4 text-brand-500" aria-hidden /> Generate with AI
              </span>
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                <Field label="Topic">
                  {(ids) => <input {...ids} className="input" placeholder="e.g. HTML basics" value={topic} onChange={(e) => setTopic(e.target.value)} />}
                </Field>
              </div>
              <Field label="Number of questions">
                {(ids) => <input {...ids} type="number" min={1} max={20} value={count} onChange={(e) => setCount(+e.target.value)} className="input w-24" />}
              </Field>
              <button className="btn-secondary text-xs" disabled={busy || !topic} onClick={generate}>Generate</button>
            </div>
            {questions.map((q, qi) => (
              <div key={qi} className="glass-secondary rounded-xl p-3">
                <div className="flex items-center gap-2">
                  <input className="input flex-1 text-sm" value={q.prompt} onChange={(e) => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, prompt: e.target.value } : x)))} placeholder="Question prompt" aria-label={`Question ${qi + 1} prompt`} />
                  <button aria-label={`Remove question ${qi + 1}`} className="btn-ghost btn-sm !text-red-600 dark:!text-red-400" onClick={() => setQuestions((qs) => qs.filter((_, i) => i !== qi))}><X className="h-4 w-4" aria-hidden /></button>
                </div>
                <div className="mt-1 space-y-1">
                  {q.options.map((opt, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <input type="radio" name={`correct-${qi}`} aria-label={`Correct answer for question ${qi + 1}`} value={oi} checked={q.correct_index === oi} onChange={() => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, correct_index: oi } : x)))} />
                      <input className="input flex-1 text-xs" value={opt} onChange={(e) => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: x.options.map((y, j) => (j === oi ? e.target.value : y)) } : x)))} placeholder={`Option ${oi + 1}`} aria-label={`Option ${oi + 1} of question ${qi + 1}`} />
                      <button aria-label={`Remove option ${oi + 1} of question ${qi + 1}`} className="btn-ghost btn-sm !text-red-600 dark:!text-red-400" onClick={() => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: x.options.filter((_, j) => j !== oi), correct_index: Math.min(x.correct_index, x.options.length - 2) } : x)))}><X className="h-4 w-4" aria-hidden /></button>
                    </div>
                  ))}
                  <button className="btn-ghost btn-sm text-brand-600" aria-label={`Add an option to question ${qi + 1}`} onClick={() => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: [...x.options, ''] } : x)))}>+ option</button>
                </div>
              </div>
            ))}
            <button className="btn-ghost btn-sm text-brand-600" onClick={() => setQuestions((qs) => [...qs, { prompt: '', options: ['', ''], correct_index: 0 }])}>+ Add question manually</button>
            <div className="glass-secondary grid gap-2 rounded-xl p-3 text-xs sm:grid-cols-3">
              <p className="font-semibold text-foreground sm:col-span-3">Integrity settings (enforced on the server)</p>
              <Field label="Max attempts">
                {(ids) => <input {...ids} type="number" min={1} max={20} className="input" value={maxAttempts} onChange={(e) => setMaxAttempts(+e.target.value)} />}
              </Field>
              <Field label="Cooldown between attempts (min)">
                {(ids) => <input {...ids} type="number" min={0} className="input" value={cooldown} onChange={(e) => setCooldown(+e.target.value)} />}
              </Field>
              <Field label="Time limit (min, blank = none)">
                {(ids) => <input {...ids} type="number" min={1} max={240} className="input" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value ? +e.target.value : '')} />}
              </Field>
              <Field label={`Questions per paper (blank = all ${questions.length})`}>
                {(ids) => <input {...ids} type="number" min={1} max={questions.length || 1} className="input" value={poolSize} onChange={(e) => setPoolSize(e.target.value ? +e.target.value : '')} />}
              </Field>
              <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} /> Shuffle questions &amp; options per learner</label>
              <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={proctored} onChange={(e) => setProctored(e.target.checked)} /> Webcam proctoring (face, tab &amp; clipboard)</label>
              <p className="text-gray-500 sm:col-span-3">Each learner gets a different paper drawn from your bank; the answer key never leaves the server; refreshing resumes the same attempt with the same deadline.</p>
            </div>
          </div>
        )}
        {type === 'ai_viva' && (
          <Field label="Topic context for the oral check">
            {(ids) => <textarea {...ids} className="input" rows={2} placeholder="What the AI uses to generate the viva question" value={vivaTopic} onChange={(e) => setVivaTopic(e.target.value)} />}
          </Field>
        )}
        {type === 'project' && (
          <Field label="Project instructions">
            {(ids) => <textarea {...ids} className="input" rows={2} placeholder="Instructions for learners" value={projectInstr} onChange={(e) => setProjectInstr(e.target.value)} />}
          </Field>
        )}

        <FormStatus status={status} />
        {live && !locked && <p className="text-xs text-gray-500">New assessments on a live course are reviewed with your other changes before learners see them.</p>}
        <button className="btn" disabled={busy || locked} onClick={save} title={locked ? 'Editing is locked while your course or changes are in review' : undefined}>Save assessment</button>
      </div>
    </div>
  );
}

/** ?generate=1 (from "Create and generate from a file" on /teach/new) opens the outline generator. */
function ManageCourseFromUrl({ courseId }: { courseId: string }) {
  const search = useSearchParams();
  return <ManageCourse courseId={courseId} generate={search.get('generate') === '1'} />;
}

export default function ManageCoursePage() {
  const params = useParams<{ id: string }>();
  return (
    <RequireRole roles={['educator', 'institution_admin', 'platform_admin']}>
      <Suspense>
        <ManageCourseFromUrl courseId={params.id} />
      </Suspense>
    </RequireRole>
  );
}
