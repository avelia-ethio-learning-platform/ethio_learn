'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { extractTextFromFile } from '@/lib/extract-text';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell, StatusBadge } from '@/components/PageChrome';

const S3_PUBLIC_URL = process.env.NEXT_PUBLIC_S3_PUBLIC_URL ?? 'http://localhost:9000/ethiopialearn';

async function uploadToS3(kind: 'video' | 'thumbnail', file: File): Promise<string> {
  const grant = await api<{ upload_url: string; key: string }>('/uploads', {
    method: 'POST',
    body: { kind, filename: file.name, content_type: file.type || 'application/octet-stream' },
  });
  const res = await fetch(grant.upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error('Upload failed');
  return grant.key;
}

function ManageCourse({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const { data: course } = useQuery({ queryKey: ['manage-course', courseId], queryFn: () => api<any>(`/courses/${courseId}`) });
  const { data: reviews } = useQuery({ queryKey: ['reviews', courseId], queryFn: () => api<any>(`/courses/${courseId}/reviews`), retry: false });
  const { data: pendingProjects } = useQuery({ queryKey: ['pending-projects', courseId], queryFn: () => api<any[]>(`/courses/${courseId}/pending-projects`), retry: false });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['manage-course', courseId] });
  if (!course) {
    return (
      <PageShell>
        <div className="space-y-4">
          <div className="skeleton h-9 w-72" />
          <div className="skeleton h-40 w-full" />
          <div className="skeleton h-40 w-full" />
        </div>
      </PageShell>
    );
  }
  const isDraft = course.status === 'draft';

  const action = async (path: string, ok: string, body?: any) => {
    setMessage('');
    try {
      await api(`/courses/${courseId}/${path}`, { method: 'POST', body });
      setMessage(ok);
      refresh();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  async function review(attemptId: string, passed: boolean) {
    await api(`/attempts/${attemptId}/review`, { method: 'PUT', body: { passed } });
    queryClient.invalidateQueries({ queryKey: ['pending-projects', courseId] });
  }

  return (
    <PageShell>
    <div className="space-y-6">
      <BackButton fallback="/teach" label="My courses" />
      <div className="flex animate-fade-in-up flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">{course.title}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
            <StatusBadge status={course.status} />
            <span>
              {course.pricing_type}
              {course.price_etb ? ` · ${course.price_etb} ETB` : ''}
              {reviews?.average_rating ? ` · ★ ${reviews.average_rating} (${reviews.review_count})` : ''}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isDraft && <button className="btn" onClick={() => action('submit', 'Submitted for review.')}>Submit for review</button>}
          {(course.status === 'submitted' || course.status === 'under_review' || course.status === 'institution_review') && (
            <button className="btn-secondary" onClick={() => action('withdraw', 'Withdrawn to draft — you can edit and resubmit.')}>Withdraw &amp; edit</button>
          )}
          {course.status === 'published' && (
            <button className="btn-secondary" onClick={() => action('unpublish', 'Course unpublished (hidden from catalog).')}>Unpublish</button>
          )}
          {course.status === 'unlisted' && (
            <button className="btn" onClick={() => action('republish', 'Course re-published.')}>Re-publish</button>
          )}
          {(isDraft || course.status === 'unlisted') && (
            <button className="btn-secondary" onClick={() => confirm('Archive this course?') && action('archive', 'Course archived.')}>Archive</button>
          )}
          {course.status === 'archived' && (
            <button className="btn" onClick={() => action('restore', 'Restored to draft.')}>Restore</button>
          )}
          <button className="btn-secondary" onClick={() => action('duplicate', 'Duplicated as a new draft — find it in My courses.')}>Duplicate</button>
        </div>
      </div>
      {message && <p className="badge-info w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm">{message}</p>}

      {course.status === 'institution_review' && (
        <p className="badge-info w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm">
          ⏳ Awaiting your institution&apos;s internal review. Once they approve, it goes to the platform quality officers.
        </p>
      )}
      {course.review_feedback && <ReviewFeedback feedback={course.review_feedback} />}
      {course.status === 'flagged' && <AppealBox courseId={courseId} onDone={(m) => { setMessage(m); refresh(); }} />}

      {isDraft && (
        <div className="card">
          <h2 className="font-semibold">Thumbnail {course.thumbnail_url ? '✓' : '(required before submit)'}</h2>
          <input
            type="file"
            accept="image/*"
            className="mt-2 text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const key = await uploadToS3('thumbnail', file);
              await api(`/courses/${courseId}`, { method: 'PUT', body: { thumbnail_url: `${S3_PUBLIC_URL}/${key}` } });
              refresh();
            }}
          />
        </div>
      )}

      {isDraft && <StructureGenerator courseId={courseId} title={course.title} onDone={refresh} />}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Sections &amp; lessons</h2>
        {course.sections?.map((section: any) => (
          <div key={section.id} className="card">
            <div className="flex items-center justify-between">
              <p className="font-medium">
                {section.title} {section.is_free_preview && <span className="text-xs text-brand-600">(free preview)</span>}
              </p>
              {isDraft && (
                <button className="text-xs text-red-500 hover:underline" onClick={async () => { if (!confirm(`Delete section “${section.title}” and all its lessons?`)) return; await api(`/sections/${section.id}`, { method: 'DELETE' }); refresh(); }}>
                  delete section
                </button>
              )}
            </div>
            <ul className="mt-2 space-y-1 text-sm text-gray-600">
              {section.lessons.map((lesson: any) => (
                <li key={lesson.id} className="flex items-center justify-between">
                  <span>▶ {lesson.title} {lesson.has_video === false && <span className="text-xs text-amber-600">— no video</span>}</span>
                  {isDraft && (
                    <button className="text-xs text-red-500 hover:underline" onClick={async () => { if (!confirm(`Remove lesson “${lesson.title}”?`)) return; await api(`/lessons/${lesson.id}`, { method: 'DELETE' }); refresh(); }}>
                      remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {isDraft && <AddLesson sectionId={section.id} onDone={refresh} />}
          </div>
        ))}
        {isDraft && <AddSection courseId={courseId} onDone={refresh} />}
      </div>

      <LearnerFeedback reviews={reviews} />

      <AssessmentManager courseId={courseId} />

      {pendingProjects && pendingProjects.length > 0 && (
        <div className="card">
          <h2 className="font-semibold">Project submissions awaiting review</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {pendingProjects.map((p) => (
              <li key={p.attempt_id} className="flex items-center justify-between">
                <span>Submitted {new Date(p.submitted_at).toLocaleString()}</span>
                <span className="flex gap-2">
                  {p.download_url && <a className="font-medium text-brand-600 hover:underline" href={p.download_url} target="_blank">Download</a>}
                  <button className="font-medium text-emerald-600 hover:underline dark:text-emerald-400" onClick={() => review(p.attempt_id, true)}>Pass</button>
                  <button className="font-medium text-red-500 hover:underline" onClick={() => review(p.attempt_id, false)}>Fail</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
    </PageShell>
  );
}

/** Latest reviewer feedback (quality officer or institution) shown on the
 *  course itself, so the educator sees the comments without hunting in
 *  notifications. */
function ReviewFeedback({ feedback }: { feedback: { action: string; notes: string | null; reviewed_at: string | null } }) {
  const map: Record<string, { tone: string; label: string }> = {
    coach: {
      tone: 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      label: '📝 Changes requested by our quality team',
    },
    flag: { tone: 'border-red-400/40 bg-red-500/10 text-red-500 dark:text-red-300', label: '🚩 Your course was flagged in review' },
    institution_reject: {
      tone: 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      label: '↩️ Sent back by your institution',
    },
    approve: {
      tone: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      label: '✅ Approved by quality review',
    },
  };
  const meta = map[feedback.action] ?? { tone: 'text-gray-600', label: 'Reviewer feedback' };
  const when = feedback.reviewed_at ? new Date(feedback.reviewed_at).toLocaleString() : '';
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${meta.tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{meta.label}</span>
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
              <p className="text-amber-500">{'★'.repeat(r.rating)}<span className="text-gray-300">{'★'.repeat(5 - r.rating)}</span>
                <span className="ml-2 text-xs text-gray-400">{new Date(r.created_at).toLocaleDateString()}</span>
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
  return (
    <div className="card !border-red-400/40 bg-gradient-to-br from-red-500/10 to-transparent">
      <h2 className="font-bold text-red-500">This course was flagged</h2>
      <p className="mt-1 text-sm text-gray-600">Explain the changes you made or why it should be reconsidered. It will go back to the review queue.</p>
      <textarea className="input mt-2" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your appeal…" />
      <button
        className="btn mt-2"
        disabled={note.trim().length < 10}
        onClick={async () => {
          try {
            await api(`/courses/${courseId}/appeal`, { method: 'POST', body: { note } });
            onDone('Appeal submitted — a quality officer will re-review your course.');
          } catch (err) {
            onDone((err as Error).message);
          }
        }}
      >
        Submit appeal
      </button>
    </div>
  );
}

function StructureGenerator({ courseId, title, onDone }: { courseId: string; title: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sectionCount, setSectionCount] = useState(4);
  const [lessons, setLessons] = useState(3);
  const [level, setLevel] = useState('beginner');
  const [learningStyle, setLearningStyle] = useState('hands-on');
  const [draft, setDraft] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [note, setNote] = useState('');

  const onFile = async (file: File) => {
    setExtracting(true);
    setNote('');
    try {
      const { text, warning } = await extractTextFromFile(file);
      if (text) setSourceText((prev) => (prev ? `${prev}\n\n${text}` : text));
      setNote(warning ?? `Loaded ${Math.round((text.length / 1000))}k characters from ${file.name} — review below, then generate.`);
    } catch {
      setNote('Could not read that file. Paste the text into the box instead.');
    }
    setExtracting(false);
  };

  const generate = async () => {
    setBusy(true);
    setNote('');
    try {
      const res = await api<{ sections: any[]; ai_live: boolean; note?: string }>(`/courses/generate-structure`, {
        method: 'POST',
        body: { title, prompt, source_text: sourceText || undefined, section_count: sectionCount, lessons_per_section: lessons, level, learning_style: learningStyle },
      });
      setDraft(res.sections);
      if (res.note) setNote(res.note);
      else if (!res.ai_live) setNote('Using the offline placeholder generator (set GROQ_API_KEY for real AI outlines).');
    } catch (err) {
      setNote((err as Error).message);
    }
    setBusy(false);
  };

  const addAll = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      for (const s of draft) {
        const section = await api<{ id: string }>(`/courses/${courseId}/sections`, { method: 'POST', body: { title: s.title, is_free_preview: !!s.is_free_preview } });
        for (const l of s.lessons ?? []) {
          await api(`/sections/${section.id}/lessons`, { method: 'POST', body: { title: l.title, duration_seconds: 0 } });
        }
      }
      setDraft(null);
      setOpen(false);
      onDone();
    } catch (err) {
      setNote((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="card !rounded-3xl border-2 !border-brand-200/60 bg-gradient-to-br from-brand-50/60 to-transparent dark:from-blue-950/30">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-bold text-foreground">
          <span className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl">
            <Sparkles className="h-4 w-4 text-brand-600" />
          </span>
          Generate an outline with AI
        </h2>
        <button className="btn-secondary text-xs" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Open'}</button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-gray-600">Describe the course, upload a PDF/Word/notes file, or paste text — the AI drafts sections &amp; lessons for you to edit.</p>
          <textarea className="input" rows={2} placeholder="Prompt: e.g. 'A beginner course on digital marketing for Ethiopian small businesses'" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn-secondary cursor-pointer text-xs">
              {extracting ? 'Reading…' : '📄 Upload PDF / Word / notes'}
              <input type="file" accept=".pdf,.docx,.txt,.md,.csv,.html,text/*,application/pdf" className="hidden" disabled={extracting}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} />
            </label>
            {sourceText && <button type="button" className="text-xs text-red-500" onClick={() => setSourceText('')}>clear text</button>}
          </div>
          <textarea className="input" rows={4} placeholder="…or paste your document / notes here (extracted file text appears here — edit it freely)" value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">Level
              <select className="input mt-1" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
            <label className="text-sm">Learning style
              <select className="input mt-1" value={learningStyle} onChange={(e) => setLearningStyle(e.target.value)}>
                <option value="hands-on">Hands-on / practical</option>
                <option value="project-based">Project-based</option>
                <option value="theory-first">Theory-first</option>
                <option value="visual">Visual / examples</option>
                <option value="exam-prep">Exam preparation</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label>Sections <input type="number" min={1} max={12} value={sectionCount} onChange={(e) => setSectionCount(+e.target.value)} className="input w-20" /></label>
            <label>Lessons/section <input type="number" min={1} max={12} value={lessons} onChange={(e) => setLessons(+e.target.value)} className="input w-20" /></label>
            <button className="btn" disabled={busy || extracting || (!prompt && !sourceText)} onClick={generate}>{busy ? 'Working…' : 'Generate'}</button>
          </div>
          {note && <p className="text-xs text-amber-700">{note}</p>}
          {draft && (
            <div className="mt-2 space-y-2 border-t pt-2">
              <p className="text-sm font-medium">Draft outline (edit titles, then add):</p>
              {draft.map((s, si) => (
                <div key={si} className="rounded border p-2">
                  <div className="flex items-center gap-2">
                    <input className="input flex-1 text-sm" value={s.title} onChange={(e) => setDraft((d) => d!.map((x, i) => (i === si ? { ...x, title: e.target.value } : x)))} />
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!s.is_free_preview} onChange={(e) => setDraft((d) => d!.map((x, i) => (i === si ? { ...x, is_free_preview: e.target.checked } : x)))} /> free</label>
                    <button className="text-xs text-red-500" onClick={() => setDraft((d) => d!.filter((_, i) => i !== si))}>✕</button>
                  </div>
                  <ul className="mt-1 space-y-1 pl-2">
                    {(s.lessons ?? []).map((l: any, li: number) => (
                      <li key={li} className="flex items-center gap-2">
                        <input className="input flex-1 text-xs" value={l.title} onChange={(e) => setDraft((d) => d!.map((x, i) => (i === si ? { ...x, lessons: x.lessons.map((y: any, j: number) => (j === li ? { ...y, title: e.target.value } : y)) } : x)))} />
                        <button className="text-xs text-red-500" onClick={() => setDraft((d) => d!.map((x, i) => (i === si ? { ...x, lessons: x.lessons.filter((_: any, j: number) => j !== li) } : x)))}>✕</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <button className="btn" disabled={busy} onClick={addAll}>Add all to course</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddSection({ courseId, onDone }: { courseId: string; onDone: () => void }) {
  return (
    <form
      className="card flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        await api(`/courses/${courseId}/sections`, { method: 'POST', body: { title: form.get('title'), is_free_preview: form.get('preview') === 'on' } });
        (e.target as HTMLFormElement).reset();
        onDone();
      }}
    >
      <input name="title" required minLength={2} placeholder="New section title" className="input flex-1" />
      <label className="flex items-center gap-1 text-sm text-gray-600"><input type="checkbox" name="preview" /> free preview</label>
      <button className="btn-secondary">Add section</button>
    </form>
  );
}

function AddLesson({ sectionId, onDone }: { sectionId: string; onDone: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [videoKey, setVideoKey] = useState<string | undefined>();
  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        await api(`/sections/${sectionId}/lessons`, { method: 'POST', body: { title: form.get('title'), video_s3_key: videoKey, duration_seconds: Number(form.get('minutes') || 0) * 60 } });
        (e.target as HTMLFormElement).reset();
        setVideoKey(undefined);
        onDone();
      }}
    >
      <input name="title" required minLength={2} placeholder="Lesson title" className="input flex-1" />
      <input name="minutes" type="number" min={0} placeholder="min" className="input w-20" />
      <label className="btn-secondary cursor-pointer text-xs">
        {uploading ? 'Uploading…' : videoKey ? 'Video ✓' : 'Upload video'}
        <input type="file" accept="video/*,.m3u8" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; setUploading(true); try { setVideoKey(await uploadToS3('video', file)); } finally { setUploading(false); } }} />
      </label>
      <button className="btn-secondary" disabled={uploading}>Add lesson</button>
    </form>
  );
}

interface QDraft { prompt: string; options: string[]; correct_index: number; }

function AssessmentManager({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const { data: assessments } = useQuery({ queryKey: ['assessments', courseId], queryFn: () => api<any[]>(`/assessments?course_id=${courseId}`) });
  const [type, setType] = useState('quiz');
  const [passScore, setPassScore] = useState(60);
  const [questions, setQuestions] = useState<QDraft[]>([]);
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [vivaTopic, setVivaTopic] = useState('');
  const [projectInstr, setProjectInstr] = useState('');

  const generate = async () => {
    setBusy(true); setNote('');
    try {
      const res = await api<{ questions: QDraft[]; ai_live: boolean }>(`/assessments/generate`, { method: 'POST', body: { course_id: courseId, topic, count } });
      setQuestions((q) => [...q, ...res.questions]);
      if (!res.ai_live) setNote('Using the offline placeholder generator (set GROQ_API_KEY for real AI questions).');
    } catch (err) { setNote((err as Error).message); }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true); setNote('');
    try {
      let config: any = {};
      if (type === 'quiz') {
        if (!questions.length) { setNote('Add or generate at least one question.'); setBusy(false); return; }
        config = { questions };
      } else if (type === 'ai_viva') config = { topic_context: vivaTopic };
      else config = { instructions: projectInstr };
      await api('/assessments', { method: 'POST', body: { course_id: courseId, type, pass_score: passScore, is_required: true, config } });
      setQuestions([]); setTopic(''); setVivaTopic(''); setProjectInstr('');
      setNote('Assessment saved.');
      queryClient.invalidateQueries({ queryKey: ['assessments', courseId] });
    } catch (err) { setNote((err as Error).message); }
    setBusy(false);
  };

  return (
    <div className="card">
      <h2 className="font-semibold">Assessments</h2>
      <ul className="mt-2 space-y-1 text-sm text-gray-600">
        {assessments?.map((a) => <li key={a.id} className="capitalize">{a.type.replace('_', ' ')} · pass ≥ {a.pass_score}{a.is_required ? ' · required' : ''}</li>)}
        {!assessments?.length && <li className="text-gray-400">None yet — certificates issue on lesson completion alone.</li>}
      </ul>

      <div className="mt-3 space-y-3 border-t pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <select value={type} onChange={(e) => setType(e.target.value)} className="input w-48">
            <option value="quiz">Quiz</option>
            <option value="ai_viva">AI viva (Groq)</option>
            <option value="project">Project submission</option>
          </select>
          <label className="text-sm">Pass score <input type="number" min={1} max={100} value={passScore} onChange={(e) => setPassScore(+e.target.value)} className="input w-20" /></label>
        </div>

        {type === 'quiz' && (
          <div className="space-y-2">
            <div className="glass-secondary flex flex-wrap items-center gap-2 rounded-xl p-3">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Sparkles className="h-4 w-4 text-brand-500" /> Generate with AI:
              </span>
              <input className="input flex-1" placeholder="Topic (e.g. HTML basics)" value={topic} onChange={(e) => setTopic(e.target.value)} />
              <label className="text-sm">Qs <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(+e.target.value)} className="input w-16" /></label>
              <button className="btn-secondary text-xs" disabled={busy || !topic} onClick={generate}>Generate</button>
            </div>
            {questions.map((q, qi) => (
              <div key={qi} className="rounded border p-2">
                <div className="flex items-center gap-2">
                  <input className="input flex-1 text-sm" value={q.prompt} onChange={(e) => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, prompt: e.target.value } : x)))} placeholder="Question prompt" />
                  <button className="text-xs text-red-500" onClick={() => setQuestions((qs) => qs.filter((_, i) => i !== qi))}>✕</button>
                </div>
                <div className="mt-1 space-y-1">
                  {q.options.map((opt, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <input type="radio" name={`correct-${qi}`} checked={q.correct_index === oi} onChange={() => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, correct_index: oi } : x)))} />
                      <input className="input flex-1 text-xs" value={opt} onChange={(e) => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: x.options.map((y, j) => (j === oi ? e.target.value : y)) } : x)))} placeholder={`Option ${oi + 1}`} />
                      <button className="text-xs text-red-500" onClick={() => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: x.options.filter((_, j) => j !== oi), correct_index: Math.min(x.correct_index, x.options.length - 2) } : x)))}>✕</button>
                    </div>
                  ))}
                  <button className="text-xs text-brand-600" onClick={() => setQuestions((qs) => qs.map((x, i) => (i === qi ? { ...x, options: [...x.options, ''] } : x)))}>+ option</button>
                </div>
              </div>
            ))}
            <button className="text-sm text-brand-600" onClick={() => setQuestions((qs) => [...qs, { prompt: '', options: ['', ''], correct_index: 0 }])}>+ Add question manually</button>
          </div>
        )}
        {type === 'ai_viva' && <textarea className="input" rows={2} placeholder="Topic context the AI uses to generate the viva question" value={vivaTopic} onChange={(e) => setVivaTopic(e.target.value)} />}
        {type === 'project' && <textarea className="input" rows={2} placeholder="Project instructions for learners" value={projectInstr} onChange={(e) => setProjectInstr(e.target.value)} />}

        {note && <p className="text-xs text-amber-700">{note}</p>}
        <button className="btn" disabled={busy} onClick={save}>Save assessment</button>
      </div>
    </div>
  );
}

export default function ManageCoursePage() {
  const params = useParams<{ id: string }>();
  return (
    <RequireRole roles={['educator', 'platform_admin']}>
      <ManageCourse courseId={params.id} />
    </RequireRole>
  );
}
