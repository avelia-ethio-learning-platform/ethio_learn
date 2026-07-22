'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, Flag, MessageSquareText, PartyPopper, ShieldCheck, Timer } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { PageHeader, PageShell } from '@/components/PageChrome';

function QaQueue() {
  const queryClient = useQueryClient();
  const { data: queue } = useQuery({ queryKey: ['qa-queue'], queryFn: () => api<any[]>('/qa/queue'), refetchInterval: 30_000 });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');

  const decide = async (courseId: string, action: 'approve' | 'coach' | 'flag') => {
    setMessage('');
    try {
      await api(`/qa/courses/${courseId}/decision`, { method: 'POST', body: { action, notes: notes[courseId] || undefined } });
      setMessage(`Decision recorded: ${action}`);
      queryClient.invalidateQueries({ queryKey: ['qa-queue'] });
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <ShieldCheck className="h-4 w-4 text-brand-500" /> Quality
          </span>
        }
        title="Quality review queue"
        subtitle="Checklist review: spam · illegal content · policy violations · fraud signals. SLA: 24–48h from submission."
      />
      <div className="space-y-6">
        {message && <p className="badge-info w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm">{message}</p>}

        {!queue?.length ? (
          <div className="card flex animate-fade-in-up items-center justify-center gap-2 py-10 text-sm text-gray-500">
            <PartyPopper className="h-5 w-5 text-brand-500" /> Queue is empty.
          </div>
        ) : (
          queue.map((item) => {
            const hoursLeft = Math.round((new Date(item.sla_deadline).getTime() - Date.now()) / 3_600_000);
            const plagiarism = item.plagiarism ?? {};
            return (
              <div key={item.id} className="card animate-fade-in-up !rounded-3xl">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-bold text-foreground">{item.course_title}</h2>
                    <p className="mt-0.5 text-xs text-gray-500">
                      by {item.owner_name || item.owner_email || item.owner_id} ({item.owner_type}) · trigger: {item.trigger}
                    </p>
                  </div>
                  <span className={hoursLeft < 8 ? 'badge-danger' : 'badge-warn'}>
                    <Timer className="h-3 w-3" /> SLA: {hoursLeft > 0 ? `${hoursLeft}h left` : 'OVERDUE'}
                  </span>
                </div>

                {'similarity_score' in plagiarism && (
                  <p className={`mt-3 text-sm font-medium ${plagiarism.flagged ? 'text-red-500' : 'text-gray-500'}`}>
                    AI plagiarism screen: score {String(plagiarism.similarity_score)}/100
                    {plagiarism.flagged ? ' — FLAGGED' : ' — clear'} {plagiarism.reason ? `(${plagiarism.reason})` : ''}
                  </p>
                )}

                <Link
                  href={`/preview/${item.course_id}`}
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
                >
                  <Eye className="h-4 w-4" /> Preview course content
                </Link>

                <textarea
                  className="input mt-4"
                  placeholder="Notes (required for 'coach')"
                  value={notes[item.course_id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [item.course_id]: e.target.value }))}
                />
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className="btn" onClick={() => decide(item.course_id, 'approve')}>
                    <CheckCircle2 className="h-4 w-4" /> Approve → publish
                  </button>
                  <button className="btn-secondary" onClick={() => decide(item.course_id, 'coach')}>
                    <MessageSquareText className="h-4 w-4" /> Coach → back to draft
                  </button>
                  <button
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow transition-all hover:-translate-y-px hover:bg-red-700"
                    onClick={() => decide(item.course_id, 'flag')}
                  >
                    <Flag className="h-4 w-4" /> Flag (policy violation)
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </PageShell>
  );
}

export default function QaPage() {
  return (
    <RequireRole roles={['quality_officer', 'platform_admin']}>
      <QaQueue />
    </RequireRole>
  );
}
