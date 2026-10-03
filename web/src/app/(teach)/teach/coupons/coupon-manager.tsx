'use client';

import { FormEvent, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ticket } from 'lucide-react';
import { api } from '@/lib/api';
import { SearchPicker, type PickerOption } from '@/components/SearchPicker';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { useAuth } from '@/lib/hooks';
import { formatDate, formatETB } from '@/lib/format';
import { useT } from '@/lib/i18n';

/** Coupon manager shared by educators (own courses) and admins (platform-wide). */
export function CouponManager() {
  const { locale } = useT();
  const ask = useConfirm();
  const { user, ready } = useAuth();
  const isAdmin = user?.role === 'platform_admin';
  const queryClient = useQueryClient();
  const { data: coupons } = useQuery({ queryKey: ['coupons'], queryFn: () => api<any[]>('/coupons') });
  // Admins pick from every course instead: `GET /courses` is the educator's own list, and an admin gets a 403.
  const { data: courses } = useQuery({ queryKey: ['own-courses'], queryFn: () => api<any[]>('/courses'), enabled: ready && !isAdmin });
  const [form, setForm] = useState({ code: '', kind: 'percent', value: 20, course_id: '', max_uses: '', max_uses_per_user: '', expires_at: '', note: '' });
  // The admin's course; empty means every paid course.
  const [adminCourse, setAdminCourse] = useState<PickerOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setOk, setError, clear] = useFormStatus();
  const [listStatus, setListOk, setListError, clearList] = useFormStatus();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    clear();
    // Blank means a learner may use the code any number of times.
    const perLearner = form.max_uses_per_user.trim() ? Number(form.max_uses_per_user) : undefined;
    if (perLearner !== undefined && (!Number.isInteger(perLearner) || perLearner < 1)) {
      setError('Uses per learner must be a whole number of at least 1.');
      return;
    }
    setBusy(true);
    try {
      await api('/coupons', {
        method: 'POST',
        body: {
          code: form.code || undefined,
          kind: form.kind,
          value: Number(form.value),
          course_id: (isAdmin ? adminCourse?.id : form.course_id) || undefined,
          max_uses: form.max_uses ? Number(form.max_uses) : undefined,
          max_uses_per_user: perLearner,
          expires_at: form.expires_at || undefined,
          note: form.note || undefined,
        },
      });
      setOk('Coupon created.');
      setForm({ ...form, code: '', note: '' });
      queryClient.invalidateQueries({ queryKey: ['coupons'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (c: any) => {
    const answer = await ask({
      title: `Deactivate ${c.code}?`,
      body: 'Learners can no longer use this code. This can’t be undone.',
      confirmLabel: 'Deactivate code',
      tone: 'danger',
    });
    if (!answer) return;
    clearList();
    setBusy(true);
    try {
      await api(`/coupons/${c.id}/deactivate`, { method: 'POST' });
      setListOk(`${c.code} deactivated.`);
      queryClient.invalidateQueries({ queryKey: ['coupons'] });
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="card grid gap-3 sm:grid-cols-2">
        <p className="text-sm font-bold text-foreground sm:col-span-2">New coupon / scholarship code</p>
        <Field label="Code" hint="Leave blank to generate one.">
          {(ids) => <input {...ids} className="input uppercase" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} maxLength={32} />}
        </Field>
        {isAdmin ? (
          <div>
            <SearchPicker
              label="Course"
              placeholder="Search title…"
              selected={adminCourse}
              onSelect={setAdminCourse}
              fetcher={async (q) => (await api<any[]>(`/admin/courses?q=${encodeURIComponent(q)}`)).filter((c) => c.pricing_type !== 'free').map((c) => ({ id: c.id, label: c.title }))}
            />
            <p className="mt-1 text-xs text-gray-500">Leave empty for every paid course.</p>
          </div>
        ) : (
          <Field label="Course">
            {(ids) => (
              <select {...ids} className="input" required value={form.course_id} onChange={(e) => setForm({ ...form, course_id: e.target.value })}>
                <option value="">Choose a course…</option>
                {courses?.filter((c) => c.pricing_type !== 'free').map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div className="flex items-end gap-2">
          <Field label="Discount type">
            {(ids) => (
              <select {...ids} className="input w-32" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="percent">% off</option>
                <option value="amount">ETB off</option>
              </select>
            )}
          </Field>
          <div className="flex-1">
            <Field label="Discount">
              {(ids) => <input {...ids} type="number" min={1} className="input" value={form.value} onChange={(e) => setForm({ ...form, value: +e.target.value })} />}
            </Field>
          </div>
        </div>
        <Field label="Max uses" hint="Leave blank for unlimited.">
          {(ids) => <input {...ids} type="number" min={1} className="input" value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} />}
        </Field>
        <Field label="Uses per learner" hint="Leave blank for unlimited.">
          {(ids) => (
            <input
              {...ids}
              type="number"
              min={1}
              step={1}
              className="input"
              value={form.max_uses_per_user}
              onChange={(e) => setForm({ ...form, max_uses_per_user: e.target.value })}
            />
          )}
        </Field>
        <Field label="Expires on" hint="Leave blank for no expiry.">
          {(ids) => <input {...ids} type="date" className="input" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />}
        </Field>
        <Field label="Note" hint="E.g. “Scholarship — Addis Coding Academy”">
          {(ids) => <input {...ids} className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={200} />}
        </Field>
        <div className="sm:col-span-2">
          <button className="btn" disabled={busy}>
            <Ticket aria-hidden="true" className="h-4 w-4" /> Create coupon
          </button>
        </div>
        <div className="sm:col-span-2">
          <FormStatus status={status} />
        </div>
        <p className="text-xs text-gray-500 sm:col-span-2">
          A 100%-off code enrolls the learner without a payment — use it for scholarships. Discounted revenue is what reaches payouts.
        </p>
      </form>

      <FormStatus status={listStatus} />
      <div className="card !p-0 overflow-hidden text-sm">
        {!coupons?.length && <p className="px-5 py-6 text-gray-500">No coupons yet.</p>}
        {coupons?.map((c, i) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3" style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}>
            <div className="min-w-0">
              <p className="font-mono font-bold text-foreground">{c.code}</p>
              <p className="text-xs text-gray-500">
                {c.kind === 'percent' ? `${c.value}% off` : `${formatETB(c.value, locale)} off`} · {c.course_id ? 'one course' : 'all courses'} · used {c.uses}
                {c.max_uses ? `/${c.max_uses}` : ''}
                {c.max_uses_per_user ? ` · ${c.max_uses_per_user} per learner` : ''}
                {c.expires_at ? ` · expires ${formatDate(c.expires_at, locale)}` : ''}
                {c.note ? ` · ${c.note}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className={c.active ? 'badge-success' : 'badge-neutral'}>{c.active ? 'Active' : 'Inactive'}</span>
              {c.active && (
                <button type="button" className="text-xs font-medium text-red-600 hover:underline dark:text-red-400" disabled={busy} onClick={() => deactivate(c)}>
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
