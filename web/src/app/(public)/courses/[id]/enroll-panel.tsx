'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Gift, HandCoins, LoaderCircle, Lock, ShoppingCart, Sparkles, Ticket, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';

interface Quote {
  code: string | null;
  list_price_etb: number;
  discount_etb: number;
  amount_due_etb: number;
  description: string | null;
}

interface SessionResult {
  checkout_url: string | null;
  confirmed: boolean;
  amount_etb: number;
}

export function EnrollPanel({ courseId, pricingType, price }: { courseId: string; pricingType: string; price?: number | null }) {
  const { user, ready } = useAuth();
  const { t } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [coupon, setCoupon] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [couponError, setCouponError] = useState('');
  const [mode, setMode] = useState<'buy' | 'gift' | 'ask'>('buy');
  const paid = pricingType !== 'free';

  const { data: status } = useQuery({
    queryKey: ['enrollment-status', courseId],
    queryFn: () => api<{ entitlement_status: string }>(`/enrollments/status?course_id=${courseId}`),
    enabled: ready && user?.role === 'learner',
  });
  const { data: wallet } = useQuery({
    queryKey: ['wallet'],
    queryFn: () => api<{ balance_etb: number }>('/wallet'),
    enabled: ready && !!user && paid,
  });

  if (!ready) return <div className="skeleton mt-4 h-11 w-full" />;

  if (!user) {
    return (
      <button className="btn mt-4 w-full !py-3" onClick={() => router.push(`/login?next=/courses/${courseId}`)}>
        <Lock className="h-4 w-4" /> {t('login_to_enroll')}
      </button>
    );
  }
  if (user.role !== 'learner') {
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm text-gray-500">Log in as a learner to enroll.</p>
        {paid && <GiftForm courseId={courseId} amountDue={quote?.amount_due_etb ?? price ?? 0} walletBalance={wallet?.balance_etb ?? 0} coupon={quote?.code ?? ''} />}
      </div>
    );
  }
  if (status?.entitlement_status === 'active') {
    return (
      <div className="mt-4 space-y-3">
        <button className="btn w-full !py-3" onClick={() => router.push(`/learn/${courseId}`)}>
          {t('continue_learning')} <ArrowRight className="h-4 w-4" />
        </button>
        {paid && <GiftForm courseId={courseId} amountDue={price ?? 0} walletBalance={wallet?.balance_etb ?? 0} coupon="" compact />}
      </div>
    );
  }

  const amountDue = quote?.amount_due_etb ?? price ?? 0;
  const canUseWallet = paid && (wallet?.balance_etb ?? 0) >= amountDue && amountDue > 0;

  const applyCoupon = async () => {
    setCouponError('');
    if (!coupon.trim()) {
      setQuote(null);
      return;
    }
    try {
      setQuote(await api<Quote>(`/coupons/validate?code=${encodeURIComponent(coupon.trim())}&course_id=${courseId}`));
    } catch (err) {
      setQuote(null);
      setCouponError((err as Error).message);
    }
  };

  const enroll = async (useWallet = false) => {
    setBusy(true);
    setError('');
    try {
      if (!paid) {
        await api(`/enrollments`, { method: 'POST', body: { course_id: courseId } });
        router.push(`/learn/${courseId}`);
        return;
      }
      const res = await api<SessionResult>(`/payments/initiate`, {
        method: 'POST',
        body: { course_id: courseId, ...(quote?.code ? { coupon_code: quote.code } : {}), ...(useWallet ? { use_wallet: true } : {}) },
      });
      if (res.confirmed) {
        router.push(`/payment/return?course_id=${courseId}&instant=1`);
        return;
      }
      if (res.checkout_url) window.location.href = res.checkout_url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-3">
      {paid && (
        <div className="flex gap-1 rounded-xl bg-brand-500/5 p-1 text-xs font-semibold">
          {(
            [
              ['buy', 'Buy for me'],
              ['gift', 'Gift it'],
              ['ask', 'Ask someone to pay'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} className={`flex-1 rounded-lg px-2 py-1.5 transition ${mode === m ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900' : 'text-gray-500 hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === 'buy' && (
        <>
          {paid && (
            <div>
              <div className="flex gap-2">
                <input className="input flex-1 uppercase" placeholder="Coupon code" value={coupon} onChange={(e) => setCoupon(e.target.value)} onBlur={applyCoupon} />
                <button type="button" className="btn-secondary !px-3" onClick={applyCoupon}>
                  <Ticket className="h-4 w-4" /> Apply
                </button>
              </div>
              {quote?.code && (
                <p className="mt-1.5 text-xs font-medium text-emerald-600">
                  {quote.description} — you pay <b>{quote.amount_due_etb} ETB</b> instead of {quote.list_price_etb} ETB
                </p>
              )}
              {couponError && <p className="mt-1.5 text-xs font-medium text-red-500">{couponError}</p>}
            </div>
          )}
          <button className="btn w-full !py-3" onClick={() => enroll(false)} disabled={busy}>
            {busy ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" /> Please wait…
              </>
            ) : !paid ? (
              <>
                <Sparkles className="h-4 w-4" /> {t('enroll_free')}
              </>
            ) : amountDue <= 0 ? (
              <>
                <Ticket className="h-4 w-4" /> Enroll free with coupon
              </>
            ) : (
              <>
                <ShoppingCart className="h-4 w-4" /> {t('buy_with_chapa')}
                {quote?.code ? ` · ${amountDue} ETB` : ''}
              </>
            )}
          </button>
          {canUseWallet && (
            <button className="btn-secondary w-full !py-2.5" onClick={() => enroll(true)} disabled={busy}>
              <Wallet className="h-4 w-4" /> Pay {amountDue} ETB from my wallet ({wallet?.balance_etb} ETB available)
            </button>
          )}
          {paid && !canUseWallet && (wallet?.balance_etb ?? 0) > 0 && (
            <p className="text-center text-xs text-gray-400">Wallet balance {wallet?.balance_etb} ETB — top up from your dashboard to pay with credits.</p>
          )}
          {pricingType === 'freemium' && <p className="text-xs text-gray-500">The first section is free to preview — buy to unlock everything.</p>}
        </>
      )}

      {mode === 'gift' && <GiftForm courseId={courseId} amountDue={price ?? 0} walletBalance={wallet?.balance_etb ?? 0} coupon="" />}
      {mode === 'ask' && <AskToPayForm courseId={courseId} />}

      {error && <p className="text-sm font-medium text-red-500">{error}</p>}
    </div>
  );
}

/** Buy this course for someone else — by email; they get it instantly (or on signup). */
function GiftForm({ courseId, amountDue, walletBalance, coupon, compact = false }: { courseId: string; amountDue: number; walletBalance: number; coupon: string; compact?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(!compact);

  const submit = async (e: FormEvent, useWallet: boolean) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<SessionResult & { sponsorship_id: string }>('/gifts', {
        method: 'POST',
        body: { course_id: courseId, recipient_email: email, message: message || undefined, ...(coupon ? { coupon_code: coupon } : {}), ...(useWallet ? { use_wallet: true } : {}) },
      });
      if (res.confirmed) {
        router.push(`/dashboard?gift=${res.sponsorship_id}`);
        return;
      }
      if (res.checkout_url) window.location.href = res.checkout_url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn-secondary w-full !py-2.5" onClick={() => setOpen(true)}>
        <Gift className="h-4 w-4" /> Gift this course to someone
      </button>
    );
  }
  return (
    <form onSubmit={(e) => submit(e, false)} className="glass-secondary space-y-2 rounded-xl p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Gift className="h-4 w-4 text-brand-500" /> Gift this course
      </p>
      <input type="email" required className="input" placeholder="Recipient's email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <textarea className="input" rows={2} placeholder="A short message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />
      <p className="text-xs text-gray-500">If they don&apos;t have an account yet, we email them an invite and the course unlocks when they sign up with that address. You can follow their progress from your dashboard.</p>
      <button className="btn w-full" disabled={busy || !email}>
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />} Pay {amountDue} ETB with Chapa
      </button>
      {walletBalance >= amountDue && amountDue > 0 && (
        <button type="button" className="btn-secondary w-full" disabled={busy || !email} onClick={(e) => submit(e, true)}>
          <Wallet className="h-4 w-4" /> Pay from my wallet ({walletBalance} ETB)
        </button>
      )}
      {error && <p className="text-xs font-medium text-red-500">{error}</p>}
    </form>
  );
}

/** Send a payment request to a parent, employer or friend — they pay, you get access. */
function AskToPayForm({ courseId }: { courseId: string }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ pay_url: string } | null>(null);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setDone(await api<{ pay_url: string }>('/pay-requests', { method: 'POST', body: { course_id: courseId, payer_email: email, message: message || undefined } }));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="glass-secondary space-y-2 rounded-xl p-3 text-sm">
        <p className="font-semibold text-foreground">Request sent ✉️</p>
        <p className="text-gray-600">We emailed {email}. You&apos;ll get access the moment they pay. You can also share this link directly:</p>
        <input readOnly className="input text-xs" value={done.pay_url} onFocus={(e) => e.currentTarget.select()} />
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="glass-secondary space-y-2 rounded-xl p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <HandCoins className="h-4 w-4 text-brand-500" /> Ask someone to pay for you
      </p>
      <input type="email" required className="input" placeholder="Their email (parent, employer, friend…)" value={email} onChange={(e) => setEmail(e.target.value)} />
      <textarea className="input" rows={2} placeholder="Why this course matters to you (optional)" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />
      <button className="btn w-full" disabled={busy || !email}>
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />} Send payment request
      </button>
      {error && <p className="text-xs font-medium text-red-500">{error}</p>}
    </form>
  );
}
