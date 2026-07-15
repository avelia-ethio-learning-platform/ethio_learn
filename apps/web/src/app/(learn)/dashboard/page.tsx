'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Award, BookOpen, Download, ExternalLink, GraduationCap, ReceiptText, RotateCcw, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RequireRole } from '@/components/RequireRole';
import { PageHeader, PageShell } from '@/components/PageChrome';

function LearnerDashboard() {
  const { t } = useT();
  const { data: enrollments, isLoading: enrollLoading } = useQuery({ queryKey: ['enrollments'], queryFn: () => api<any[]>('/enrollments') });
  const { data: certificates } = useQuery({ queryKey: ['certificates'], queryFn: () => api<any[]>('/me/certificates') });
  const { data: payments } = useQuery({ queryKey: ['payments'], queryFn: () => api<any[]>('/payments/mine') });
  const { data: refunds } = useQuery({ queryKey: ['refunds'], queryFn: () => api<any[]>('/refunds/mine') });

  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <GraduationCap className="h-4 w-4 text-brand-500" /> {t('my_learning')}
          </span>
        }
        title={t('my_learning')}
        subtitle="Your courses, certificates and payments in one place."
      />

      <div className="space-y-10">
        <section className="animate-fade-in-up">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
            <BookOpen className="h-5 w-5 text-brand-500" /> {t('enrolled_courses')}
          </h2>
          {enrollLoading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="skeleton h-36" />
              <div className="skeleton h-36" />
            </div>
          ) : !enrollments?.length ? (
            <div className="card py-8 text-center text-sm text-gray-500">
              Nothing yet —{' '}
              <Link href="/#courses" className="font-semibold text-brand-600 hover:underline">
                browse the catalog
              </Link>
              .
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {enrollments.map((e) => (
                <div key={e.id} className="card card-hover">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 flex-1 font-semibold text-foreground">{e.course_title ?? 'Course'}</h3>
                    <span className={e.entitlement_status === 'active' ? 'badge-success' : 'badge-neutral'}>{e.entitlement_status}</span>
                  </div>
                  <div className="progress-track mt-4">
                    <div className="progress-fill" style={{ width: `${e.progress_percent}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    {e.progress_percent}% {t('progress')}
                    {e.completed_at ? ' · finished 🎉' : ''}
                  </p>
                  {e.entitlement_status === 'active' && (
                    <Link href={`/learn/${e.course_id}`} className="btn-secondary mt-4 inline-flex !px-3 !py-1.5 !text-xs">
                      {e.completed_at ? 'Revisit' : t('continue_learning')} <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="animate-fade-in-up">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
            <Award className="h-5 w-5 text-brand-500" /> {t('certificates')}
          </h2>
          {!certificates?.length ? (
            <p className="text-sm text-gray-500">Complete a course (and its assessments) to earn a verifiable certificate.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {certificates.map((c) => (
                <div key={c.id} className="card card-hover relative overflow-hidden">
                  <span className="gradient-ethiopia absolute inset-x-0 top-0 h-1 opacity-70" />
                  <p className="flex items-center gap-2 font-semibold text-foreground">
                    <span className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl">
                      <Award className="h-4 w-4 text-brand-600" />
                    </span>
                    {c.course_title}
                  </p>
                  <p className="mt-2 text-xs text-gray-500">Issued {new Date(c.issued_at).toDateString()}</p>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    <a className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline" href={c.verify_url}>
                      <ExternalLink className="h-3.5 w-3.5" /> Public verification
                    </a>
                    <DownloadCert id={c.id} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="animate-fade-in-up">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
              <ReceiptText className="h-5 w-5 text-brand-500" /> {t('payment_history')}
            </h2>
            <div className="card text-sm">
              {!payments?.length && <p className="py-2 text-gray-500">No payments yet.</p>}
              {payments?.map((p, i) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 py-2.5"
                  style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">{p.course_title}</span>
                  <span className="shrink-0 text-gray-500">
                    {p.amount_etb} ETB · {p.status}
                  </span>
                  {p.status === 'confirmed' && <RefundButton paymentId={p.id} />}
                </div>
              ))}
            </div>
          </div>
          <div className="animate-fade-in-up">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
              <Undo2 className="h-5 w-5 text-brand-500" /> {t('refund_requests')}
            </h2>
            <div className="card text-sm">
              {!refunds?.length && <p className="py-2 text-gray-500">No refund requests.</p>}
              {refunds?.map((r, i) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 py-2.5"
                  style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}
                >
                  <span className="min-w-0 flex-1 truncate pr-2 text-foreground">{r.reason}</span>
                  <span className={r.status === 'approved' ? 'badge-success' : r.status === 'denied' ? 'badge-danger' : 'badge-warn'}>
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function DownloadCert({ id }: { id: string }) {
  return (
    <button
      className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
      onClick={async () => {
        const res = await api<{ url: string }>(`/me/certificates/${id}/download`);
        window.open(res.url, '_blank');
      }}
    >
      <Download className="h-3.5 w-3.5" /> Download PDF
    </button>
  );
}

function RefundButton({ paymentId }: { paymentId: string }) {
  return (
    <button
      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-red-500 hover:underline"
      onClick={async () => {
        const reason = prompt('Why do you want a refund?');
        if (!reason) return;
        try {
          const res = await api<{ status: string; rule: string }>(`/refunds`, { method: 'POST', body: { payment_id: paymentId, reason } });
          alert(`Refund request: ${res.status} (${res.rule}). Refresh to see updates.`);
        } catch (err) {
          alert((err as Error).message);
        }
      }}
    >
      <RotateCcw className="h-3 w-3" /> Refund
    </button>
  );
}

export default function DashboardPage() {
  return (
    <RequireRole roles={['learner']}>
      <LearnerDashboard />
    </RequireRole>
  );
}
