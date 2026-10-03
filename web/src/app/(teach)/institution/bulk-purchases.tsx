'use client';

import { FormEvent, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, LoaderCircle, ShoppingCart, UserPlus, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/PageChrome';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { statusLabel } from '@/lib/labels';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { formatDate, formatETB } from '@/lib/format';
import { useT } from '@/lib/i18n';

interface Quote {
  course_title: string;
  seats: number;
  unit_price_etb: number;
  discount_percent: number;
  list_total_etb: number;
  total_etb: number;
}

/**
 * Corporate / institution training: buy N seats of any published course at a
 * volume discount, then assign them to staff by email. People with an account
 * get instant access; everyone else gets an invite that unlocks on signup.
 * Each seat shows the employee's progress.
 */
export function BulkPurchases({ organizationName }: { organizationName: string }) {
  const { locale } = useT();
  const queryClient = useQueryClient();
  const { data: orders } = useQuery({ queryKey: ['bulk-purchases'], queryFn: () => api<any[]>('/bulk-purchases/mine') });
  const { data: wallet } = useQuery({ queryKey: ['wallet'], queryFn: () => api<{ balance_etb: number }>('/wallet') });
  const [courseQuery, setCourseQuery] = useState('');
  const debouncedQuery = useDebouncedValue(courseQuery.trim());
  const { data: results } = useQuery({
    queryKey: ['bulk-course-search', debouncedQuery],
    queryFn: () => api<{ items: any[] }>(`/search?q=${encodeURIComponent(debouncedQuery)}&pricing_type=paid&limit=8`, { auth: false }),
    enabled: debouncedQuery.length >= 2,
  });
  const [course, setCourse] = useState<{ id: string; title: string } | null>(null);
  const [seats, setSeats] = useState(10);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, , setError, clear] = useFormStatus();

  const getQuote = async () => {
    if (!course) return;
    clear();
    try {
      setQuote(await api<Quote>('/bulk-purchases/quote', { method: 'POST', body: { course_id: course.id, seats } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const buy = async (useWallet: boolean) => {
    if (!course) return;
    setBusy(true);
    clear();
    try {
      const res = await api<{ checkout_url: string | null; confirmed: boolean }>('/bulk-purchases', {
        method: 'POST',
        body: { course_id: course.id, seats, organization_name: organizationName, ...(useWallet ? { use_wallet: true } : {}) },
      });
      if (res.confirmed) {
        queryClient.invalidateQueries({ queryKey: ['bulk-purchases'] });
        setQuote(null);
        setCourse(null);
      } else if (res.checkout_url) window.location.href = res.checkout_url;
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <section className="animate-fade-in-up">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
        <Building2 className="h-5 w-5 text-brand-500" /> Train your team — bulk seats
      </h2>
      <div className="card space-y-3">
        <p className="text-sm text-gray-600">Buy seats of any course for your staff at a volume discount (5+ seats 10% off, 10+ 20%, 50+ 30%), then assign them by email.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="relative sm:col-span-2">
            <Field label="Course">
              {(ids) => (
                <input {...ids} className="input" placeholder="Search a paid course…" value={course ? course.title : courseQuery} onChange={(e) => { setCourse(null); setQuote(null); setCourseQuery(e.target.value); }} />
              )}
            </Field>
            {!course && results?.items?.length ? (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border bg-card shadow-elevated" style={{ borderColor: 'var(--border)' }}>
                {results.items.map((c) => (
                  <li key={c.id}>
                    <button className="w-full px-3 py-2 text-left text-sm hover:bg-brand-500/5" onClick={() => { setCourse({ id: c.id, title: c.title }); setQuote(null); }}>
                      {c.title} <span className="text-xs text-gray-500">· {formatETB(c.price_etb, locale)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="flex min-w-0 items-end gap-2">
            <div className="w-24 shrink-0">
              <Field label="Seats">
                {(ids) => <input {...ids} type="number" min={2} max={5000} className="input" value={seats} onChange={(e) => { setSeats(+e.target.value); setQuote(null); }} />}
              </Field>
            </div>
            <button className="btn-secondary flex-1" disabled={!course || seats < 2} onClick={getQuote}>
              Get quote
            </button>
          </div>
        </div>
        {quote && (
          <div className="glass-secondary flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 text-sm">
            <span>
              <b>{quote.seats} seats</b> × {formatETB(quote.unit_price_etb, locale)}{quote.discount_percent > 0 && <span className="text-emerald-700 dark:text-emerald-400"> − {quote.discount_percent}% volume discount</span>} ={' '}
              <b className="text-brand-600">{formatETB(quote.total_etb, locale)}</b>
              {quote.discount_percent > 0 && <span className="text-xs text-gray-500"> (list {formatETB(quote.list_total_etb, locale)})</span>}
            </span>
            <span className="flex flex-wrap gap-2">
              <button className="btn" disabled={busy} onClick={() => buy(false)}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />} Pay with Chapa
              </button>
              {(wallet?.balance_etb ?? 0) >= quote.total_etb && (
                <button className="btn-secondary" disabled={busy} onClick={() => buy(true)}>
                  <Wallet className="h-4 w-4" /> Pay from wallet
                </button>
              )}
            </span>
          </div>
        )}
        <FormStatus status={status} />
      </div>

      {orders && orders.length > 0 && (
        <div className="mt-4 space-y-4">
          {orders.map((o) => (
            <BulkOrder key={o.id} order={o} />
          ))}
        </div>
      )}
    </section>
  );
}

function BulkOrder({ order: o }: { order: any }) {
  const { locale } = useT();
  const queryClient = useQueryClient();
  const [emails, setEmails] = useState('');
  const ask = useConfirm();
  const [status, setOk, setError, clear] = useFormStatus();
  const [busy, setBusy] = useState(false);
  const remaining = o.seats - o.seats_assigned;
  const assign = async (e: FormEvent) => {
    e.preventDefault();
    clear();
    // One seat per person: the same email typed twice (in any case) counts once.
    const list = Array.from(new Set(emails.split(/[\s,;]+/).filter(Boolean).map((x) => x.toLowerCase())));
    if (!list.length) return;
    if (
      !(await ask({
        title: `Assign ${list.length} seat${list.length === 1 ? '' : 's'} of ${o.course_title}?`,
        body: `Assigned seats can't be moved to someone else. ${list.join(', ')}`,
        confirmLabel: 'Assign seats',
      }))
    )
      return;
    setBusy(true);
    try {
      const res = await api<{ assigned: number; results: { email: string; status: string }[] }>(`/bulk-purchases/${o.id}/assign`, { method: 'POST', body: { emails: list } });
      setOk(`${res.assigned} seat${res.assigned === 1 ? '' : 's'} assigned (${res.results.filter((r) => r.status === 'invited').length} invited to sign up).`);
      setEmails('');
      queryClient.invalidateQueries({ queryKey: ['bulk-purchases'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-foreground">
          {o.course_title} <span className="text-xs font-normal text-gray-500">· {o.seats} seats · {formatETB(o.total_etb, locale)} · {formatDate(o.created_at, locale)}</span>
        </p>
        <span className="flex items-center gap-2">
          <StatusBadge status={o.status} />
          <span className="text-xs text-gray-500">{o.seats_assigned}/{o.seats} assigned</span>
        </span>
      </div>
      {o.status === 'active' && remaining > 0 && (
        <form onSubmit={assign} className="mt-3 flex flex-wrap gap-2">
          <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
            <Field label="Staff emails" hint={`Up to ${remaining}, comma or space separated.`}>
              {(ids) => <input {...ids} className="input" value={emails} onChange={(e) => setEmails(e.target.value)} />}
            </Field>
          </div>
          <button className="btn w-full !px-4 sm:mt-6 sm:w-auto sm:self-start" disabled={busy || !emails.trim()}>
            <UserPlus className="h-4 w-4" aria-hidden /> Assign seats
          </button>
        </form>
      )}
      <div className="mt-2">
        <FormStatus status={status} />
      </div>
      {o.assignments?.length > 0 && (
        <ul className="mt-3 divide-y text-xs" style={{ borderColor: 'var(--border)' }}>
          {o.assignments.map((a: any) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-foreground">{a.recipient_email}</span>
              <span className="flex items-center gap-3">
                {a.progress ? (
                  <span className="flex items-center gap-2">
                    <span className="progress-track w-24">
                      <span className="progress-fill block" style={{ width: `${a.progress.progress_percent}%` }} />
                    </span>
                    {a.progress.progress_percent}%{a.progress.lessons_complete ? ' ✓' : ''}
                  </span>
                ) : (
                  <span className="text-gray-500">{a.status === 'pending_claim' ? 'invited — not signed up yet' : statusLabel(a.status).label}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
