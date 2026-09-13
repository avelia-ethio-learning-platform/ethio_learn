'use client';

import { FormEvent, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ticket } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

/** Coupon manager shared by educators (own courses) and admins (platform-wide). */
export function CouponManager() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'platform_admin';
  const queryClient = useQueryClient();
  const { data: coupons } = useQuery({ queryKey: ['coupons'], queryFn: () => api<any[]>('/coupons') });
  const { data: courses } = useQuery({ queryKey: ['own-courses'], queryFn: () => api<any[]>('/courses'), enabled: !isAdmin });
  const [form, setForm] = useState({ code: '', kind: 'percent', value: 20, course_id: '', max_uses: '', expires_at: '', note: '' });
  const [status, setStatus] = useState('');

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setStatus('');
    try {
      await api('/coupons', {
        method: 'POST',
        body: {
          code: form.code || undefined,
          kind: form.kind,
          value: Number(form.value),
          course_id: form.course_id || undefined,
          max_uses: form.max_uses ? Number(form.max_uses) : undefined,
          expires_at: form.expires_at || undefined,
          note: form.note || undefined,
        },
      });
      setStatus('Coupon created.');
      setForm({ ...form, code: '', note: '' });
      queryClient.invalidateQueries({ queryKey: ['coupons'] });
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="card grid gap-3 sm:grid-cols-2">
        <p className="text-sm font-bold text-foreground sm:col-span-2">New coupon / scholarship code</p>
        <input className="input uppercase" placeholder="Code (blank = auto-generate)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} maxLength={32} />
        {isAdmin ? (
          <input className="input" placeholder="Course id (blank = every paid course)" value={form.course_id} onChange={(e) => setForm({ ...form, course_id: e.target.value })} />
        ) : (
          <select className="input" required value={form.course_id} onChange={(e) => setForm({ ...form, course_id: e.target.value })}>
            <option value="">Choose a course…</option>
            {courses?.filter((c) => c.pricing_type !== 'free').map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-2">
          <select className="input w-32" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="percent">% off</option>
            <option value="amount">ETB off</option>
          </select>
          <input type="number" min={1} className="input flex-1" value={form.value} onChange={(e) => setForm({ ...form, value: +e.target.value })} />
        </div>
        <input type="number" min={1} className="input" placeholder="Max uses (blank = unlimited)" value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} />
        <input type="date" className="input" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
        <input className="input" placeholder="Note, e.g. 'Scholarship — Addis Coding Academy'" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={200} />
        <div className="flex items-center gap-3 sm:col-span-2">
          <button className="btn">
            <Ticket className="h-4 w-4" /> Create coupon
          </button>
          {status && <span className="text-sm font-medium text-brand-600">{status}</span>}
        </div>
        <p className="text-xs text-gray-400 sm:col-span-2">
          A 100%-off code enrolls the learner without a payment — use it for scholarships. Discounted revenue is what reaches payouts.
        </p>
      </form>

      <div className="card !p-0 overflow-hidden text-sm">
        {!coupons?.length && <p className="px-5 py-6 text-gray-400">No coupons yet.</p>}
        {coupons?.map((c, i) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3" style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}>
            <div className="min-w-0">
              <p className="font-mono font-bold text-foreground">{c.code}</p>
              <p className="text-xs text-gray-500">
                {c.kind === 'percent' ? `${c.value}% off` : `${c.value} ETB off`} · {c.course_id ? 'one course' : 'all courses'} · used {c.uses}
                {c.max_uses ? `/${c.max_uses}` : ''}
                {c.expires_at ? ` · expires ${new Date(c.expires_at).toLocaleDateString()}` : ''}
                {c.note ? ` · ${c.note}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className={c.active ? 'badge-success' : 'badge-neutral'}>{c.active ? 'active' : 'inactive'}</span>
              {c.active && (
                <button
                  className="text-xs font-medium text-red-500 hover:underline"
                  onClick={async () => {
                    await api(`/coupons/${c.id}/deactivate`, { method: 'POST' });
                    queryClient.invalidateQueries({ queryKey: ['coupons'] });
                  }}
                >
                  Deactivate
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

