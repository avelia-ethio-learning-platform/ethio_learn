'use client';

import { Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { RequireRole } from '@/components/RequireRole';
import { EmptyRows } from '@/components/EmptyRows';
import { Pager } from '@/components/Pager';
import { SearchPicker, type PickerOption } from '@/components/SearchPicker';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { PageHeader, PageShell, StatusBadge } from '@/components/PageChrome';
import { AnalyticsTab, BroadcastTab, CouponsTab, WalletTab } from './growth-tabs';
import { formatDate, formatETB } from '@/lib/format';
import { fraudSignalLabel, fraudSubjectLabel, holdReasonLabel, payeeLabel, paymentMethodLabel, roleLabel, statusLabel } from '@/lib/labels';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useT } from '@/lib/i18n';

const PAGE_SIZE = 20;

const TABS = [
  { id: 'analytics', label: 'Analytics' },
  { id: 'payments', label: 'Payments' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'fraud', label: 'Fraud flags' },
  { id: 'users', label: 'Users' },
  { id: 'courses', label: 'Course overrides' },
  { id: 'coupons', label: 'Coupons' },
  { id: 'wallet', label: 'Wallets' },
  { id: 'broadcast', label: 'Announce' },
] as const;

type Tab = (typeof TABS)[number]['id'];

/** "Educator · c536c035": who a payout or payment goes to, without the raw type or the full id. */
const payeeName = (type: string, id: string) => `${payeeLabel(type)} · ${id.slice(0, 8)}`;

function AdminConsole() {
  const search = useSearchParams();
  const router = useRouter();
  // The URL holds the tab, so a reload or a shared link opens it; an unknown value opens Analytics.
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => t.id === search.get('tab'))?.id ?? 'analytics');
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const select = (id: Tab, focus = false) => {
    setTab(id);
    router.replace(`?tab=${id}`, { scroll: false });
    if (focus) tabRefs.current[id]?.focus();
  };

  // On a narrow screen the tabs are one scrolling row: keep the selected one in view.
  useEffect(() => {
    tabRefs.current[tab]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  // Left, Right, Home and End move between tabs and open the one they land on.
  const onKeyDown = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(TABS[(next + TABS.length) % TABS.length].id, true);
  };

  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-brand-500" /> Platform admin
          </span>
        }
        title="Platform admin console"
        subtitle="Analytics, payments, payouts, refunds, fraud, users, courses, coupons, wallets and announcements."
      />
      <div className="space-y-6">
        <div role="tablist" aria-label="Admin sections" onKeyDown={onKeyDown} className="flex snap-x flex-nowrap gap-2 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`admin-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`admin-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)}
              className={`shrink-0 snap-start whitespace-nowrap ${tab === t.id ? 'pill-active' : 'pill'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div key={tab} role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`} tabIndex={0} className="animate-fade-in-up">
          {tab === 'analytics' && <AnalyticsTab />}
          {tab === 'payments' && <PaymentsTab />}
          {tab === 'payouts' && <PayoutsTab />}
          {tab === 'refunds' && <RefundsTab />}
          {tab === 'fraud' && <FraudTab />}
          {tab === 'users' && <UsersTab />}
          {tab === 'courses' && <CoursesTab />}
          {tab === 'coupons' && <CouponsTab />}
          {tab === 'wallet' && <WalletTab />}
          {tab === 'broadcast' && <BroadcastTab />}
        </div>
      </div>
    </PageShell>
  );
}

function PaymentsTab() {
  const { locale } = useT();
  const [page, setPage] = useState(1);
  const { data } = useQuery({
    queryKey: ['admin-payments', page],
    queryFn: () => api<any>(`/admin/payments?page=${page}&limit=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="card">
      <h2 className="mb-3 font-semibold">Payment ledger ({data?.total ?? 0})</h2>
      <BankTransferForm />
      <div className="divide-y text-sm">
        {!data?.items?.length && <EmptyRows label="No payments yet." />}
        {data?.items?.map((p: any) => (
          <div key={p.id}>
            <button
              type="button"
              aria-expanded={openId === p.id}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-brand-500/5"
              onClick={() => setOpenId(openId === p.id ? null : p.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{p.course_title}</span>
                <span className="block truncate text-xs text-gray-500">{p.learner_name} · {p.learner_email}</span>
              </span>
              <span className="hidden whitespace-nowrap text-xs text-gray-500 sm:inline">{formatDate(p.created_at, locale, 'datetime')}</span>
              <span className="whitespace-nowrap font-medium text-foreground">{formatETB(p.amount_etb, locale)}</span>
              <StatusBadge status={p.status} />
              <ChevronDown
                aria-hidden="true"
                className={`h-4 w-4 shrink-0 text-gray-500 transition-transform duration-200 ${openId === p.id ? 'rotate-180' : ''}`}
              />
            </button>
            {openId === p.id && (
              <dl className="glass-secondary mb-2 grid animate-fade-in gap-x-6 gap-y-1 rounded-xl p-3 text-xs sm:grid-cols-2">
                <div><dt className="inline font-medium text-gray-500">Paid by: </dt><dd className="inline">{p.learner_name} ({p.learner_email})</dd></div>
                <div><dt className="inline font-medium text-gray-500">Method: </dt><dd className="inline">{paymentMethodLabel(p.method)}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Initiated: </dt><dd className="inline">{formatDate(p.created_at, locale, 'datetime')}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Confirmed: </dt><dd className="inline">{p.webhook_received_at ? formatDate(p.webhook_received_at, locale, 'datetime') : 'not yet'}</dd></div>
                <div className="sm:col-span-2"><dt className="inline font-medium text-gray-500">Transaction ref: </dt><dd className="inline font-mono">{p.tx_ref}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Payee: </dt><dd className="inline">{payeeName(p.payee_type, p.payee_id)}</dd></div>
                <div><dt className="inline font-medium text-gray-500">Payout: </dt><dd className="inline">{p.payout_id ? 'included in payout' : 'not yet paid out'}</dd></div>
              </dl>
            )}
          </div>
        ))}
      </div>
      <Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />
    </div>
  );
}

function BankTransferForm() {
  const ask = useConfirm();
  const queryClient = useQueryClient();
  const [learner, setLearner] = useState<PickerOption | null>(null);
  const [course, setCourse] = useState<PickerOption | null>(null);
  // The bank's own reference for the transfer: recording it twice records one payment.
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();

  const mark = async () => {
    if (!learner || !course) return;
    const bankReference = reference.trim();
    const answer = await ask({
      title: 'Mark this bank transfer as paid?',
      body: `${learner.label} gets ${course.label}, bank reference ${bankReference}. This grants access now.`,
      confirmLabel: 'Mark as paid',
    });
    if (!answer) return;
    clear();
    setBusy(true);
    try {
      await api('/admin/payments/bank-transfer', {
        method: 'POST',
        body: { learner_id: learner.id, course_id: course.id, bank_reference: bankReference },
      });
      setOk(`Bank transfer recorded. ${learner.label} has access to ${course.label} now.`);
      setLearner(null);
      setCourse(null);
      setReference('');
      queryClient.invalidateQueries({ queryKey: ['admin-payments'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Record a bank transfer" className="glass-secondary mb-4 space-y-3 rounded-xl p-3">
      <p className="text-sm font-semibold">Record a bank transfer</p>
      <div className="flex flex-wrap items-end gap-3">
        <SearchPicker
          label="Learner"
          placeholder="Search name or email…"
          selected={learner}
          onSelect={setLearner}
          fetcher={async (q) => {
            const res = await api<{ items: any[] }>(`/admin/users?q=${encodeURIComponent(q)}&role=learner`);
            return res.items.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` }));
          }}
        />
        <SearchPicker
          label="Course"
          placeholder="Search title…"
          selected={course}
          onSelect={setCourse}
          fetcher={async (q) =>
            (await api<any[]>(`/admin/courses?q=${encodeURIComponent(q)}`)).map((c) => ({ id: c.id, label: `${c.title} (${statusLabel(c.status).label})` }))
          }
        />
        <Field label="Bank reference">
          {(ids) => (
            <input
              {...ids}
              className="input w-44 text-sm"
              placeholder="From the bank slip"
              required
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          )}
        </Field>
        <button type="button" className="btn-secondary" disabled={busy || !learner || !course || !reference.trim()} onClick={mark}>
          Mark bank transfer
        </button>
      </div>
      <FormStatus status={status} />
    </section>
  );
}

function PayoutsTab() {
  const { locale } = useT();
  const ask = useConfirm();
  const queryClient = useQueryClient();
  const { data: payouts } = useQuery({ queryKey: ['admin-payouts'], queryFn: () => api<any[]>('/payouts') });
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();

  const run = async (action: () => Promise<string>) => {
    clear();
    setBusy(true);
    try {
      setOk(await action());
      queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runPayouts = async () => {
    if (!(await ask({ title: 'Pay every eligible educator and institution now?', confirmLabel: 'Run payouts' }))) return;
    await run(async () => {
      const res = await api<{ created: number; held: number }>('/payouts/run', { method: 'POST' });
      return `Payout run finished: ${res.created} paid out, ${res.held} held.`;
    });
  };

  const release = async (p: any) => {
    const payee = payeeName(p.payee_type, p.payee_id);
    const held = p.hold_reason ? ` Held: ${holdReasonLabel(p.hold_reason)}.` : '';
    const answer = await ask({
      title: `Release the payout to ${payee}?`,
      body: `Net ${formatETB(p.net_amount_etb, locale)}.${held} Releasing clears any hold, KYC included, and pays it out now.`,
      confirmLabel: 'Release payout',
    });
    if (!answer) return;
    await run(async () => {
      await api(`/payouts/${p.id}/release`, { method: 'POST' });
      return `Payout to ${payee} released.`;
    });
  };

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Payouts</h2>
        <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={runPayouts}>
          Run payouts now
        </button>
      </div>
      <FormStatus status={status} />
      <div className="divide-y text-sm">
        {payouts?.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span className="truncate pr-2 text-xs text-gray-500">{payeeName(p.payee_type, p.payee_id)}</span>
            <span className="font-medium text-foreground">net {formatETB(p.net_amount_etb, locale)}</span>
            <span className="flex items-center gap-2">
              <StatusBadge status={p.status} suffix={p.hold_reason ? holdReasonLabel(p.hold_reason) : undefined} />
              {p.status === 'held' && (
                <button type="button" className="text-xs font-medium text-brand-600 hover:underline" disabled={busy} onClick={() => release(p)}>
                  Release
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
  const { locale } = useT();
  const ask = useConfirm();
  const queryClient = useQueryClient();
  const { data: refunds } = useQuery({ queryKey: ['admin-refunds'], queryFn: () => api<any[]>('/refunds/pending') });
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();

  const decide = async (r: any, action: 'approve' | 'deny') => {
    // Course and amount come from the payment row and may be missing: the dialog then leaves them out.
    const what = r.course_title ? `the refund for ${r.course_title}` : 'this refund';
    const amount = r.amount_etb != null ? `${formatETB(Number(r.amount_etb), locale)} goes back to the learner. ` : '';
    const answer = await ask(
      action === 'approve'
        ? { title: `Approve ${what}?`, body: `${amount}Learner's reason: “${r.reason}”`, confirmLabel: 'Approve refund', tone: 'danger' }
        : { title: `Deny ${what}?`, body: `Learner's reason: “${r.reason}”`, confirmLabel: 'Deny refund' },
    );
    if (!answer) return;
    clear();
    setBusy(true);
    try {
      await api(`/refunds/${r.id}/decide`, { method: 'POST', body: { action } });
      setOk(action === 'approve' ? 'Refund approved.' : 'Refund denied.');
      queryClient.invalidateQueries({ queryKey: ['admin-refunds'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="mb-3 font-semibold">Refunds awaiting manual review (20–50% watched)</h2>
      <FormStatus status={status} />
      <div className="divide-y text-sm">
        {refunds?.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span className="min-w-0 pr-2">
              {(r.course_title || r.amount_etb != null) && (
                <span className="block truncate font-medium text-foreground">
                  {[r.course_title, r.amount_etb != null ? formatETB(Number(r.amount_etb), locale) : null].filter(Boolean).join(' · ')}
                </span>
              )}
              <span className="block truncate text-gray-500">{r.reason}</span>
            </span>
            <span className="flex shrink-0 gap-3">
              <button type="button" className="font-medium text-emerald-700 hover:underline dark:text-emerald-400" disabled={busy} onClick={() => decide(r, 'approve')}>
                Approve
              </button>
              <button type="button" className="font-medium text-red-600 hover:underline dark:text-red-400" disabled={busy} onClick={() => decide(r, 'deny')}>
                Deny
              </button>
            </span>
          </div>
        ))}
        {!refunds?.length && <EmptyRows happy label="Nothing pending — all caught up." />}
      </div>
    </div>
  );
}

function FraudTab() {
  const ask = useConfirm();
  const queryClient = useQueryClient();
  const { data: flags } = useQuery({ queryKey: ['fraud-flags'], queryFn: () => api<any[]>('/fraud/flags') });
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();

  const flagName = (f: any) => `${fraudSignalLabel(f.signal_type)} on ${fraudSubjectLabel(f.subject_type).toLowerCase()} ${f.subject_id.slice(0, 8)}`;

  const resolve = async (f: any) => {
    const name = flagName(f);
    const answer = await ask({
      title: `Resolve “${name}”?`,
      body: 'Clears this flag. Payouts held for fraud go out once this payee has no open flags. Payouts over the KYC limit still wait for KYC.',
      confirmLabel: 'Resolve flag',
    });
    if (!answer) return;
    clear();
    setBusy(true);
    try {
      await api(`/fraud/flags/${f.id}/resolve`, { method: 'POST' });
      setOk(`Flag resolved: ${name}.`);
      queryClient.invalidateQueries({ queryKey: ['fraud-flags'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="mb-3 font-semibold">Open fraud flags (payouts auto-held)</h2>
      <FormStatus status={status} />
      <div className="divide-y text-sm">
        {flags?.map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span>
              <strong>{fraudSignalLabel(f.signal_type)}</strong> on {fraudSubjectLabel(f.subject_type).toLowerCase()}{' '}
              <code className="text-xs">{f.subject_id.slice(0, 8)}</code>
              <span className="ml-2 text-xs text-gray-500">{f.detail}</span>
            </span>
            <button type="button" className="font-medium text-brand-600 hover:underline" disabled={busy} onClick={() => resolve(f)}>
              Resolve
            </button>
          </div>
        ))}
        {!flags?.length && <EmptyRows happy label="No open flags — all clear." />}
      </div>
    </div>
  );
}

function UsersTab() {
  const ask = useConfirm();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const term = useDebouncedValue(q.trim());
  const [page, setPage] = useState(1);
  const { data } = useQuery({
    queryKey: ['admin-users', term, page],
    queryFn: () => api<any>(`/admin/users?q=${encodeURIComponent(term)}&page=${page}&limit=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const setUserStatus = async (u: any, next: 'active' | 'suspended' | 'banned') => {
    let reason: string | undefined;
    if (next !== 'active') {
      const ban = next === 'banned';
      const answer = await ask({
        title: `${ban ? 'Ban' : 'Suspend'} ${u.name}?`,
        body: `${u.email} is signed out and can't sign in until you reactivate the account.`,
        confirmLabel: ban ? 'Ban user' : 'Suspend user',
        tone: 'danger',
        reason: { label: 'Reason (optional)', maxLength: 500 },
      });
      if (!answer) return; // Cancel means cancel: nothing is sent
      reason = answer.reason || undefined;
    }
    clear();
    setBusy(true);
    try {
      await api(`/admin/users/${u.id}/status`, { method: 'POST', body: { status: next, reason } });
      setOk(`${u.name}: ${statusLabel(next).label}.`);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Users ({data?.total ?? 0})</h2>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="search"
            aria-label="Search users"
            className="input w-64 max-w-full !pl-9"
            placeholder="Search by name or email…"
            maxLength={100}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              // A new search starts on its first page.
              setPage(1);
            }}
          />
        </div>
      </div>
      <FormStatus status={status} />
      <div className="divide-y text-sm">
        {!data?.items?.length && <EmptyRows label="No users match." />}
        {data?.items?.map((u: any) => {
          // The API refuses a status change on your own account, so its buttons don't show.
          const isMe = u.id === me?.id;
          return (
            <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
              <span className="min-w-0">
                <span className="text-foreground">{u.name}</span> <span className="text-gray-500">({u.email})</span>
                <span className="badge-neutral ml-2">{roleLabel(u.role)}</span>
                {isMe && <span className="badge-info ml-1">You</span>}
                {!u.email_verified && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">unverified</span>}
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge status={u.status} />
                {!isMe &&
                  (u.status === 'active' ? (
                    <>
                      <button type="button" className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400" disabled={busy} onClick={() => setUserStatus(u, 'suspended')}>
                        Suspend
                      </button>
                      <button type="button" className="text-xs font-medium text-red-600 hover:underline dark:text-red-400" disabled={busy} onClick={() => setUserStatus(u, 'banned')}>
                        Ban
                      </button>
                    </>
                  ) : (
                    <button type="button" className="text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400" disabled={busy} onClick={() => setUserStatus(u, 'active')}>
                      Reactivate
                    </button>
                  ))}
              </span>
            </div>
          );
        })}
      </div>
      <Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />
      <StaffForm onDone={refresh} />
    </div>
  );
}

function StaffForm({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();
  return (
    <form
      className="mt-5 space-y-3 border-t pt-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const form = new FormData(formEl);
        clear();
        setBusy(true);
        try {
          await api('/admin/users/staff', { method: 'POST', body: { name: form.get('name'), email: form.get('email'), role: form.get('role') } });
          setOk('Invitation sent — they’ll receive a secure link to set their own password. No password needed from you.');
          formEl.reset();
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
        <UserPlus aria-hidden="true" className="h-3.5 w-3.5 text-brand-500" /> Invite staff
      </p>
      <div className="grid items-end gap-2 sm:grid-cols-4">
        <Field label="Name">{(ids) => <input {...ids} name="name" required className="input" />}</Field>
        <Field label="Email">{(ids) => <input {...ids} name="email" type="email" required className="input" />}</Field>
        <Field label="Role">
          {(ids) => (
            <select {...ids} name="role" className="input">
              <option value="quality_officer">Quality officer</option>
              <option value="platform_admin">Platform admin</option>
            </select>
          )}
        </Field>
        <button className="btn-secondary" disabled={busy}>
          Invite staff
        </button>
      </div>
      <FormStatus status={status} />
    </form>
  );
}

const COURSE_DONE = { unlist: 'unlisted', restore: 'restored', archive: 'archived' } as const;

function CoursesTab() {
  const ask = useConfirm();
  const [q, setQ] = useState('');
  const term = useDebouncedValue(q.trim());
  const { data, refetch } = useQuery({ queryKey: ['admin-course-search', term], queryFn: () => api<any[]>(`/admin/courses?q=${encodeURIComponent(term)}`) });
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();

  const act = async (c: any, action: 'unlist' | 'restore' | 'archive') => {
    // Restore is reversible, so it doesn't ask.
    if (action === 'unlist' && !(await ask({ title: `Unlist “${c.title}”?`, body: 'It leaves the catalog until you restore it.', confirmLabel: 'Unlist course' }))) return;
    if (
      action === 'archive' &&
      !(await ask({ title: `Archive “${c.title}”?`, body: 'Archiving is permanent and can’t be undone.', confirmLabel: 'Archive course', tone: 'danger' }))
    )
      return;
    clear();
    setBusy(true);
    try {
      await api(`/admin/courses/${c.id}/${action}`, { method: 'POST' });
      setOk(`“${c.title}” ${COURSE_DONE[action]}.`);
      refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">Course lifecycle overrides</h2>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <input type="search" aria-label="Search courses" className="input !pl-9" placeholder="Search courses by title…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <FormStatus status={status} />
      <div className="divide-y text-sm">
        {!data?.length && <EmptyRows label="No courses match." />}
        {data?.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-brand-500/5">
            <span className="flex min-w-0 items-center gap-2 text-foreground"><span className="truncate">{c.title}</span> <StatusBadge status={c.status} /></span>
            <span className="flex shrink-0 gap-3 text-xs">
              {(c.status === 'published' || c.status === 'flagged') && (
                <button type="button" className="font-medium text-brand-600 hover:underline" disabled={busy} onClick={() => act(c, 'unlist')}>
                  Unlist
                </button>
              )}
              {(c.status === 'unlisted' || c.status === 'flagged') && (
                <button type="button" className="font-medium text-brand-600 hover:underline" disabled={busy} onClick={() => act(c, 'restore')}>
                  Restore
                </button>
              )}
              {c.status !== 'archived' && (
                <button type="button" className="font-medium text-red-600 hover:underline dark:text-red-400" disabled={busy} onClick={() => act(c, 'archive')}>
                  Archive
                </button>
              )}
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
      {/* A bare useSearchParams fails `next build` on this static page: it needs a Suspense boundary. */}
      <Suspense>
        <AdminConsole />
      </Suspense>
    </RequireRole>
  );
}
