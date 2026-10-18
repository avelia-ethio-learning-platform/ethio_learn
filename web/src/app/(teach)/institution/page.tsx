'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Building2, Eye, MessageSquareText, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { categoryLabel } from '@/lib/labels';
import { PageHeader, PageShell, StatusBadge } from '@/components/PageChrome';
import { BulkPurchases } from './bulk-purchases';
import { InstructorManager } from './instructor-manager';

function InstitutionDashboard() {
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: () => api<any>('/profiles/me') });
  const institution = profile?.institution;

  if (profile && !institution) return <InstitutionSetup />;
  if (!institution) {
    return (
      <PageShell>
        <div className="space-y-4">
          <div className="skeleton h-9 w-64" />
          <div className="skeleton h-40 w-full" />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <Building2 className="h-4 w-4 text-brand-500" aria-hidden /> Institution
          </span>
        }
        title={institution.name}
        subtitle="Manage instructors and review their courses before they reach the platform."
        actions={
          <Link href="/institution/review" className="btn w-full sm:w-auto">
            Review queue <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        }
      />
      <div className="space-y-10">
        <InstructorManager institutionId={institution.id} />
        <BulkPurchases organizationName={institution.name} />
        <InstitutionCourses />
      </div>
    </PageShell>
  );
}

function InstitutionSetup() {
  const [status, , setError] = useFormStatus();
  const [busy, setBusy] = useState(false);
  return (
    <PageShell>
      <div className="mx-auto max-w-md animate-fade-in-up">
        <div className="text-center">
          <span className="gradient-bg-blue mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-floating">
            <Building2 className="h-6 w-6" />
          </span>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">Register your institution</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            Create your institution, then invite instructors — they create courses, you review them before they go to the platform.
          </p>
        </div>
        <form
          className="card mt-6 space-y-3 !rounded-3xl"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            try {
              await api('/profiles/institution', { method: 'POST', body: { name: form.get('name') } });
              location.reload();
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          <Field label="Institution name">{(ids) => <input {...ids} name="name" required className="input" />}</Field>
          <button className="btn w-full sm:w-auto" disabled={busy}>
            Create
          </button>
          <FormStatus status={status} />
        </form>
      </div>
    </PageShell>
  );
}

function InstitutionCourses() {
  const queryClient = useQueryClient();
  const ask = useConfirm();
  const [status, , setError, clear] = useFormStatus();
  const [busy, setBusy] = useState(false);
  const { data: courses } = useQuery({ queryKey: ['institution-courses'], queryFn: () => api<any[]>('/institution/courses') });
  const act = async (course: { id: string; title: string }, action: 'unlist' | 'restore') => {
    if (busy) return; // aria-disabled, not disabled: the clicked button keeps the focus the dialog gives back
    if (
      action === 'unlist' &&
      !(await ask({
        title: `Unlist ${course.title}?`,
        body: 'It is hidden from the catalog. Enrolled learners keep access, and you can restore it later.',
        confirmLabel: 'Unlist',
      }))
    )
      return;
    setBusy(true);
    clear();
    try {
      await api(`/institution/courses/${course.id}/${action}`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['institution-courses'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="animate-fade-in-up">
      <h2 className="mb-4 text-lg font-bold text-foreground">All institution courses</h2>
      <FormStatus status={status} />
      <div className="card !p-0 overflow-hidden text-sm">
        {!courses?.length && <p className="px-5 py-4 text-gray-500">No courses yet — your instructors create them.</p>}
        {courses?.map((c, i) => (
          <div key={c.id} style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}>
            <InstitutionCourseRow course={c} busy={busy} onAct={act} />
          </div>
        ))}
      </div>
    </section>
  );
}

function InstitutionCourseRow({
  course: c,
  busy,
  onAct,
}: {
  course: any;
  busy: boolean;
  onAct: (course: { id: string; title: string }, action: 'unlist' | 'restore') => void;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const { data: reviews } = useQuery({
    queryKey: ['inst-reviews', c.id],
    queryFn: () => api<any>(`/courses/${c.id}/reviews`),
    enabled: showFeedback,
    retry: false,
  });
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-foreground">
          <span className="font-semibold">{c.title}</span> <span className="text-xs text-gray-500">({categoryLabel(c.category)})</span>
          {c.instructor_name && <span className="ml-1 text-xs text-gray-500">· by {c.instructor_name}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <StatusBadge status={c.status} />
          <Link href={`/preview/${c.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
            <Eye className="h-3.5 w-3.5" aria-hidden /> Preview
          </Link>
          <button
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
            onClick={() => setShowFeedback((s) => !s)}
          >
            <MessageSquareText className="h-3.5 w-3.5" aria-hidden /> {showFeedback ? 'Hide feedback' : 'Feedback'}
          </button>
          {c.status === 'published' && (
            <button className="text-xs font-medium text-brand-600 hover:underline" aria-disabled={busy} onClick={() => onAct(c, 'unlist')}>
              Unlist
            </button>
          )}
          {c.status === 'unlisted' && (
            <button className="text-xs font-medium text-brand-600 hover:underline" aria-disabled={busy} onClick={() => onAct(c, 'restore')}>
              Restore
            </button>
          )}
        </span>
      </div>
      {showFeedback && (
        <div className="glass-secondary mt-3 rounded-xl p-3">
          {!reviews ? (
            <p className="text-xs text-gray-500">Loading feedback…</p>
          ) : !reviews.reviews?.length ? (
            <p className="text-xs text-gray-500">No learner reviews yet.</p>
          ) : (
            <>
              <p className="flex items-center gap-1 text-xs font-semibold text-gray-600">
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                {reviews.average_rating} · {reviews.review_count} review{reviews.review_count === 1 ? '' : 's'}
              </p>
              <ul className="mt-2 space-y-1">
                {reviews.reviews.map((r: any) => (
                  <li key={r.id} className="text-xs text-gray-600">
                    <span className="text-amber-700 dark:text-amber-400">{'★'.repeat(r.rating)}</span>
                    {r.comment ? ` — ${r.comment}` : ''}
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
