'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
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

function TeachDashboard() {
  const { data: courses } = useQuery({ queryKey: ['own-courses'], queryFn: () => api<any[]>('/courses') });
  const { data: balance } = useQuery({ queryKey: ['balance'], queryFn: () => api<any>('/payouts/balance') });
  const { data: payouts } = useQuery({ queryKey: ['payouts'], queryFn: () => api<any[]>('/payouts') });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: () => api<any>('/profiles/me') });

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Educator dashboard</h1>
        <Link href="/teach/new" className="btn">+ New course</Link>
      </div>

      {profile && !profile.educator_profile && <EducatorSetup />}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-xs uppercase text-gray-500">Pending earnings (net, 80%)</p>
          <p className="mt-1 text-2xl font-bold">{balance?.pending_net_etb ?? 0} ETB</p>
          <p className="text-xs text-gray-400">from {balance?.payment_count ?? 0} settled payments</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase text-gray-500">Courses</p>
          <p className="mt-1 text-2xl font-bold">{courses?.length ?? 0}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase text-gray-500">Payouts received</p>
          <p className="mt-1 text-2xl font-bold">{payouts?.filter((p) => p.status === 'paid').length ?? 0}</p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">My courses</h2>
        {!courses?.length ? (
          <div className="card text-sm text-gray-500">No courses yet — create your first one.</div>
        ) : (
          <div className="card divide-y">
            {courses.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <p className="font-medium">{c.title}</p>
                  <p className="text-xs text-gray-500">{c.category} · {c.pricing_type}{c.price_etb ? ` · ${c.price_etb} ETB` : ''}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLORS[c.status] ?? ''}`}>{c.status}</span>
                  <Link href={`/teach/courses/${c.id}`} className="text-brand-700 underline">Manage</Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Payout history</h2>
        <div className="card divide-y text-sm">
          {!payouts?.length && <p className="text-gray-500">No payouts yet. Payouts run nightly on settled payments (7–14 day hold).</p>}
          {payouts?.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2">
              <span>{new Date(p.created_at).toDateString()}</span>
              <span>net {p.net_amount_etb} ETB (gross {p.gross_amount_etb})</span>
              <span className={`rounded px-2 py-0.5 text-xs ${p.status === 'paid' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                {p.status}{p.hold_reason ? ` · ${p.hold_reason}` : ''}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function EducatorSetup() {
  return (
    <div className="card border-amber-300 bg-amber-50">
      <p className="text-sm font-medium">Finish your educator profile</p>
      <form
        className="mt-2 grid gap-2 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          await api('/profiles/educator', { method: 'POST', body: { bio: form.get('bio'), expertise_area: form.get('expertise') } });
          location.reload();
        }}
      >
        <input name="expertise" required placeholder="Expertise area (e.g. Web Development)" className="input" />
        <textarea name="bio" required placeholder="Short bio" className="input" />
        <button className="btn sm:col-span-2">Save profile</button>
      </form>
    </div>
  );
}

export default function TeachPage() {
  return (
    <RequireRole roles={['educator']}>
      <TeachDashboard />
    </RequireRole>
  );
}
