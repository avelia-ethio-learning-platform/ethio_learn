'use client';

import { FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Megaphone, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { Bars } from '@/components/Bars';
import { EmptyRows } from '@/components/EmptyRows';
import { SearchPicker, type PickerOption } from '@/components/SearchPicker';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { CouponManager } from '@/app/(teach)/teach/coupons/coupon-manager';
import { formatETB } from '@/lib/format';
import { purposeLabel } from '@/lib/labels';
import { useT } from '@/lib/i18n';

/** Platform-wide money + learner funnel. */
export function AnalyticsTab() {
  const { locale } = useT();
  const { data: fin } = useQuery({ queryKey: ['admin-fin'], queryFn: () => api<any>('/admin/analytics/financial') });
  const { data: enr } = useQuery({ queryKey: ['admin-enr'], queryFn: () => api<any>('/admin/enrollments/analytics') });
  const tiles = [
    { label: 'Gross revenue', value: `${formatETB(fin?.total_gross_etb ?? 0, locale)}`, hint: `${fin?.payment_count ?? 0} confirmed payments · platform share ${formatETB(fin ? fin.total_gross_etb - fin.total_net_etb : 0, locale)}` },
    { label: 'Active enrollments', value: enr?.active ?? 0, hint: `${enr?.distinct_learners ?? 0} learners · ${enr?.active_last_7d ?? 0} active this week` },
    { label: 'Completions', value: enr?.completed ?? 0, hint: enr?.active ? `${Math.round((enr.completed / enr.active) * 100)}% completion rate` : '' },
    { label: 'Wallet liability', value: `${formatETB(fin?.wallet?.outstanding_balance_etb ?? 0, locale)}`, hint: `coupon discounts given: ${formatETB(fin?.coupon_discount_total_etb ?? 0, locale)}` },
    { label: 'Pending rewards', value: `${formatETB(fin?.wallet?.pending_rewards_etb ?? 0, locale)}`, hint: 'cashback and referral rewards not yet spendable' },
    { label: 'Sponsored seats', value: enr?.sponsored ?? 0, hint: 'gifts, pay requests and bulk seats' },
    { label: 'Pending / failed', value: `${fin?.pending_count ?? 0} / ${fin?.failed_count ?? 0}`, hint: 'checkouts opened but not confirmed' },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="card">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{t.label}</p>
            <p className="gradient-text-blue mt-2 text-2xl font-extrabold">{t.value}</p>
            <p className="mt-1 text-xs text-gray-500">{t.hint}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <p className="text-sm font-bold text-foreground">Revenue by month (ETB)</p>
          {fin ? (
            <Bars
              title="Revenue by month"
              empty="No revenue yet."
              format={(v) => formatETB(v, locale)}
              data={fin.by_month.map((m: any) => ({ label: m.month, value: m.gross_etb }))}
            />
          ) : (
            <div className="skeleton mt-3 h-36" />
          )}
        </div>
        <div className="card">
          <p className="text-sm font-bold text-foreground">Enrollments by month</p>
          {enr ? (
            <Bars title="Enrollments by month" empty="No enrollments yet." data={enr.enrollments_by_month.map((m: any) => ({ label: m.month, value: m.count }))} />
          ) : (
            <div className="skeleton mt-3 h-36" />
          )}
        </div>
      </div>
      {fin && (
        <div className="grid gap-4 md:grid-cols-2 text-sm">
          <div className="card">
            <p className="font-bold text-foreground">By purpose</p>
            {Object.keys(fin.by_purpose ?? {}).length ? (
              <ul className="mt-2 space-y-1 text-gray-600">
                {Object.entries(fin.by_purpose).map(([k, v]: any) => (
                  <li key={k} className="flex justify-between">
                    <span>{purposeLabel(k)}</span>
                    <span>
                      {v.count} · {formatETB(v.gross_etb, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyRows label="No confirmed payments yet." />
            )}
          </div>
          <div className="card">
            <p className="font-bold text-foreground">Top courses by revenue</p>
            {fin.by_course?.length ? (
              <ul className="mt-2 space-y-1 text-gray-600">
                {fin.by_course.slice(0, 8).map((c: any) => (
                  <li key={c.course_id} className="flex justify-between gap-2">
                    <span className="truncate">{c.course_title}</span>
                    <span className="shrink-0">{formatETB(c.gross_etb, locale)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyRows label="No course revenue yet." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const AUDIENCES: { value: string; label: string; who: string }[] = [
  { value: '', label: 'Everyone', who: 'every user' },
  { value: 'learner', label: 'Learners', who: 'every learner' },
  { value: 'educator', label: 'Educators', who: 'every educator' },
  { value: 'institution_admin', label: 'Institutions', who: 'every institution admin' },
  { value: 'quality_officer', label: 'Quality officers', who: 'every quality officer' },
];

/** Announcement to a role or everyone (in-app inbox). */
export function BroadcastTab() {
  const ask = useConfirm();
  const [form, setForm] = useState({ title: '', body: '', link: '', role: '' });
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const who = AUDIENCES.find((a) => a.value === form.role)?.who ?? 'every user';
    if (!(await ask({ title: `Send this announcement to ${who}?`, body: `“${form.title}” goes to their notification bell now.`, confirmLabel: 'Send announcement' }))) return;
    clear();
    setBusy(true);
    try {
      await api('/admin/notifications/broadcast', {
        method: 'POST',
        body: { title: form.title, body: form.body, link: form.link || undefined, role: form.role || undefined },
      });
      setOk(`Announcement sent to ${who}.`);
      setForm({ title: '', body: '', link: '', role: '' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} className="card max-w-2xl space-y-3">
      <p className="flex items-center gap-2 font-bold text-foreground">
        <Megaphone aria-hidden="true" className="h-4 w-4 text-brand-500" /> Announce a feature, campaign or maintenance
      </p>
      <Field label="Title">
        {(ids) => <input {...ids} className="input" required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
      </Field>
      <Field label="Message">
        {(ids) => <textarea {...ids} className="input" required rows={3} maxLength={1000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Link (optional)" hint="A page on this site, e.g. /courses">
          {(ids) => <input {...ids} className="input" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} />}
        </Field>
        <Field label="Audience">
          {(ids) => (
            <select {...ids} className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {AUDIENCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <button className="btn" disabled={busy}>
        Send announcement
      </button>
      <FormStatus status={status} />
      <p className="text-xs text-gray-500">Delivered to each user&apos;s notification bell. Email announcements aren&apos;t sent from here.</p>
    </form>
  );
}

export function CouponsTab() {
  return <CouponManager />;
}

/** Manual wallet credit / debit for support cases. */
export function WalletTab() {
  const { locale } = useT();
  const ask = useConfirm();
  const [user, setUser] = useState<PickerOption | null>(null);
  const [amount, setAmount] = useState('100');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();
  const value = Number(amount);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !value) return;
    const sum = formatETB(Math.abs(value), locale);
    const answer = await ask({
      title: value > 0 ? `Credit ${sum} to ${user.label}?` : `Debit ${sum} from ${user.label}?`,
      body: note.trim() ? `Reason shown to them: “${note.trim()}”` : undefined,
      confirmLabel: value > 0 ? 'Credit wallet' : 'Debit wallet',
    });
    if (!answer) return;
    clear();
    setBusy(true);
    try {
      const res = await api<{ balance_etb: number }>('/admin/wallet/adjust', { method: 'POST', body: { user_id: user.id, amount_etb: value, note } });
      setOk(`Done — ${user.label} now has ${formatETB(res.balance_etb, locale)}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card max-w-xl space-y-3">
      <p className="flex items-center gap-2 font-bold text-foreground">
        <Wallet aria-hidden="true" className="h-4 w-4 text-brand-500" /> Adjust a user&apos;s wallet
      </p>
      <SearchPicker
        label="User"
        placeholder="Search name or email…"
        selected={user}
        onSelect={setUser}
        fetcher={async (q) => {
          const res = await api<{ items: any[] }>(`/admin/users?q=${encodeURIComponent(q)}`);
          return res.items.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` }));
        }}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Amount (ETB)" hint="Positive credits, negative debits.">
          {(ids) => <input {...ids} type="number" className="input" required value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Reason (shown to the user)">
          {(ids) => <input {...ids} className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />}
        </Field>
      </div>
      <button className="btn" disabled={busy || !user || !value}>
        Apply
      </button>
      <FormStatus status={status} />
      <p className="text-xs text-gray-500">A debit fails if the balance can&apos;t cover it. Every movement is logged in the wallet history.</p>
    </form>
  );
}
