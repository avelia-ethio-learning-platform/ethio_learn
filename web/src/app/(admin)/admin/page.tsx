'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Inbox, PartyPopper, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { PageHeader, PageShell, StatusBadge } from '@/components/PageChrome';

type Tab = 'payments' | 'payouts' | 'refunds' | 'fraud' | 'users' | 'courses';

function AdminConsole() {
  const [tab, setTab] = useState<Tab>('payments');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'payments', label: 'Payments' },
    { id: 'payouts', label: 'Payouts' },
    { id: 'refunds', label: 'Refunds' },
    { id: 'fraud', label: 'Fraud flags' },
    { id: 'users', label: 'Users' },
    { id: 'courses', label: 'Course overrides' },
  ];
  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <ShieldCheck className="h-4 w-4 text-brand-500" /> Platform admin
          </span>
        }
        title="Platform admin console"
        subtitle="Payments ledger, payouts, refunds, fraud signals, users and course overrides."
      />
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={tab === t.id ? 'pill-active' : 'pill'}>
              {t.label}
            </button>
          ))}
        </div>
        <div key={tab} className="animate-fade-in-up">
          {tab === 'payments' && <PaymentsTab />}
          {tab === 'payouts' && <PayoutsTab />}
          {tab === 'refunds' && <RefundsTab />}
          {tab === 'fraud' && <FraudTab />}
          {tab === 'users' && <UsersTab />}
          {tab === 'courses' && <CoursesTab />}
        </div>
      </div>
    </PageShell>
  );
}

/** Friendly empty state for admin lists. */
function EmptyRows({ label, happy = false }: { label: string; happy?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2.5 py-10 text-center text-sm text-gray-400">
      <span className="glass-secondary flex h-11 w-11 items-center justify-center rounded-2xl">
        {happy ? <PartyPopper className="h-5 w-5 text-brand-400" /> : <Inbox className="h-5 w-5 text-brand-400" />}
      </span>
      {label}
    </div>
  );
}

function PaymentsTab() {
  const { data } = useQuery({ queryKey: ['admin-payments'], queryFn: () => api<any>('/admin/payments') });
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Payment ledger ({data?.total ?? 0})</h2>
        <BankTransferForm />
      </div>
      <div className="divide-y text-sm">
        {!data?.items?.length && <EmptyRows label="No payments yet." />}
        {data?.items?.map((p: any) => (
          <div key={p.id}>
            <button
              className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-brand-500/5"
              onClick={() => setOpenId(openId === p.id ? null : p.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{p.course_title}</span>
                <span className="block truncate text-xs text-gray-500">{p.learner_name} · {p.learner_email}</span>
              </span>
              <span className="hidden whitespace-nowrap text-xs text-gray-500 sm:inline">{new Date(p.created_at).toLocaleString()}</span>
              <span className="whitespace-nowrap font-medium text-foreground">{p.amount_etb} ETB</span>
              <StatusBadge status={p.status} />
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${openId === p.id ? 'rotate-180' : ''}`}
              />
            </button>
            {openId === p.id && (
              <dl className="glass-secondary mb-2 grid animate-fade-in gap-x-6 gap-y-1 rounded-xl p-3 text-xs sm:grid-cols-2">
                <div><dt className="inline font-medium text-gray-500">Paid by: </dt><dd className="inline">{p.learner_name} ({p.learner_email})</dd></div>
                <div><dt className="inline font-medium text-gray-500">Method: </dt><dd className="inline">{p.method}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Initiated: </dt><dd className="inline">{new Date(p.created_at).toLocaleString()}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Confirmed (webhook): </dt><dd className="inline">{p.webhook_received_at ? new Date(p.webhook_received_at).toLocaleString() : '— not yet'}</dd></div>
                <div className="sm:col-span-2"><dt className="inline font-medium text-gray-500">Transaction ref: </dt><dd className="inline font-mono">{p.tx_ref}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Payee: </dt><dd className="inline">{p.payee_type}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Payout: </dt><dd className="inline">{p.payout_id ? 'included in payout' : 'not yet paid out'}</dd></div>
              </dl>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function BankTransferForm() {
  const [learner, setLearner] = useState<{ id: string; label: string } | null>(null);
  const [course, setCourse] = useState<{ id: string; label: string } | null>(null);
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <SearchPicker
        label="Learner"
        placeholder="search email/name…"
        selected={learner}
        onSelect={setLearner}
        fetcher={async (q) => {
          const res = await api<{ items: any[] }>(`/admin/users?q=${encodeURIComponent(q)}`);
          return res.items.filter((u) => u.role === 'learner').map((u) => ({ id: u.id, label: `${u.name} (${u.email})` }));
        }}
      />
      <SearchPicker
        label="Course"
        placeholder="search title…"
        selected={course}
        onSelect={setCourse}
        fetcher={async (q) => (await api<any[]>(`/admin/courses?q=${encodeURIComponent(q)}`)).map((c) => ({ id: c.id, label: `${c.title} [${c.status}]` }))}
      />
      <button
        className="btn-secondary text-xs"
        disabled={!learner || !course}
        onClick={async () => {
          try {
            await api('/admin/payments/bank-transfer', { method: 'POST', body: { learner_id: learner!.id, course_id: course!.id } });
            alert('Bank transfer recorded — entitlement grants via PaymentConfirmed.');
          } catch (err) {
            alert((err as Error).message);
          }
        }}
      >
        Mark bank transfer
      </button>
    </div>
  );
}

/** Type-to-search picker that returns {id,label} — replaces raw UUID inputs. */
function SearchPicker({
  label,
  placeholder,
  selected,
  onSelect,
  fetcher,
}: {
  label: string;
  placeholder: string;
  selected: { id: string; label: string } | null;
  onSelect: (v: { id: string; label: string } | null) => void;
  fetcher: (q: string) => Promise<{ id: string; label: string }[]>;
}) {
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['picker', label, q], queryFn: () => fetcher(q), enabled: q.length >= 2 && !selected });
  return (
    <div className="relative">
      <label className="mb-0.5 block text-[10px] uppercase text-gray-400">{label}</label>
      {selected ? (
        <div className="flex items-center gap-1">
          <span className="badge-info max-w-[220px] truncate !normal-case">{selected.label}</span>
          <button className="text-gray-400 hover:text-red-500" onClick={() => { onSelect(null); setQ(''); }}>✕</button>
        </div>
      ) : (
        <>
          <input className="input w-56 text-xs" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
          {!!data?.length && (
            <div
              className="absolute z-10 mt-1 max-h-48 w-56 overflow-y-auto rounded-xl shadow-floating"
              style={{ background: 'var(--popover)', border: '1px solid var(--card-border)' }}
            >
              {data.map((o) => (
                <button key={o.id} className="block w-full truncate px-3 py-1.5 text-left transition-colors hover:bg-brand-500/10" onClick={() => onSelect(o)}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PayoutsTab() {
  const queryClient = useQueryClient();
  const { data: payouts } = useQuery({ queryKey: ['admin-payouts'], queryFn: () => api<any[]>('/payouts') });
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Payouts</h2>
        <button
          className="btn-secondary text-xs"
          onClick={async () => {
            const res = await api<any>('/payouts/run', { method: 'POST' });
            alert(`Payout run: ${res.created} disbursed, ${res.held} held`);
            queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
          }}
        >
          Run payouts now
        </button>
      </div>
      <div className="divide-y text-sm">
        {payouts?.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span className="truncate pr-2 text-xs text-gray-500">{p.payee_type} {p.payee_id.slice(0, 8)}…</span>
            <span className="font-medium text-foreground">net {p.net_amount_etb} ETB</span>
            <span className="flex items-center gap-2">
              <StatusBadge status={p.status} suffix={p.hold_reason || undefined} />
              {p.status === 'held' && (
                <button
                  className="text-xs font-medium text-brand-600 hover:underline"
                  onClick={async () => {
                    await api(`/payouts/${p.id}/release`, { method: 'POST' });
                    queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
                  }}
                >
                  release
                </button>
              )}
            </span>
          </div>
        ))}
        {!payouts?.length && <EmptyRows label="No payouts yet." />}
      </div>
    </div>
  );
}

function RefundsTab() {
  const queryClient = useQueryClient();
  const { data: refunds } = useQuery({ queryKey: ['admin-refunds'], queryFn: () => api<any[]>('/refunds/pending') });
  const decide = async (id: string, action: 'approve' | 'deny') => {
    await api(`/refunds/${id}/decide`, { method: 'POST', body: { action } });
    queryClient.invalidateQueries({ queryKey: ['admin-refunds'] });
  };
  return (
    <div className="card">
      <h2 className="mb-3 font-semibold">Refunds awaiting manual review (20–50% consumed)</h2>
      <div className="divide-y text-sm">
        {refunds?.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span className="truncate pr-2">{r.reason}</span>
            <span className="flex gap-3">
              <button className="font-medium text-emerald-600 hover:underline dark:text-emerald-400" onClick={() => decide(r.id, 'approve')}>approve</button>
              <button className="font-medium text-red-500 hover:underline" onClick={() => decide(r.id, 'deny')}>deny</button>
            </span>
          </div>
        ))}
        {!refunds?.length && <EmptyRows happy label="Nothing pending — all caught up." />}
      </div>
    </div>
  );
}

function FraudTab() {
  const queryClient = useQueryClient();
  const { data: flags } = useQuery({ queryKey: ['fraud-flags'], queryFn: () => api<any[]>('/fraud/flags') });
  return (
    <div className="card">
      <h2 className="mb-3 font-semibold">Open fraud flags (payouts auto-held)</h2>
      <div className="divide-y text-sm">
        {flags?.map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span>
              <strong>{f.signal_type}</strong> on {f.subject_type} <code className="text-xs">{f.subject_id.slice(0, 8)}…</code>
              <span className="ml-2 text-xs text-gray-500">{f.detail}</span>
            </span>
            <button
              className="font-medium text-brand-600 hover:underline"
              onClick={async () => {
                await api(`/fraud/flags/${f.id}/resolve`, { method: 'POST' });
                queryClient.invalidateQueries({ queryKey: ['fraud-flags'] });
              }}
            >
              resolve
            </button>
          </div>
        ))}
        {!flags?.length && <EmptyRows happy label="No open flags — all clear." />}
      </div>
    </div>
  );
}

function UsersTab() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['admin-users', q], queryFn: () => api<any>(`/admin/users?q=${encodeURIComponent(q)}`) });

  const setStatus = async (id: string, status: string) => {
    let reason: string | null = '';
    if (status !== 'active') {
      reason = prompt(`Reason for ${status} (optional):`) ?? '';
    }
    try {
      await api(`/admin/users/${id}/status`, { method: 'POST', body: { status, reason: reason || undefined } });
      queryClient.invalidateQueries({ queryKey: ['admin-users', q] });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Users ({data?.total ?? 0})</h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input className="input w-64 !pl-9" placeholder="Search by name/email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="divide-y text-sm">
        {!data?.items?.length && <EmptyRows label="No users match." />}
        {data?.items?.map((u: any) => (
          <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span className="min-w-0">
              <span className="text-foreground">{u.name}</span> <span className="text-gray-400">({u.email})</span>
              <span className="badge-neutral ml-2">{u.role}</span>
              {!u.email_verified && <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">unverified</span>}
            </span>
            <span className="flex items-center gap-2">
              <StatusBadge status={u.status} />
              {u.status === 'active' ? (
                <>
                  <button className="text-xs font-medium text-amber-600 hover:underline dark:text-amber-400" onClick={() => setStatus(u.id, 'suspended')}>Suspend</button>
                  <button className="text-xs font-medium text-red-500 hover:underline" onClick={() => confirm(`Ban ${u.email}?`) && setStatus(u.id, 'banned')}>Ban</button>
                </>
              ) : (
                <button className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400" onClick={() => setStatus(u.id, 'active')}>Reactivate</button>
              )}
            </span>
          </div>
        ))}
      </div>
      <StaffForm onDone={() => queryClient.invalidateQueries({ queryKey: ['admin-users', q] })} />
    </div>
  );
}

function StaffForm({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState('');
  return (
    <form
      className="mt-5 border-t pt-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        try {
          await api('/admin/users/staff', { method: 'POST', body: { name: form.get('name'), email: form.get('email'), role: form.get('role') } });
          setMsg('Invitation sent — they’ll receive a secure link to set their own password. No password needed from you.');
          (e.target as HTMLFormElement).reset();
          onDone();
        } catch (err) {
          setMsg((err as Error).message);
        }
      }}
    >
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
        <UserPlus className="h-3.5 w-3.5 text-brand-500" /> Invite staff
      </p>
      <div className="grid gap-2 sm:grid-cols-4">
        <input name="name" placeholder="Name" required className="input" />
        <input name="email" type="email" placeholder="Email" required className="input" />
        <select name="role" className="input">
          <option value="quality_officer">Quality officer</option>
          <option value="platform_admin">Platform admin</option>
        </select>
        <button className="btn-secondary">Invite staff</button>
        {msg && <p className="text-xs font-medium text-brand-600 sm:col-span-4">{msg}</p>}
      </div>
    </form>
  );
}

function CoursesTab() {
  const [q, setQ] = useState('');
  const { data, refetch } = useQuery({ queryKey: ['admin-course-search', q], queryFn: () => api<any[]>(`/admin/courses?q=${encodeURIComponent(q)}`) });
  const act = async (id: string, action: 'unlist' | 'restore' | 'archive') => {
    try {
      await api(`/admin/courses/${id}/${action}`, { method: 'POST' });
      refetch();
    } catch (err) {
      alert((err as Error).message);
    }
  };
  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">Course lifecycle overrides</h2>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input className="input !pl-9" placeholder="Search courses by title…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="divide-y text-sm">
        {!data?.length && <EmptyRows label="No courses match." />}
        {data?.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span className="flex min-w-0 items-center gap-2 text-foreground"><span className="truncate">{c.title}</span> <StatusBadge status={c.status} /></span>
            <span className="flex shrink-0 gap-3 text-xs">
              {(c.status === 'published' || c.status === 'flagged') && <button className="font-medium text-brand-600 hover:underline" onClick={() => act(c.id, 'unlist')}>Unlist</button>}
              {(c.status === 'unlisted' || c.status === 'flagged') && <button className="font-medium text-brand-600 hover:underline" onClick={() => act(c.id, 'restore')}>Restore</button>}
              {c.status !== 'archived' && <button className="font-medium text-red-500 hover:underline" onClick={() => confirm(`Archive "${c.title}"? This is terminal.`) && act(c.id, 'archive')}>Archive</button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <RequireRole roles={['platform_admin']}>
      <AdminConsole />
    </RequireRole>
  );
}
