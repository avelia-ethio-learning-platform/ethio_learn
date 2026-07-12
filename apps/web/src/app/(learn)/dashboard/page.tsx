'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';

function LearnerDashboard() {
  const { data: enrollments, isLoading: enrollLoading } = useQuery({ queryKey: ['enrollments'], queryFn: () => api<any[]>('/enrollments') });
  const { data: certificates } = useQuery({ queryKey: ['certificates'], queryFn: () => api<any[]>('/me/certificates') });
  const { data: payments } = useQuery({ queryKey: ['payments'], queryFn: () => api<any[]>('/payments/mine') });
  const { data: refunds } = useQuery({ queryKey: ['refunds'], queryFn: () => api<any[]>('/refunds/mine') });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">My Learning</h1>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Enrolled courses</h2>
        {enrollLoading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card h-28 animate-pulse bg-gray-50" />
            <div className="card h-28 animate-pulse bg-gray-50" />
          </div>
        ) : !enrollments?.length ? (
          <div className="card text-sm text-gray-500">
            Nothing yet — <Link href="/" className="text-brand-700 underline">browse the catalog</Link>.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {enrollments.map((e) => (
              <div key={e.id} className="card">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{e.course_title ?? 'Course'}</h3>
                  <span className={`rounded px-2 py-0.5 text-xs ${e.entitlement_status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                    {e.entitlement_status}
                  </span>
                </div>
                <div className="mt-3 h-2 rounded bg-gray-100">
                  <div className="h-2 rounded bg-brand-600" style={{ width: `${e.progress_percent}%` }} />
                </div>
                <p className="mt-1 text-xs text-gray-500">{e.progress_percent}% complete{e.completed_at ? ' · finished 🎉' : ''}</p>
                {e.entitlement_status === 'active' && (
                  <Link href={`/learn/${e.course_id}`} className="btn-secondary mt-3 inline-flex text-xs">
                    {e.completed_at ? 'Revisit' : 'Continue'} →
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Certificates</h2>
        {!certificates?.length ? (
          <p className="text-sm text-gray-500">Complete a course (and its assessments) to earn a verifiable certificate.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {certificates.map((c) => (
              <div key={c.id} className="card">
                <p className="font-medium">🎓 {c.course_title}</p>
                <p className="text-xs text-gray-500">Issued {new Date(c.issued_at).toDateString()}</p>
                <div className="mt-2 flex gap-3 text-xs">
                  <a className="text-brand-700 underline" href={c.verify_url}>Public verification</a>
                  <DownloadCert id={c.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-3 text-lg font-semibold">Payment history</h2>
          <div className="card divide-y text-sm">
            {!payments?.length && <p className="text-gray-500">No payments yet.</p>}
            {payments?.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2">
                <span>{p.course_title}</span>
                <span className="text-gray-500">{p.amount_etb} ETB · {p.status}</span>
                {p.status === 'confirmed' && <RefundButton paymentId={p.id} />}
              </div>
            ))}
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-lg font-semibold">Refund requests</h2>
          <div className="card divide-y text-sm">
            {!refunds?.length && <p className="text-gray-500">No refund requests.</p>}
            {refunds?.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2">
                <span className="truncate pr-2">{r.reason}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${r.status === 'approved' ? 'bg-green-100 text-green-800' : r.status === 'denied' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function DownloadCert({ id }: { id: string }) {
  return (
    <button
      className="text-brand-700 underline"
      onClick={async () => {
        const res = await api<{ url: string }>(`/me/certificates/${id}/download`);
        window.open(res.url, '_blank');
      }}
    >
      Download PDF
    </button>
  );
}

function RefundButton({ paymentId }: { paymentId: string }) {
  return (
    <button
      className="ml-2 text-xs text-red-600 underline"
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
      Refund
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
