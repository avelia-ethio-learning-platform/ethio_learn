'use client';

import { ClipboardEvent, useEffect, useRef, useState } from 'react';
import { BookOpenCheck, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import { extractDocument } from '@/lib/extract-text';
import { buildDigest, DIGEST_BUDGET_CHARS, fitsDigestBudget } from '@/lib/outline-source';
import {
  appliedMessage,
  clampKnowledgeText,
  condensedNote,
  condenseSourceText,
  digestNote,
  droppedDocNote,
  knowledgeTitle,
  offlineOutlineBanner,
  OUTLINE_LIMITS,
  OVER_BUDGET_REASON,
  planPaste,
  toApplyBody,
  toDraft,
  type DraftSection,
  type OutlineReply,
  type SourceDoc,
} from './working';

const FILE_ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.html,.htm,.json,.rtf';

/**
 * A macrotask break before a long synchronous step (condensing a book takes
 * 100+ ms), so "Condensing…" paints and a "Stop" click is handled first.
 */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * AI outline: read a PDF / Word / notes file in the browser, condense it to a
 * digest the model can see whole, generate a draft outline, let the educator
 * edit it, then apply it in ONE atomic call.
 */
export function StructureGenerator({
  courseId,
  title,
  live,
  disabled,
  autoOpen,
  onApplied,
}: {
  courseId: string;
  title: string;
  /** Approved course: the outline is staged for review, not published. */
  live: boolean;
  disabled: boolean;
  autoOpen: boolean;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [prompt, setPrompt] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sectionCount, setSectionCount] = useState(4);
  const [lessons, setLessons] = useState(3);
  const [level, setLevel] = useState('beginner');
  const [learningStyle, setLearningStyle] = useState('hands-on');
  const [draft, setDraft] = useState<DraftSection[] | null>(null);
  const [offlineBanner, setOfflineBanner] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [docInfo, setDocInfo] = useState('');
  const [docWarning, setDocWarning] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState('');
  const [tutor, setTutor] = useState<{ state: 'adding' | 'added' | 'failed'; message: string } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The whole document stays out of React state: binding megabytes to the
  // textarea froze the page. Only the digest is shown and sent. Set while the
  // box holds a digest; every change to it comes with a setDocInfo re-render.
  const docRef = useRef<SourceDoc | null>(null);

  useEffect(() => {
    if (autoOpen) cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [autoOpen]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const forgetDocument = () => {
    docRef.current = null;
    setDocInfo('');
    setTutor(null);
  };

  const onFile = async (file: File) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setReading('Reading…');
    setNote('');
    setDocWarning('');
    try {
      const r = await extractDocument(file, { signal: ctrl.signal, onProgress: (i, n) => setReading(`Reading page ${i}/${n}…`) });
      if (r.chars === 0) {
        setDocWarning(r.warning ?? 'No readable text was found in that file — paste the text instead.');
        return;
      }
      setReading('Condensing…');
      await nextTask();
      if (ctrl.signal.aborted) throw new DOMException('Reading the file was cancelled.', 'AbortError');
      const d = buildDigest(r);
      forgetDocument();
      docRef.current = { name: file.name, kind: 'file', fullText: r.fullText };
      setSourceText(d.digest);
      setDocInfo(`${file.name}: ${digestNote(r, d)}`);
      // e.g. only the first 1000 pages were read: the text is usable, but say so.
      if (r.warning) setDocWarning(r.warning);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') setNote('Stopped reading the file.');
      else setNote('Could not read that file — it may be damaged. Paste the text into the box instead.');
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setReading(null);
      }
    }
  };

  /** A long synchronous step (condensing) after "Condensing…" has painted. */
  const condense = async <T,>(work: () => T): Promise<T> => {
    setReading('Condensing…');
    try {
      await nextTask();
      return work();
    } finally {
      setReading(null);
    }
  };

  // Pasting a whole book would freeze the textarea, and the model reads only
  // DIGEST_BUDGET_CHARS (fewer for Ge'ez text): anything over that budget is
  // condensed exactly like an uploaded file.
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // A file is being read or text condensed: the box is about to be replaced.
    if (reading) return e.preventDefault();
    const { selectionStart, selectionEnd } = e.currentTarget;
    const plan = planPaste(sourceText, e.clipboardData.getData('text/plain'), selectionStart, selectionEnd, docRef.current);
    if (plan.condense) e.preventDefault();
    if (plan.doc !== docRef.current) setTutor(null);
    docRef.current = plan.doc;
    if (!plan.condense) {
      // The browser pastes; the note under the box describes what it stands for.
      if (plan.dropped) setDocInfo(droppedDocNote(plan.dropped));
      else if (!plan.doc) setDocInfo('');
      return;
    }
    const d = await condense(() => condenseSourceText(plan.full));
    setSourceText(d.digest);
    const dropped = plan.dropped ? ` ${droppedDocNote(plan.dropped)}` : '';
    setDocInfo(`${condensedNote(plan.full.length, d)}${dropped}`);
  };

  const generate = async () => {
    if (draft?.length && !confirm('Replace your current draft outline with a new one?')) return;
    setGenerating(true);
    setNote('');
    setResult('');
    try {
      let text = sourceText;
      // Typed or edited text never goes through onPaste, and the model drops
      // whatever is past its budget without a word: condense it here too.
      if (!fitsDigestBudget(text)) {
        const original = text;
        const d = await condense(() => condenseSourceText(original));
        // Typed text is the educator's own whole text; an edited digest keeps its document.
        docRef.current ??= { name: 'Pasted notes', kind: 'pasted', fullText: original };
        setSourceText(d.digest);
        setDocInfo(condensedNote(original.length, d));
        text = d.digest;
      }
      const res = await api<OutlineReply & { sections: any[] }>(`/courses/generate-structure`, {
        method: 'POST',
        body: {
          title,
          prompt: prompt || undefined,
          source_text: text || undefined,
          section_count: sectionCount,
          lessons_per_section: lessons,
          level,
          learning_style: learningStyle,
        },
      });
      setDraft(toDraft(res.sections ?? []));
      const banner = offlineOutlineBanner(res, !!text.trim());
      setOfflineBanner(banner);
      // The banner already carries the API's note for an offline draft; do not say it twice.
      if (res.note && !banner) setNote(res.note);
    } catch (err) {
      setNote((err as Error).message);
    }
    setGenerating(false);
  };

  const addAll = async () => {
    if (!draft) return;
    const checked = toApplyBody(draft);
    if (!checked.ok) {
      setNote(checked.error);
      return;
    }
    setApplying(true);
    setNote('');
    try {
      const res = await api<{ sections_added: number; lessons_added: number }>(`/courses/${courseId}/apply-structure`, {
        method: 'POST',
        body: checked.body,
      });
      // Only now: a failed apply keeps the draft so the educator can fix and retry without duplicates.
      setDraft(null);
      setOfflineBanner(null);
      setResult(appliedMessage(res, live));
      onApplied();
    } catch (err) {
      setNote((err as Error).message);
    }
    setApplying(false);
  };

  const addDocumentToTutor = async () => {
    const doc = docRef.current;
    if (!doc?.fullText) return;
    const { text, truncated } = clampKnowledgeText(doc.fullText);
    setTutor({ state: 'adding', message: 'Adding…' });
    try {
      const res = await api<{ chunks: number }>(`/courses/${courseId}/knowledge`, { method: 'POST', body: { title: knowledgeTitle(doc.name), text } });
      const cut = truncated ? ` Only the first ${text.length.toLocaleString('en-US')} characters fit.` : '';
      setTutor({
        state: 'added',
        message: live
          ? `Added to the tutor's notes (${res.chunks} chunks) — learners get answers from it once your changes are approved.${cut}`
          : `Added to the tutor's notes (${res.chunks} chunks).${cut}`,
      });
      onApplied();
    } catch (err) {
      setTutor({ state: 'failed', message: (err as Error).message });
    }
  };

  const updateSection = (si: number, change: Partial<DraftSection>) => setDraft((d) => d!.map((x, i) => (i === si ? { ...x, ...change } : x)));
  const updateLesson = (si: number, li: number, change: { title?: string; summary?: string }) =>
    setDraft((d) => d!.map((x, i) => (i === si ? { ...x, lessons: x.lessons.map((y, j) => (j === li ? { ...y, ...change } : y)) } : x)));

  const overBudget = !fitsDigestBudget(sourceText);
  const lessonTotal = draft?.reduce((n, s) => n + s.lessons.length, 0) ?? 0;

  return (
    <div ref={cardRef} className="card !rounded-3xl border-2 !border-brand-200/60 bg-gradient-to-br from-brand-50/60 to-transparent dark:from-blue-950/30">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 font-bold text-foreground">
          <span className="glass-secondary flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
            <Sparkles className="h-4 w-4 text-brand-600" />
          </span>
          Generate an outline with AI
        </h2>
        <button className="btn-secondary shrink-0 text-xs" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Open'}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-gray-600">
            Describe the course, upload a PDF / Word / notes file, or paste text — the AI drafts sections &amp; lessons for you to edit.
            {live && ' On a live course, the outline is added to your staged changes for review.'}
          </p>
          <textarea
            className="input"
            rows={2}
            maxLength={2000}
            placeholder="Prompt: e.g. 'A beginner course on digital marketing for Ethiopian small businesses'"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className={`btn-secondary text-xs ${reading ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
              {reading ?? '📄 Upload PDF / Word / notes'}
              <input
                type="file"
                accept={FILE_ACCEPT}
                className="hidden"
                disabled={!!reading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.currentTarget.value = '';
                  if (f) void onFile(f);
                }}
              />
            </label>
            {/* Only reading a file can be stopped; condensing pasted text is one short step. */}
            {reading && abortRef.current && (
              <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:underline" onClick={() => abortRef.current?.abort()}>
                <X className="h-3 w-3" /> Stop
              </button>
            )}
            {sourceText && !reading && (
              <button
                type="button"
                className="text-xs text-red-500"
                onClick={() => {
                  setSourceText('');
                  forgetDocument();
                  setDocWarning('');
                }}
              >
                clear text
              </button>
            )}
          </div>
          {docWarning && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{docWarning}</p>}
          <textarea
            className="input"
            rows={5}
            placeholder="…or paste your document / notes here (a file you upload is condensed into this box — edit it freely)"
            value={sourceText}
            // The box is about to be replaced by a digest.
            readOnly={!!reading}
            onPaste={onPaste}
            onChange={(e) => {
              setSourceText(e.target.value);
              if (!e.target.value) forgetDocument();
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
            <span className="min-w-0 break-words">{docInfo}</span>
            <span className={`tabular-nums ${overBudget ? 'font-semibold text-amber-700 dark:text-amber-400' : ''}`}>
              {sourceText.length.toLocaleString('en-US')} / {DIGEST_BUDGET_CHARS.toLocaleString('en-US')}
            </span>
          </div>
          {overBudget && (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              Too long to send as it is — {OVER_BUDGET_REASON}. It is condensed to a digest when you click Generate; trim it yourself to choose what the AI reads.
            </p>
          )}
          {docRef.current?.fullText && docInfo && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                className="btn-secondary !px-3 !py-1 !text-xs"
                disabled={disabled || (!!tutor && tutor.state !== 'failed')}
                onClick={addDocumentToTutor}
              >
                <BookOpenCheck className="h-3.5 w-3.5" /> Also add the full text to the course tutor
              </button>
              {tutor && <span className={`font-medium ${tutor.state === 'failed' ? 'text-red-500' : 'text-brand-600'}`}>{tutor.message}</span>}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              Level
              <select className="input mt-1" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
            <label className="text-sm">
              Learning style
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
            <label>
              Sections{' '}
              <input type="number" min={1} max={OUTLINE_LIMITS.sections} value={sectionCount} onChange={(e) => setSectionCount(clampCount(e.target.value))} className="input w-20" />
            </label>
            <label>
              Lessons/section{' '}
              <input type="number" min={1} max={OUTLINE_LIMITS.lessons} value={lessons} onChange={(e) => setLessons(clampCount(e.target.value))} className="input w-20" />
            </label>
            <button className="btn" disabled={generating || applying || !!reading || (!prompt.trim() && !sourceText.trim())} onClick={generate}>
              {generating ? 'Working…' : 'Generate'}
            </button>
          </div>
          {note && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{note}</p>}
          {result && <p className="badge-success w-fit !whitespace-normal !rounded-xl !px-3 !py-1.5 !text-xs">{result}</p>}
          {draft && (
            <div className="mt-2 space-y-2 border-t pt-2">
              {offlineBanner && (
                <p className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  {offlineBanner}
                </p>
              )}
              <p className="text-sm font-medium">
                Draft outline — {draft.length} section{draft.length === 1 ? '' : 's'} / {lessonTotal} lesson{lessonTotal === 1 ? '' : 's'} (edit, then add):
              </p>
              {draft.map((s, si) => (
                <div key={si} className="glass-secondary rounded-xl p-3">
                  <div className="flex items-center gap-2">
                    <input
                      className="input min-w-0 flex-1 text-sm"
                      maxLength={OUTLINE_LIMITS.title}
                      value={s.title}
                      aria-label={`Section ${si + 1} title`}
                      onChange={(e) => updateSection(si, { title: e.target.value })}
                    />
                    <label className="flex shrink-0 items-center gap-1 text-xs">
                      <input type="checkbox" checked={s.is_free_preview} onChange={(e) => updateSection(si, { is_free_preview: e.target.checked })} /> free
                    </label>
                    <button className="shrink-0 text-xs text-red-500" aria-label={`Remove section ${si + 1}`} onClick={() => setDraft((d) => d!.filter((_, i) => i !== si))}>
                      ✕
                    </button>
                  </div>
                  <ul className="mt-2 space-y-2 pl-2">
                    {s.lessons.map((l, li) => (
                      <li key={li} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <input
                            className="input min-w-0 flex-1 text-xs"
                            maxLength={OUTLINE_LIMITS.title}
                            value={l.title}
                            aria-label={`Lesson ${li + 1} title`}
                            onChange={(e) => updateLesson(si, li, { title: e.target.value })}
                          />
                          <button
                            className="shrink-0 text-xs text-red-500"
                            aria-label={`Remove lesson ${li + 1}`}
                            onClick={() => setDraft((d) => d!.map((x, i) => (i === si ? { ...x, lessons: x.lessons.filter((_, j) => j !== li) } : x)))}
                          >
                            ✕
                          </button>
                        </div>
                        <input
                          className="input w-full !py-1 text-[11px] text-gray-600"
                          maxLength={OUTLINE_LIMITS.summary}
                          placeholder="One-line summary learners see (optional)"
                          value={l.summary ?? ''}
                          aria-label={`Lesson ${li + 1} summary`}
                          onChange={(e) => updateLesson(si, li, { summary: e.target.value })}
                        />
                      </li>
                    ))}
                  </ul>
                  {s.lessons.length < OUTLINE_LIMITS.lessons && (
                    <button className="mt-1 text-xs text-brand-600" onClick={() => updateSection(si, { lessons: [...s.lessons, { title: '', summary: '' }] })}>
                      + lesson
                    </button>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn" disabled={applying || generating || disabled || !draft.length} onClick={addAll}>
                  {applying ? 'Adding…' : 'Add all to course'}
                </button>
                {draft.length < OUTLINE_LIMITS.sections && (
                  <button className="text-xs text-brand-600" onClick={() => setDraft((d) => [...d!, { title: '', is_free_preview: false, lessons: [] }])}>
                    + section
                  </button>
                )}
                <button className="text-xs text-gray-500 hover:underline" onClick={() => setDraft(null)}>
                  Discard draft
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function clampCount(value: string): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(12, Math.max(1, n)) : 1;
}
