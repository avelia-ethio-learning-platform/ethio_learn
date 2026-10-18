'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Gift, HandCoins, LoaderCircle, Lock, ShoppingCart, Sparkles, Ticket, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';
import { formatETB } from '@/lib/format';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

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
  const { t, locale } = useT();
  const { user, ready } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [formStatus, , setError, clearStatus] = useFormStatus();
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
      <button data-primary-action="login" className="btn mt-4 w-full !py-3" onClick={() => router.push(`/login?next=/courses/${courseId}`)}>
        <Lock className="h-4 w-4" /> {t('login_to_enroll')}
      </button>
    );
  }
  if (user.role !== 'learner') {
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm text-gray-500">{t('learner_only_enroll')}</p>
        {paid && <GiftForm courseId={courseId} amountDue={quote?.amount_due_etb ?? price ?? 0} walletBalance={wallet?.balance_etb ?? 0} coupon={quote?.code ?? ''} />}
      </div>
    );
  }
  if (status?.entitlement_status === 'active') {
    return (
      <div className="mt-4 space-y-3">
        <button data-primary-action="continue" className="btn w-full !py-3" onClick={() => router.push(`/learn/${courseId}`)}>
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
    clearStatus();
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
              ['buy', 'mode_buy'],
              ['gift', 'mode_gift'],
              ['ask', 'mode_ask'],
            ] as const
          ).map(([m, key]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`flex-1 rounded-lg px-2 py-1.5 transition ${mode === m ? 'bg-card text-brand-700 shadow-sm' : 'text-gray-500 hover:text-foreground'}`}>
              {t(key)}
            </button>
          ))}
        </div>
      )}

      {mode === 'buy' && (
        <>
          {paid && (
            <div>
              <Field label={t('coupon_code')} error={couponError}>
                {(ids) => (
                  <div className="flex gap-2">
                    <input {...ids} className="input flex-1 uppercase" placeholder={t('coupon_code')} value={coupon} onChange={(e) => setCoupon(e.target.value)} onBlur={applyCoupon} />
                    <button type="button" className="btn-secondary !px-3" onClick={applyCoupon}>
                      <Ticket className="h-4 w-4" /> {t('apply')}
                    </button>
                  </div>
                )}
              </Field>
              {quote?.code && (
                <p className="mt-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  {quote.description} — {t('coupon_pay_instead', { due: formatETB(quote.amount_due_etb, locale), list: formatETB(quote.list_price_etb, locale) })}
                </p>
              )}
            </div>
          )}
          <button data-primary-action="enroll" className="btn w-full !py-3" onClick={() => enroll(false)} disabled={busy}>
            {busy ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" /> {t('please_wait')}
              </>
            ) : !paid ? (
              <>
                <Sparkles className="h-4 w-4" /> {t('enroll_free')}
              </>
            ) : amountDue <= 0 ? (
              <>
                <Ticket className="h-4 w-4" /> {t('enroll_free_coupon')}
              </>
            ) : (
              <>
                <ShoppingCart className="h-4 w-4" /> {t('buy_with_chapa')}
                {quote?.code ? ` · ${formatETB(amountDue, locale)}` : ''}
              </>
            )}
          </button>
          {canUseWallet && (
            <button className="btn-secondary w-full !py-2.5" onClick={() => enroll(true)} disabled={busy}>
              <Wallet className="h-4 w-4" /> {t('pay_from_wallet_available', { amount: formatETB(amountDue, locale), balance: formatETB(wallet?.balance_etb ?? 0, locale) })}
            </button>
          )}
          {paid && !canUseWallet && (wallet?.balance_etb ?? 0) > 0 && (
            <p className="text-center text-xs text-gray-500">{t('wallet_top_up_hint', { balance: formatETB(wallet?.balance_etb ?? 0, locale) })}</p>
          )}
          {pricingType === 'freemium' && <p className="text-xs text-gray-500">{t('freemium_hint')}</p>}
        </>
      )}

      {mode === 'gift' && <GiftForm courseId={courseId} amountDue={price ?? 0} walletBalance={wallet?.balance_etb ?? 0} coupon="" />}
      {mode === 'ask' && <AskToPayForm courseId={courseId} />}

      <FormStatus status={formStatus} />
    </div>
  );
}

/** Buy this course for someone else — by email; they get it instantly (or on signup). */
function GiftForm({ courseId, amountDue, walletBalance, coupon, compact = false }: { courseId: string; amountDue: number; walletBalance: number; coupon: string; compact?: boolean }) {
  const { t, locale } = useT();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, , setError, clearStatus] = useFormStatus();
  const [open, setOpen] = useState(!compact);

  const submit = async (e: FormEvent, useWallet: boolean) => {
    e.preventDefault();
    setBusy(true);
    clearStatus();
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
        <Gift className="h-4 w-4" /> {t('gift_to_someone')}
      </button>
    );
  }
  return (
    <form onSubmit={(e) => submit(e, false)} className="glass-secondary space-y-2 rounded-xl p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Gift className="h-4 w-4 text-brand-500" /> {t('gift_this_course')}
      </p>
      <Field label={t('recipient_email')}>
        {(ids) => <input {...ids} type="email" required className="input" placeholder={t('recipient_email')} value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field label={t('message_optional')}>
        {(ids) => <textarea {...ids} className="input" rows={2} placeholder={t('gift_message_placeholder')} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />}
      </Field>
      <p className="text-xs text-gray-500">{t('gift_invite_info')}</p>
      <button className="btn w-full" disabled={busy || !email}>
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />} {t('pay_with_chapa_amount', { amount: formatETB(amountDue, locale) })}
      </button>
      {walletBalance >= amountDue && amountDue > 0 && (
        <button type="button" className="btn-secondary w-full" disabled={busy || !email} onClick={(e) => submit(e, true)}>
          <Wallet className="h-4 w-4" /> {t('pay_from_wallet_balance', { balance: formatETB(walletBalance, locale) })}
        </button>
      )}
      <FormStatus status={status} />
    </form>
  );
}

/** Send a payment request to a parent, employer or friend — they pay, you get access. */
function AskToPayForm({ courseId }: { courseId: string }) {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ pay_url: string } | null>(null);
  const [status, setOk, setError, clearStatus] = useFormStatus();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    clearStatus();
    try {
      setDone(await api<{ pay_url: string }>('/pay-requests', { method: 'POST', body: { course_id: courseId, payer_email: email, message: message || undefined } }));
      setOk(t('request_sent', { email }));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      {done ? (
        <div className="glass-secondary space-y-2 rounded-xl p-3 text-sm">
          <p className="text-gray-600">{t('ask_access_info')}</p>
          <input readOnly aria-label={t('payment_link')} className="input text-xs" value={done.pay_url} onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : (
        <form onSubmit={submit} className="glass-secondary space-y-2 rounded-xl p-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <HandCoins className="h-4 w-4 text-brand-500" /> {t('ask_title')}
          </p>
          <Field label={t('their_email')}>
            {(ids) => <input {...ids} type="email" required className="input" placeholder={t('their_email_placeholder')} value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label={t('message_optional')}>
            {(ids) => <textarea {...ids} className="input" rows={2} placeholder={t('ask_message_placeholder')} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />}
          </Field>
          <button className="btn w-full" disabled={busy || !email}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />} {t('send_payment_request')}
          </button>
        </form>
      )}
      <FormStatus status={status} />
    </div>
  );
}
