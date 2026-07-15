'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, HandCoins, LayoutDashboard, Plus, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { PageHeader, PageShell, StatusBadge } from '@/components/PageChrome';

function TeachDashboard() {
  const { data: courses } = useQuery({ queryKey: ['own-courses'], queryFn: () => api<any[]>('/courses') });
  const { data: balance } = useQuery({ queryKey: ['balance'], queryFn: () => api<any>('/payouts/balance') });
  const { data: payouts } = useQuery({ queryKey: ['payouts'], queryFn: () => api<any[]>('/payouts') });
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: () => api<any>('/profiles/me') });

  const stats = [
    {
      icon: Wallet,
      label: 'Pending earnings (net, 80%)',
      value: `${balance?.pending_net_etb ?? 0} ETB`,
      hint: `from ${balance?.payment_count ?? 0} settled payments`,
    },
    { icon: BookOpen, label: 'Courses', value: courses?.length ?? 0, hint: 'drafts + published' },
    { icon: HandCoins, label: 'Payouts received', value: payouts?.filter((p) => p.status === 'paid').length ?? 0, hint: 'nightly runs' },
  ];

  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <LayoutDashboard className="h-4 w-4 text-brand-500" /> Educator
          </span>
        }
        title="Educator dashboard"
        subtitle="Create courses, track earnings and get paid nightly."
        actions={
          <Link href="/teach/new" className="btn">
            <Plus className="h-4 w-4" /> New course
          </Link>
        }
      />

      <div className="space-y-10">
        {profile && !profile.educator_profile && <EducatorSetup />}

        <section className="grid animate-fade-in-up gap-4 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label} className="card card-hover">
              <div className="flex items-start justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{s.label}</p>
                <span className="glass-secondary flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
                  <s.icon className="h-4 w-4 text-brand-600" />
                </span>
              </div>
              <p className="gradient-text-blue mt-2 text-3xl font-extrabold">{s.value}</p>
              <p className="mt-1 text-xs text-gray-400">{s.hint}</p>
            </div>
          ))}
        </section>

        <section className="animate-fade-in-up">
          <h2 className="mb-4 text-lg font-bold text-foreground">My courses</h2>
          {!courses?.length ? (
            <div className="card py-10 text-center text-sm text-gray-500">
              No courses yet — create your first one.
              <div className="mt-4">
                <Link href="/teach/new" className="btn">
                  <Plus className="h-4 w-4" /> Create a course
                </Link>
              </div>
            </div>
          ) : (
            <div className="card !p-0 overflow-hidden">
              {courses.map((c, i) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm transition-colors hover:bg-brand-500/5"
                  style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{c.title}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {c.category} · {c.pricing_type}
                      {c.price_etb ? ` · ${c.price_etb} ETB` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <StatusBadge status={c.status} />
                    <Link href={`/teach/courses/${c.id}`} className="btn-secondary !px-3 !py-1.5 !text-xs">
                      Manage
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="animate-fade-in-up">
          <h2 className="mb-4 text-lg font-bold text-foreground">Payout history</h2>
          <div className="card text-sm">
            {!payouts?.length && <p className="py-2 text-gray-500">No payouts yet. Payouts run nightly on settled payments (7–14 day hold).</p>}
            {payouts?.map((p, i) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}
              >
                <span className="text-gray-500">{new Date(p.created_at).toDateString()}</span>
                <span className="font-medium text-foreground">
                  net {p.net_amount_etb} ETB <span className="font-normal text-gray-400">(gross {p.gross_amount_etb})</span>
                </span>
                <StatusBadge status={p.status} suffix={p.hold_reason || undefined} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function EducatorSetup() {
  return (
    <div className="card animate-fade-in-up !border-amber-400/40 bg-gradient-to-br from-amber-500/10 to-transparent">
      <p className="text-sm font-bold text-foreground">Finish your educator profile</p>
      <form
        className="mt-3 grid gap-2 sm:grid-cols-2"
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
