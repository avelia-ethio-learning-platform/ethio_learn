'use client';

import { FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Megaphone, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { Bars } from '@/components/Bars';
import { CouponManager } from '@/app/(teach)/teach/coupons/coupon-manager';

/** Platform-wide money + learner funnel. */
export function AnalyticsTab() {
  const { data: fin } = useQuery({ queryKey: ['admin-fin'], queryFn: () => api<any>('/admin/analytics/financial') });
  const { data: enr } = useQuery({ queryKey: ['admin-enr'], queryFn: () => api<any>('/admin/enrollments/analytics') });
  const tiles = [
    { label: 'Gross revenue', value: `${fin?.total_gross_etb ?? 0} ETB`, hint: `${fin?.payment_count ?? 0} confirmed payments · platform share ${fin ? (fin.total_gross_etb - fin.total_net_etb).toFixed(2) : 0} ETB` },
    { label: 'Active enrollments', value: enr?.active ?? 0, hint: `${enr?.distinct_learners ?? 0} learners · ${enr?.active_last_7d ?? 0} active this week` },
    { label: 'Completions', value: enr?.completed ?? 0, hint: enr?.active ? `${Math.round((enr.completed / enr.active) * 100)}% completion rate` : '' },
    { label: 'Wallet liability', value: `${fin?.wallet?.outstanding_balance_etb ?? 0} ETB`, hint: `coupon discounts given: ${fin?.coupon_discount_total_etb ?? 0} ETB` },
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
            <p className="mt-1 text-xs text-gray-400">{t.hint}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <p className="text-sm font-bold text-foreground">Revenue by month (ETB)</p>
          {fin ? <Bars data={fin.by_month.map((m: any) => ({ label: m.month, value: m.gross_etb }))} /> : <div className="skeleton mt-3 h-36" />}
        </div>
        <div className="card">
          <p className="text-sm font-bold text-foreground">Enrollments by month</p>
          {enr ? <Bars data={enr.enrollments_by_month.map((m: any) => ({ label: m.month, value: m.count }))} /> : <div className="skeleton mt-3 h-36" />}
        </div>
      </div>
      {fin && (
        <div className="grid gap-4 md:grid-cols-2 text-sm">
          <div className="card">
            <p className="font-bold text-foreground">By purpose</p>
            <ul className="mt-2 space-y-1 text-gray-600">
              {Object.entries(fin.by_purpose ?? {}).map(([k, v]: any) => (
                <li key={k} className="flex justify-between">
                  <span className="capitalize">{k.replace('_', ' ')}</span>
                  <span>
                    {v.count} · {v.gross_etb} ETB
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <p className="font-bold text-foreground">Top courses by revenue</p>
            <ul className="mt-2 space-y-1 text-gray-600">
              {(fin.by_course ?? []).slice(0, 8).map((c: any) => (
                <li key={c.course_id} className="flex justify-between gap-2">
                  <span className="truncate">{c.course_title}</span>
                  <span className="shrink-0">{c.gross_etb} ETB</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/** Announcement to a role or everyone (in-app inbox). */
export function BroadcastTab() {
  const [form, setForm] = useState({ title: '', body: '', link: '', role: '' });
  const [status, setStatus] = useState('');
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setStatus('');
    try {
      const res = await api<{ sent_to_roles: string[] }>('/admin/notifications/broadcast', {
        method: 'POST',
        body: { title: form.title, body: form.body, link: form.link || undefined, role: form.role || undefined },
      });
      setStatus(`Sent to: ${res.sent_to_roles.join(', ')}`);
      setForm({ title: '', body: '', link: '', role: '' });
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <form onSubmit={send} className="card max-w-2xl space-y-3">
      <p className="flex items-center gap-2 font-bold text-foreground">
        <Megaphone className="h-4 w-4 text-brand-500" /> Announce a feature, campaign or maintenance
      </p>
      <input className="input" required maxLength={120} placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <textarea className="input" required rows={3} maxLength={1000} placeholder="Message" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" placeholder="Link (optional, e.g. /courses)" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} />
        <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="">Everyone</option>
          <option value="learner">Learners</option>
          <option value="educator">Educators</option>
          <option value="institution_admin">Institutions</option>
          <option value="quality_officer">Quality officers</option>
        </select>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn">Send announcement</button>
        {status && <span className="text-sm font-medium text-brand-600">{status}</span>}
      </div>
      <p className="text-xs text-gray-400">Delivered to the in-app notification bell. Marketing email blasts are deliberately not automated (see FEATURES_ADDED.md).</p>
    </form>
  );
}

export function CouponsTab() {
  return <CouponManager />;
}

/** Manual wallet credit / debit for support cases. */
export function WalletTab() {
  const [form, setForm] = useState({ user_id: '', amount_etb: 100, note: '' });
  const [status, setStatus] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setStatus('');
    try {
      const res = await api<{ balance_etb: number }>('/admin/wallet/adjust', { method: 'POST', body: form });
      setStatus(`Done — new balance ${res.balance_etb} ETB.`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <form onSubmit={submit} className="card max-w-xl space-y-3">
      <p className="flex items-center gap-2 font-bold text-foreground">
        <Wallet className="h-4 w-4 text-brand-500" /> Adjust a learner&apos;s wallet
      </p>
      <input className="input" required placeholder="User id (from the Users tab)" value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <input type="number" className="input" required value={form.amount_etb} onChange={(e) => setForm({ ...form, amount_etb: +e.target.value })} />
        <input className="input" placeholder="Reason (shown to the learner)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={200} />
      </div>
      <div className="flex items-center gap-3">
        <button className="btn">Apply</button>
        {status && <span className="text-sm font-medium text-brand-600">{status}</span>}
      </div>
      <p className="text-xs text-gray-400">Positive credits, negative debits (fails if the balance can&apos;t cover it). Every movement is logged in the learner&apos;s wallet history.</p>
    </form>
  );
}
