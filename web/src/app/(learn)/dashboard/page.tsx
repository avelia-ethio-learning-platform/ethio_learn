'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Award,
  BookOpen,
  Copy,
  Download,
  ExternalLink,
  Gift,
  GraduationCap,
  HandCoins,
  ReceiptText,
  RotateCcw,
  Send,
  Undo2,
  Users,
  Wallet,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RequireRole } from '@/components/RequireRole';
import { PageHeader, PageShell, StatusBadge } from '@/components/PageChrome';
import { PendingInvitesBanner } from '@/components/PendingInvitesBanner';
import { formatDate, formatETB } from '@/lib/format';
import { refundRuleLabel, sentenceCase, statusLabel } from '@/lib/labels';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

function LearnerDashboard() {
  const { locale } = useT();
  const { t } = useT();
  const queryClient = useQueryClient();
  const { data: enrollments, isLoading: enrollLoading } = useQuery({ queryKey: ['enrollments'], queryFn: () => api<any[]>('/enrollments') });
  const { data: certificates } = useQuery({ queryKey: ['certificates'], queryFn: () => api<any[]>('/me/certificates') });
  const { data: payments } = useQuery({ queryKey: ['payments'], queryFn: () => api<any[]>('/payments/mine') });
  const { data: refunds } = useQuery({ queryKey: ['refunds'], queryFn: () => api<any[]>('/refunds/mine') });

  // First visit after signup: attach the referral code / claim gifted seats waiting on this email.
  useEffect(() => {
    (async () => {
      try {
        const ref = localStorage.getItem('el_ref');
        if (ref) {
          await api('/referrals/claim', { method: 'POST', body: { code: ref } }).catch(() => undefined);
          localStorage.removeItem('el_ref');
        }
        const claimed = await api<{ claimed: number }>('/sponsorships/claim', { method: 'POST' });
        localStorage.removeItem('el_gift');
        if (claimed.claimed > 0) {
          queryClient.invalidateQueries({ queryKey: ['enrollments'] });
          queryClient.invalidateQueries({ queryKey: ['sponsorships'] });
        }
      } catch {
        /* offline or not applicable */
      }
    })();
  }, [queryClient]);

  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <GraduationCap className="h-4 w-4 text-brand-500" /> {t('my_learning')}
          </span>
        }
        title={t('my_learning')}
        subtitle="Your courses, certificates, wallet and payments in one place."
      />
      <PendingInvitesBanner />

      <div className="space-y-10">
        <section className="animate-fade-in-up">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
            <BookOpen className="h-5 w-5 text-brand-500" /> {t('enrolled_courses')}
          </h2>
          {enrollLoading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="skeleton h-36" />
              <div className="skeleton h-36" />
            </div>
          ) : !enrollments?.length ? (
            <div className="card flex flex-col items-center gap-3 py-12 text-center">
              <span className="glass-secondary flex h-14 w-14 items-center justify-center rounded-2xl">
                <BookOpen className="h-6 w-6 text-brand-500" />
              </span>
              <p className="text-sm text-gray-500">You haven&apos;t enrolled in any course yet.</p>
              <Link href="/courses" className="btn mt-1">
                Browse the catalog <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {enrollments.map((e) => (
                <div key={e.id} className="card card-hover">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 flex-1 font-semibold text-foreground">{e.course_title ?? 'Course'}</h3>
                    <StatusBadge status={e.entitlement_status} />
                  </div>
                  <div className="progress-track mt-4">
                    <div className="progress-fill" style={{ width: `${e.progress_percent}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    {e.progress_percent}% {t('progress')}
                    {e.completed_at ? ' · finished 🎉' : ''}
                    {e.source === 'sponsorship' ? ' · 🎁 gifted' : ''}
                  </p>
                  {e.entitlement_status === 'active' && (
                    <Link href={`/learn/${e.course_id}`} className="btn-secondary mt-4 inline-flex !px-3 !py-1.5 !text-xs">
                      {e.completed_at ? 'Revisit' : t('continue_learning')} <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="grid animate-fade-in-up gap-6 md:grid-cols-2" style={{ animationDelay: '0.05s' }}>
          <WalletCard />
          <ReferralCard />
        </section>

        <SponsorshipsSection />

        <section className="animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
            <Award className="h-5 w-5 text-brand-500" /> {t('certificates')}
          </h2>
          {!certificates?.length ? (
            <div className="card flex flex-col items-center gap-3 py-10 text-center">
              <span className="glass-secondary flex h-14 w-14 items-center justify-center rounded-2xl">
                <Award className="h-6 w-6 text-brand-500" />
              </span>
              <p className="max-w-sm text-sm text-gray-500">Complete a course (and its assessments) to earn a verifiable certificate.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {certificates.map((c) => (
                <div key={c.id} className="card card-hover relative overflow-hidden">
                  <span className="gradient-ethiopia absolute inset-x-0 top-0 h-1 opacity-70" />
                  <p className="flex items-center gap-2 font-semibold text-foreground">
                    <span className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl">
                      <Award className="h-4 w-4 text-brand-600" />
                    </span>
                    {c.course_title}
                  </p>
                  <p className="mt-2 text-xs text-gray-500">Issued {formatDate(c.issued_at, locale)}</p>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    <a className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline" href={c.verify_url}>
                      <ExternalLink className="h-3.5 w-3.5" /> Public verification
                    </a>
                    <DownloadCert id={c.id} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="animate-fade-in-up" style={{ animationDelay: '0.18s' }}>
            <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
              <ReceiptText className="h-5 w-5 text-brand-500" /> {t('payment_history')}
            </h2>
            <div className="card text-sm">
              {!payments?.length && <p className="py-2 text-gray-500">No payments yet.</p>}
              {payments?.map((p, i) => (
                <div key={p.id} className="flex items-center justify-between gap-2 py-2.5" style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}>
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {p.course_title}
                    {p.purpose && p.purpose !== 'course' && <span className="ml-1 text-xs text-gray-500">({sentenceCase(p.purpose).toLowerCase()})</span>}
                  </span>
                  <span className="shrink-0 font-medium text-foreground">
                    {formatETB(p.amount_etb, locale)}{p.discount_etb > 0 && <span className="ml-1 text-xs text-emerald-700 dark:text-emerald-400">−{formatETB(p.discount_etb, locale)}</span>}
                  </span>
                  <StatusBadge status={p.status} />
                  {p.status === 'confirmed' && p.purpose === 'course' && p.method === 'chapa' && <RefundButton paymentId={p.id} />}
                </div>
              ))}
            </div>
          </div>
          <div className="animate-fade-in-up" style={{ animationDelay: '0.26s' }}>
            <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
              <Undo2 className="h-5 w-5 text-brand-500" /> {t('refund_requests')}
            </h2>
            <div className="card text-sm">
              {!refunds?.length && <p className="py-2 text-gray-500">No refund requests.</p>}
              {refunds?.map((r, i) => (
                <div key={r.id} className="flex items-center justify-between gap-2 py-2.5" style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}>
                  <span className="min-w-0 flex-1 truncate pr-2 text-foreground">{r.reason}</span>
                  <StatusBadge status={r.status} />
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

/** Prepaid credits: balance, top-up via Chapa, recent movements. */
function WalletCard() {
  const { locale } = useT();
  const { data: wallet } = useQuery({ queryKey: ['wallet'], queryFn: () => api<any>('/wallet') });
  const [amount, setAmount] = useState(200);
  const [busy, setBusy] = useState(false);
  const [status, , setError, clearStatus] = useFormStatus();
  const topUp = async () => {
    setBusy(true);
    clearStatus();
    try {
      const res = await api<{ checkout_url: string | null }>('/wallet/topup', { method: 'POST', body: { amount_etb: amount } });
      if (res.checkout_url) window.location.href = res.checkout_url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <Wallet className="h-4 w-4 text-brand-500" /> Wallet
          </p>
          <p className="gradient-text-blue mt-1 text-3xl font-extrabold">{formatETB(wallet?.balance_etb ?? 0, locale)}</p>
          <p className="mt-1 text-xs text-gray-500">
            Earn {wallet?.cashback_percent ?? 5}% cashback on every purchase · spend credits on any course
          </p>
        </div>
      </div>
      <div className="mt-4">
        <Field label="Top-up amount (ETB)">
          {(ids) => (
            <div className="flex gap-2">
              <input {...ids} type="number" min={50} max={50000} step={50} className="input w-28" value={amount} onChange={(e) => setAmount(+e.target.value)} />
              <button className="btn !px-4" disabled={busy || amount < 50} onClick={topUp}>
                Top up with Chapa
              </button>
            </div>
          )}
        </Field>
      </div>
      <FormStatus status={status} />
      {wallet?.transactions?.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs text-gray-500">
          {wallet.transactions.slice(0, 5).map((tx: any) => (
            <li key={tx.id} className="flex justify-between gap-2">
              <span className="truncate">{tx.note || tx.kind}</span>
              <span className={tx.amount_etb >= 0 ? 'shrink-0 font-semibold text-emerald-700 dark:text-emerald-400' : 'shrink-0 font-semibold text-gray-700'}>
                {tx.amount_etb >= 0 ? '+' : ''}
                {formatETB(tx.amount_etb, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Invite friends: share link + email invites; rewards land in the wallet. */
function ReferralCard() {
  const { locale } = useT();
  const { data } = useQuery({ queryKey: ['referral'], queryFn: () => api<any>('/referrals/me') });
  const [emails, setEmails] = useState('');
  const [message, setMessage] = useState('');
  const [status, setOk, setError, clearStatus, setInfo] = useFormStatus();
  const [copied, setCopied] = useState(false);
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    clearStatus();
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    try {
      const res = await api<{ invited: number }>('/referrals/invite', { method: 'POST', body: { emails: list, message: message || undefined } });
      if (res.invited === 0) {
        // Nothing went out: a polite note, not a success.
        setInfo('No new invitations sent: these people already have an account or were invited recently.');
      } else {
        setOk(`Sent ${res.invited} invitation${res.invited === 1 ? '' : 's'}.`);
      }
      setEmails('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="card">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
        <Users className="h-4 w-4 text-brand-500" /> Invite &amp; earn
      </p>
      <p className="mt-1 text-sm text-gray-600">
        Get <b>{formatETB(data?.reward_etb ?? 50, locale)}</b> in your wallet when someone you invite makes their first purchase.
      </p>
      {data && (
        <div className="mt-3 flex gap-2">
          <input readOnly aria-label="Your invite link" className="input flex-1 text-xs" value={data.share_url} onFocus={(e) => e.currentTarget.select()} />
          <button
            className="btn-secondary !px-3"
            onClick={async () => {
              await navigator.clipboard?.writeText(data.share_url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy className="h-4 w-4" /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <form onSubmit={invite} className="mt-3 space-y-2">
        <Field label="Friends' email addresses">
          {(ids) => <input {...ids} className="input" placeholder="friend@example.com, another@example.com" value={emails} onChange={(e) => setEmails(e.target.value)} />}
        </Field>
        <Field label="Personal note (optional)">
          {(ids) => (
            <div className="flex gap-2">
              <input {...ids} className="input flex-1" placeholder="Personal note (optional)" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />
              <button className="btn !px-4" disabled={!emails.trim()}>
                <Send className="h-4 w-4" /> Invite
              </button>
            </div>
          )}
        </Field>
        <FormStatus status={status} />
      </form>
      {data?.stats && (
        <p className="mt-3 text-xs text-gray-500">
          {data.stats.signed_up + data.stats.rewarded} joined · {data.stats.rewarded} purchased · earned {formatETB(data.stats.earned_etb, locale)}
        </p>
      )}
    </div>
  );
}

/** Gifts given (with each recipient's progress — the parent / sponsor view), received, and my pay requests. */
function SponsorshipsSection() {
  const { data } = useQuery({ queryKey: ['sponsorships'], queryFn: () => api<any>('/sponsorships/mine') });
  if (!data || (!data.given?.length && !data.received?.length && !data.pay_requests?.length)) return null;
  return (
    <section className="animate-fade-in-up" style={{ animationDelay: '0.08s' }}>
      <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-foreground">
        <Gift className="h-5 w-5 text-brand-500" /> Gifts &amp; sponsored learning
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        {data.given?.length > 0 && (
          <div className="card text-sm">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Courses you paid for others</p>
            <ul className="space-y-3">
              {data.given.map((s: any) => (
                <li key={s.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-foreground">
                      <b>{s.course_title}</b> → {s.recipient_email}
                    </span>
                    <StatusBadge status={s.status === 'pending_claim' ? 'invited' : s.status} />
                  </div>
                  {s.progress && (
                    <>
                      <div className="progress-track mt-2">
                        <div className="progress-fill" style={{ width: `${s.progress.progress_percent}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {s.progress.progress_percent}% complete{s.progress.lessons_complete ? ' · finished 🎉' : ''}
                      </p>
                    </>
                  )}
                  {s.status === 'pending_claim' && <p className="mt-1 text-xs text-gray-500">Waiting for them to sign up with that email.</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.received?.length > 0 && (
          <div className="card text-sm">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Gifted to you</p>
            <ul className="space-y-2">
              {data.received.map((s: any) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-foreground">
                    <b>{s.course_title}</b> from {s.organization_name || s.sponsor_name || 'a sponsor'}
                  </span>
                  <Link href={`/learn/${s.course_id}`} className="btn-secondary !px-3 !py-1 !text-xs">
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.pay_requests?.length > 0 && (
          <div className="card text-sm">
            <p className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <HandCoins className="h-3.5 w-3.5" /> Payment requests you sent
            </p>
            <ul className="space-y-2">
              {data.pay_requests.map((s: any) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-foreground">
                    <b>{s.course_title}</b> · asked {s.asked}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={s.status === 'requested' ? 'pending' : s.status === 'granted' ? 'paid' : s.status} />
                    {s.status !== 'granted' && (
                      <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => navigator.clipboard?.writeText(s.pay_url)}>
                        Copy link
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function DownloadCert({ id }: { id: string }) {
  return (
    <button
      className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
      onClick={async () => {
        const res = await api<{ url: string }>(`/me/certificates/${id}/download`);
        window.open(res.url, '_blank');
      }}
    >
      <Download className="h-3.5 w-3.5" /> Download PDF
    </button>
  );
}

function RefundButton({ paymentId }: { paymentId: string }) {
  return (
    <button
      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400 hover:underline"
      onClick={async () => {
        const reason = prompt('Why do you want a refund?');
        if (!reason) return;
        try {
          const res = await api<{ status: string; rule: string }>(`/refunds`, { method: 'POST', body: { payment_id: paymentId, reason } });
          const why = refundRuleLabel(res.rule);
          alert(`Refund request: ${statusLabel(res.status).label}${why ? ` (${why})` : ''}. Refresh to see updates.`);
        } catch (err) {
          alert((err as Error).message);
        }
      }}
    >
      <RotateCcw className="h-3 w-3" /> Refund
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
