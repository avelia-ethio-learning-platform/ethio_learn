'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';

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
    <div className="space-y-6">
      <BackButton fallback="/institution" label="Institution" />
      <h1 className="text-2xl font-bold">Internal review queue</h1>
      <p className="text-sm text-gray-500">Review your instructors&apos; courses. Approving forwards them to the platform quality officers for final review.</p>
      {msg && <p className="rounded bg-brand-50 px-3 py-2 text-sm text-brand-800">{msg}</p>}
      {!queue?.length ? (
        <div className="card text-sm text-gray-500">Nothing awaiting your review. 🎉</div>
      ) : (
        queue.map((c) => (
          <div key={c.id} className="card">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{c.title}</h2>
              <span className="text-xs text-gray-400">{c.category} · {c.pricing_type}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              👤 Created by <span className="font-medium text-gray-700">{c.instructor_name || 'Unknown instructor'}</span>
              {c.instructor_email && <span className="text-gray-400"> ({c.instructor_email})</span>}
            </p>
            <p className="mt-1 line-clamp-2 text-sm text-gray-600">{c.description}</p>
            <Link href={`/preview/${c.id}`} className="mt-2 inline-block text-sm text-brand-700 underline">Preview content →</Link>
            <textarea className="input mt-3" placeholder="Notes for the instructor (shown on reject)" value={notes[c.id] ?? ''} onChange={(e) => setNotes((p) => ({ ...p, [c.id]: e.target.value }))} />
            <div className="mt-3 flex gap-2">
              <button className="btn" onClick={() => decide(c.id, 'approve')}>Approve → send to platform</button>
              <button className="btn-secondary" onClick={() => decide(c.id, 'reject')}>Send back to instructor</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export default function InstitutionReviewPage() {
  return (
    <RequireRole roles={['institution_admin']}>
      <ReviewQueue />
    </RequireRole>
  );
}
