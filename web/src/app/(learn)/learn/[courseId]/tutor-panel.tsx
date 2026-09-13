'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpenCheck, LoaderCircle, MessageCircleQuestion, Send, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: string[];
  not_covered: boolean;
}

/**
 * Per-course tutor: answers come ONLY from the course material (description,
 * lesson outline and the educator's notes) and cite the lesson they came from.
 * When the material does not cover a question it says so — never invents.
 */
export function TutorPanel({ courseId }: { courseId: string }) {
  const { data: history } = useQuery({ queryKey: ['tutor', courseId], queryFn: () => api<Message[]>(`/courses/${courseId}/chat`), retry: false });
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (history) setMessages(history);
  }, [history]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, open]);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError('');
    setQuestion('');
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', content: q, sources: [], not_covered: false }]);
    try {
      const res = await api<{ answer: string; sources: string[]; not_covered: boolean; ai_live: boolean }>(`/courses/${courseId}/chat`, {
        method: 'POST',
        body: { question: q },
      });
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: 'assistant', content: res.answer, sources: res.sources, not_covered: res.not_covered }]);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="card mt-6 !p-0 overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
        <span className="flex items-center gap-2 font-bold text-foreground">
          <span className="glass-secondary flex h-8 w-8 items-center justify-center rounded-xl">
            <Sparkles className="h-4 w-4 text-brand-500" />
          </span>
          Ask the course tutor
        </span>
        <span className="text-xs text-gray-500">{open ? 'Hide' : messages.length ? `${messages.filter((m) => m.role === 'user').length} question${messages.length === 2 ? '' : 's'} so far` : 'Answers come from this course only'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5">
          <div className="max-h-96 space-y-3 overflow-y-auto rounded-xl bg-brand-500/5 p-3 text-sm">
            {!messages.length && (
              <p className="flex items-start gap-2 text-gray-500">
                <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                Ask anything about the lessons — e.g. &ldquo;What does lesson 3 say about pricing?&rdquo; or in Amharic. The tutor only uses this
                course&apos;s material and tells you when something isn&apos;t covered.
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-white text-gray-800 shadow-sm dark:bg-slate-900 dark:text-gray-100'}`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                  {m.role === 'assistant' && m.sources.length > 0 && (
                    <p className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
                      <BookOpenCheck className="h-3 w-3" /> {m.sources.join(' · ')}
                    </p>
                  )}
                  {m.role === 'assistant' && m.not_covered && <p className="mt-1 text-[11px] text-amber-600">Not covered in the course material — try asking your instructor.</p>}
                </div>
              </div>
            ))}
            {busy && (
              <p className="flex items-center gap-2 text-xs text-gray-400">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Reading the course material…
              </p>
            )}
            <div ref={endRef} />
          </div>
          <form onSubmit={ask} className="mt-3 flex gap-2">
            <input className="input flex-1" placeholder="Ask a question about this course…" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1500} />
            <button className="btn !px-4" disabled={busy || !question.trim()} aria-label="Send">
              <Send className="h-4 w-4" />
            </button>
          </form>
          {error && <p className="mt-2 text-xs font-medium text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}
