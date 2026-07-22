'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  institution_review: 'bg-blue-100 text-blue-800',
  submitted: 'bg-amber-100 text-amber-800',
  under_review: 'bg-amber-100 text-amber-800',
  published: 'bg-green-100 text-green-800',
  flagged: 'bg-red-100 text-red-700',
  unlisted: 'bg-gray-200 text-gray-600',
  archived: 'bg-gray-200 text-gray-500',
};

const USTATUS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  suspended: 'bg-amber-100 text-amber-800',
  banned: 'bg-red-100 text-red-700',
};

function InstitutionDashboard() {
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: () => api<any>('/profiles/me') });
  const institution = profile?.institution;

  if (profile && !institution) return <InstitutionSetup />;
  if (!institution) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{institution.name}</h1>
        <Link href="/institution/review" className="btn">Review queue →</Link>
      </div>
      <InstructorManager institutionId={institution.id} />
      <InstitutionCourses />
    </div>
  );
}

function InstitutionSetup() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">Register your institution</h1>
      <p className="mt-2 text-sm text-gray-600">Create your institution, then invite instructors — they create courses, you review them before they go to the platform.</p>
      <form
        className="card mt-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          await api('/profiles/institution', { method: 'POST', body: { name: form.get('name') } });
          location.reload();
        }}
      >
        <input name="name" required placeholder="Institution name" className="input flex-1" />
        <button className="btn">Create</button>
      </form>
    </div>
  );
}

function InstructorManager({ institutionId }: { institutionId: string }) {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState('');
  const { data: instructors } = useQuery({ queryKey: ['instructors', institutionId], queryFn: () => api<any[]>(`/institutions/${institutionId}/instructors`) });

  const moderate = async (userId: string, status: string) => {
    let reason: string | undefined;
    if (status !== 'active') reason = prompt(`Reason for ${status} (optional):`) || undefined;
    try {
      await api(`/institutions/${institutionId}/instructors/${userId}/status`, { method: 'POST', body: { status, reason } });
      queryClient.invalidateQueries({ queryKey: ['instructors', institutionId] });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <section className="card">
      <h2 className="font-semibold">Instructors</h2>
      <div className="mt-2 divide-y text-sm">
        {!instructors?.length && <p className="py-2 text-gray-500">No instructors yet — invite your first below.</p>}
        {instructors?.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>👤 {i.name} <span className="text-gray-400">({i.email})</span> · {i.role_in_org}</span>
            <span className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs ${USTATUS[i.status] ?? ''}`}>{i.status}</span>
              {i.status === 'active' ? (
                <>
                  <button className="text-xs text-amber-700 underline" onClick={() => moderate(i.user_id, 'suspended')}>Suspend</button>
                  <button className="text-xs text-red-600 underline" onClick={() => confirm(`Ban ${i.email}?`) && moderate(i.user_id, 'banned')}>Ban</button>
                </>
              ) : (
                <button className="text-xs text-green-700 underline" onClick={() => moderate(i.user_id, 'active')}>Reactivate</button>
              )}
            </span>
          </div>
        ))}
      </div>
      <form
        className="mt-3 flex flex-wrap gap-2 border-t pt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          try {
            const res = await api<{ invited: boolean; upgraded: boolean }>(`/institutions/${institutionId}/instructors`, { method: 'POST', body: { name: form.get('name'), email: form.get('email') } });
            setMsg(
              res.invited
                ? 'Instructor invited — they’ll get a secure link to set their own password.'
                : res.upgraded
                  ? 'That learner was upgraded to an instructor — they’ll be notified to sign in again.'
                  : 'Existing educator added as an instructor — their independent courses are unchanged.',
            );
            (e.target as HTMLFormElement).reset();
            queryClient.invalidateQueries({ queryKey: ['instructors', institutionId] });
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <input name="name" required placeholder="Instructor name" className="input flex-1" />
        <input name="email" type="email" required placeholder="Instructor email" className="input flex-1" />
        <button className="btn-secondary">Invite instructor</button>
        {msg && <p className="w-full text-xs text-brand-700">{msg}</p>}
      </form>
    </section>
  );
}

function InstitutionCourses() {
  const queryClient = useQueryClient();
  const { data: courses } = useQuery({ queryKey: ['institution-courses'], queryFn: () => api<any[]>('/institution/courses') });
  const act = async (id: string, action: 'unlist' | 'restore') => {
    try {
      await api(`/institution/courses/${id}/${action}`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['institution-courses'] });
    } catch (err) {
      alert((err as Error).message);
    }
  };
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">All institution courses</h2>
      <div className="card divide-y text-sm">
        {!courses?.length && <p className="text-gray-500">No courses yet — your instructors create them.</p>}
        {courses?.map((c) => <InstitutionCourseRow key={c.id} course={c} onAct={act} />)}
      </div>
    </section>
  );
}

function InstitutionCourseRow({ course: c, onAct }: { course: any; onAct: (id: string, action: 'unlist' | 'restore') => void }) {
  const [showFeedback, setShowFeedback] = useState(false);
  const { data: reviews } = useQuery({
    queryKey: ['inst-reviews', c.id],
    queryFn: () => api<any>(`/courses/${c.id}/reviews`),
    enabled: showFeedback,
    retry: false,
  });
  return (
    <div className="py-2">
      <div className="flex items-center justify-between">
        <span>{c.title} <span className="text-xs text-gray-400">({c.category})</span>
          {c.instructor_name && <span className="ml-1 text-xs text-gray-500">· by {c.instructor_name}</span>}
        </span>
        <span className="flex items-center gap-3">
          <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLORS[c.status] ?? ''}`}>{c.status.replace('_', ' ')}</span>
          <Link href={`/preview/${c.id}`} className="text-xs text-brand-700 underline">Preview</Link>
          <button className="text-xs text-brand-700 underline" onClick={() => setShowFeedback((s) => !s)}>{showFeedback ? 'Hide feedback' : 'Feedback'}</button>
          {c.status === 'published' && <button className="text-xs text-brand-700 underline" onClick={() => onAct(c.id, 'unlist')}>Unlist</button>}
          {c.status === 'unlisted' && <button className="text-xs text-brand-700 underline" onClick={() => onAct(c.id, 'restore')}>Restore</button>}
        </span>
      </div>
      {showFeedback && (
        <div className="mt-2 rounded bg-gray-50 p-3">
          {!reviews ? (
            <p className="text-xs text-gray-400">Loading feedback…</p>
          ) : !reviews.reviews?.length ? (
            <p className="text-xs text-gray-500">No learner reviews yet.</p>
          ) : (
            <>
              <p className="text-xs font-medium text-gray-600">★ {reviews.average_rating} · {reviews.review_count} review{reviews.review_count === 1 ? '' : 's'}</p>
              <ul className="mt-2 space-y-1">
                {reviews.reviews.map((r: any) => (
                  <li key={r.id} className="text-xs text-gray-700">
                    <span className="text-amber-500">{'★'.repeat(r.rating)}</span>{r.comment ? ` — ${r.comment}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function InstitutionPage() {
  return (
    <RequireRole roles={['institution_admin']}>
      <InstitutionDashboard />
    </RequireRole>
  );
}
