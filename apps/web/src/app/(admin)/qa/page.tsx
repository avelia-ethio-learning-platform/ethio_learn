'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';

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
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Quality review queue</h1>
      <p className="text-sm text-gray-500">
        Checklist review: spam · illegal content · policy violations · fraud signals. SLA: 24–48h from submission.
      </p>
      {message && <p className="rounded bg-brand-50 px-3 py-2 text-sm text-brand-800">{message}</p>}

      {!queue?.length ? (
        <div className="card text-sm text-gray-500">Queue is empty. 🎉</div>
      ) : (
        queue.map((item) => {
          const hoursLeft = Math.round((new Date(item.sla_deadline).getTime() - Date.now()) / 3_600_000);
          const plagiarism = item.plagiarism ?? {};
          return (
            <div key={item.id} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{item.course_title}</h2>
                  <p className="text-xs text-gray-500">
                    by {item.owner_name || item.owner_email || item.owner_id} ({item.owner_type}) · trigger: {item.trigger}
                  </p>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs ${hoursLeft < 8 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>
                  SLA: {hoursLeft > 0 ? `${hoursLeft}h left` : 'OVERDUE'}
                </span>
              </div>

              {'similarity_score' in plagiarism && (
                <p className={`mt-2 text-sm ${plagiarism.flagged ? 'text-red-600' : 'text-gray-600'}`}>
                  AI plagiarism screen: score {String(plagiarism.similarity_score)}/100
                  {plagiarism.flagged ? ' — FLAGGED' : ' — clear'} {plagiarism.reason ? `(${plagiarism.reason})` : ''}
                </p>
              )}

              <Link href={`/preview/${item.course_id}`} className="mt-2 inline-block text-sm text-brand-700 underline">
                Preview course content →
              </Link>

              <textarea
                className="input mt-3"
                placeholder="Notes (required for 'coach')"
                value={notes[item.course_id] ?? ''}
                onChange={(e) => setNotes((prev) => ({ ...prev, [item.course_id]: e.target.value }))}
              />
              <div className="mt-3 flex gap-2">
                <button className="btn" onClick={() => decide(item.course_id, 'approve')}>Approve → publish</button>
                <button className="btn-secondary" onClick={() => decide(item.course_id, 'coach')}>Coach → back to draft</button>
                <button className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700" onClick={() => decide(item.course_id, 'flag')}>
                  Flag (policy violation)
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export default function QaPage() {
  return (
    <RequireRole roles={['quality_officer', 'platform_admin']}>
      <QaQueue />
    </RequireRole>
  );
}
