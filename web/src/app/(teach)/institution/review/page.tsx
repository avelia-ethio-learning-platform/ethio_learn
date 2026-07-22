'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Eye, PartyPopper, Undo2, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';

function ReviewQueue() {
  const queryClient = useQueryClient();
  const { data: queue } = useQuery({ queryKey: ['institution-review'], queryFn: () => api<any[]>('/institution/review-queue') });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const decide = async (courseId: string, action: 'approve' | 'reject') => {
    setMsg('');
    try {
      await api(`/institution/courses/${courseId}/decision`, { method: 'POST', body: { action, notes: notes[courseId] || undefined } });
      setMsg(action === 'approve' ? 'Approved and forwarded to platform quality review.' : 'Sent back to the instructor.');
      queryClient.invalidateQueries({ queryKey: ['institution-review'] });
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <BackButton fallback="/institution" label="Institution" />
        <div className="animate-fade-in-up">
          <span className="section-badge">
            <ClipboardList className="h-4 w-4 text-brand-500" /> Internal review
          </span>
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">Internal review queue</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-500">
            Review your instructors&apos; courses. Approving forwards them to the platform quality officers for final review.
          </p>
        </div>
        {msg && <p className="badge-info w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm">{msg}</p>}
        {!queue?.length ? (
          <div className="card flex animate-fade-in-up items-center justify-center gap-2 py-10 text-sm text-gray-500">
            <PartyPopper className="h-5 w-5 text-brand-500" /> Nothing awaiting your review.
          </div>
        ) : (
          queue.map((c) => (
            <div key={c.id} className="card animate-fade-in-up !rounded-3xl">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-bold text-foreground">{c.title}</h2>
                <span className="badge-neutral">
                  {c.category} · {c.pricing_type}
                </span>
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-500">
                <UserRound className="h-3.5 w-3.5 text-brand-400" />
                Created by <span className="font-semibold text-foreground">{c.instructor_name || 'Unknown instructor'}</span>
                {c.instructor_email && <span className="text-gray-400">({c.instructor_email})</span>}
              </p>
              <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-gray-600">{c.description}</p>
              <Link href={`/preview/${c.id}`} className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline">
                <Eye className="h-4 w-4" /> Preview content
              </Link>
              <textarea
                className="input mt-4"
                placeholder="Notes for the instructor (shown on reject)"
                value={notes[c.id] ?? ''}
                onChange={(e) => setNotes((p) => ({ ...p, [c.id]: e.target.value }))}
              />
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn" onClick={() => decide(c.id, 'approve')}>
                  <CheckCircle2 className="h-4 w-4" /> Approve → send to platform
                </button>
                <button className="btn-secondary" onClick={() => decide(c.id, 'reject')}>
                  <Undo2 className="h-4 w-4" /> Send back to instructor
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </PageShell>
  );
}

export default function InstitutionReviewPage() {
  return (
    <RequireRole roles={['institution_admin']}>
      <ReviewQueue />
    </RequireRole>
  );
}
