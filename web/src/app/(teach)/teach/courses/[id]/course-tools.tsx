'use client';

import { FormEvent, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, Megaphone, MessageCircleQuestion, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

/** Educator: post a change-log entry. Major entries notify every enrolled learner. */
export function ChangelogTool({ courseId, published }: { courseId: string; published: boolean }) {
  const queryClient = useQueryClient();
  const { data: entries } = useQuery({ queryKey: ['changelog', courseId], queryFn: () => api<any[]>(`/courses/${courseId}/changelog`) });
  const [summary, setSummary] = useState('');
  const [major, setMajor] = useState(true);
  const [status, setStatus] = useState('');
  const post = async (e: FormEvent) => {
    e.preventDefault();
    setStatus('');
    try {
      await api(`/courses/${courseId}/changelog`, { method: 'POST', body: { summary, major } });
      setStatus(major ? 'Posted — enrolled learners have been notified.' : 'Posted to the change log.');
      setSummary('');
      queryClient.invalidateQueries({ queryKey: ['changelog', courseId] });
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <div className="card">
      <h2 className="flex items-center gap-2 font-semibold">
        <Megaphone className="h-4 w-4 text-brand-500" /> Course updates &amp; change log
      </h2>
      <p className="mt-1 text-xs text-gray-500">
        Lesson additions and video replacements are logged automatically. Post a <b>major</b> update when learners should come back — they get an
        in-app alert and an email, and the course shows an &ldquo;Updated&rdquo; badge until they read it.
      </p>
      {published ? (
        <form onSubmit={post} className="mt-3 space-y-2">
          <textarea className="input" rows={2} required minLength={3} maxLength={1000} placeholder="What changed? e.g. 'Added a new section on Telebirr integration with 4 lessons.'" value={summary} onChange={(e) => setSummary(e.target.value)} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={major} onChange={(e) => setMajor(e.target.checked)} /> Major update (notify enrolled learners)
            </label>
            <button className="btn !px-4 !py-1.5 !text-xs" disabled={summary.trim().length < 3}>
              Post update
            </button>
            {status && <span className="text-xs font-medium text-brand-600">{status}</span>}
          </div>
        </form>
      ) : (
        <p className="mt-2 text-xs text-gray-400">Available once the course is published.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-gray-600">
          {entries.slice(0, 8).map((c) => (
            <li key={c.id} className="flex gap-2">
              <span className={c.kind === 'major' ? 'badge-info' : 'badge-neutral'}>{c.kind}</span>
              <span>
                {c.summary} <span className="text-gray-400">· {new Date(c.created_at).toLocaleDateString()}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Educator: feed the course tutor with notes / transcripts and see what learners ask. */
export function TutorKnowledgeTool({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const { data: docs } = useQuery({ queryKey: ['knowledge', courseId], queryFn: () => api<any[]>(`/courses/${courseId}/knowledge`) });
  const { data: insights } = useQuery({ queryKey: ['tutor-insights', courseId], queryFn: () => api<any>(`/courses/${courseId}/chat/insights`), retry: false });
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus('');
    try {
      const res = await api<{ chunks: number }>(`/courses/${courseId}/knowledge`, { method: 'POST', body: { title, text } });
      setStatus(`Indexed "${title}" (${res.chunks} chunks). The tutor can answer from it now.`);
      setTitle('');
      setText('');
      queryClient.invalidateQueries({ queryKey: ['knowledge', courseId] });
    } catch (err) {
      setStatus((err as Error).message);
    }
    setBusy(false);
  };

  const readFile = async (file: File) => {
    if (!file.type.startsWith('text/') && !/\.(txt|md|srt|vtt|csv)$/i.test(file.name)) {
      setStatus('Paste the text or upload a .txt / .md / .srt file — PDFs are not extracted here.');
      return;
    }
    const raw = await file.text();
    // Strip SRT/VTT timestamps so transcripts index as prose.
    setText(raw.replace(/^\d+\s*$/gm, '').replace(/\d{2}:\d{2}:\d{2}[.,]\d{3} --> .*$/gm, '').replace(/^WEBVTT.*$/m, ''));
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
  };

  return (
    <div className="card">
      <h2 className="flex items-center gap-2 font-semibold">
        <Sparkles className="h-4 w-4 text-brand-500" /> Course tutor (AI) — knowledge base
      </h2>
      <p className="mt-1 text-xs text-gray-500">
        Learners can ask a chatbot about this course. It answers <b>only</b> from the material below (your description and lesson outline are
        indexed automatically) and cites the lesson. Add lecture notes, transcripts or FAQs to make it genuinely useful.
      </p>
      <form onSubmit={upload} className="mt-3 space-y-2">
        <div className="flex flex-wrap gap-2">
          <input className="input flex-1" placeholder="Title, e.g. 'Lesson 3 transcript' or 'FAQ'" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          <input type="file" accept=".txt,.md,.srt,.vtt,text/plain" className="text-xs" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
        </div>
        <textarea className="input" rows={4} placeholder="Paste notes, a transcript, or FAQs (up to 200,000 characters)…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn !px-4 !py-1.5 !text-xs" disabled={busy || text.trim().length < 20 || !title.trim()}>
            <BookOpenCheck className="h-3.5 w-3.5" /> Add to knowledge base
          </button>
          <button
            type="button"
            className="btn-secondary !px-3 !py-1.5 !text-xs"
            onClick={async () => {
              await api(`/courses/${courseId}/knowledge/reindex`, { method: 'POST' });
              queryClient.invalidateQueries({ queryKey: ['knowledge', courseId] });
              setStatus('Re-indexed the description and lesson outline.');
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Re-index outline
          </button>
          {status && <span className="text-xs font-medium text-brand-600">{status}</span>}
        </div>
      </form>
      {docs && docs.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-gray-600">
          {docs.map((d) => (
            <li key={`${d.source}-${d.title}`} className="flex items-center justify-between gap-2">
              <span>
                <span className="badge-neutral mr-1">{d.source}</span>
                {d.title} · {d.chunks} chunk{d.chunks === 1 ? '' : 's'}
              </span>
              {d.source === 'notes' && (
                <button
                  className="inline-flex items-center gap-1 text-red-500 hover:underline"
                  onClick={async () => {
                    await api(`/courses/${courseId}/knowledge/${encodeURIComponent(d.title)}`, { method: 'DELETE' });
                    queryClient.invalidateQueries({ queryKey: ['knowledge', courseId] });
                  }}
                >
                  <Trash2 className="h-3 w-3" /> remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {insights && insights.questions_total > 0 && (
        <div className="glass-secondary mt-4 rounded-xl p-3 text-xs">
          <p className="flex items-center gap-1 font-semibold text-foreground">
            <MessageCircleQuestion className="h-3.5 w-3.5 text-brand-500" /> {insights.questions_total} questions from {insights.learners} learner{insights.learners === 1 ? '' : 's'}
            {insights.not_covered_total > 0 && <span className="ml-1 text-amber-600">· {insights.not_covered_total} not covered by your material</span>}
          </p>
          <ul className="mt-2 space-y-0.5 text-gray-600">
            {insights.recent_questions.slice(0, 6).map((q: any, i: number) => (
              <li key={i}>&ldquo;{q.content.slice(0, 140)}&rdquo;</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
