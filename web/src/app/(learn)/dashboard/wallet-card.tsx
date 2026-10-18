'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatDate, formatETB } from '@/lib/format';
import { walletKindLabel } from '@/lib/labels';
import { keyed } from '@/components/Localized';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

/** Prepaid credits: balance, top-up via Chapa, recent movements. */
export function WalletCard() {
  const { t, locale } = useT();
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
            <Wallet className="h-4 w-4 text-brand-500" /> {t('wallet')}
          </p>
          <p className="gradient-text-blue mt-1 text-3xl font-extrabold">{formatETB(wallet?.balance_etb ?? 0, locale)}</p>
          {wallet?.pending_etb > 0 && (
            <p className="mt-1 text-sm font-semibold text-amber-700 dark:text-amber-400">{t('amount_pending', { amount: formatETB(wallet.pending_etb, locale) })}</p>
          )}
          <p className="mt-1 text-xs text-gray-500">
            {t('cashback_info', { n: wallet?.cashback_percent ?? 5 })}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <Field label={t('topup_amount')}>
          {(ids) => (
            <div className="flex gap-2">
              <input {...ids} type="number" min={50} max={50000} step={50} className="input w-28" value={amount} onChange={(e) => setAmount(+e.target.value)} />
              <button className="btn !px-4" disabled={busy || amount < 50} onClick={topUp}>
                {t('topup_chapa')}
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
              <span className="truncate">{tx.note || keyed(t, 'wallet_kind_', tx.kind, walletKindLabel(tx.kind))}</span>
              <span className="shrink-0 text-right">
                <span
                  className={
                    tx.state === 'void'
                      ? 'text-gray-500 line-through'
                      : tx.amount_etb >= 0
                        ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                        : 'font-semibold text-gray-700'
                  }
                >
                  {tx.amount_etb >= 0 ? '+' : ''}
                  {formatETB(tx.amount_etb, locale)}
                </span>
                {tx.state === 'pending' && tx.available_at && <span className="block text-amber-700 dark:text-amber-400">{t('available_on', { date: formatDate(tx.available_at, locale) })}</span>}
                {tx.state === 'void' && <span className="block">{t('status_refunded')}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
