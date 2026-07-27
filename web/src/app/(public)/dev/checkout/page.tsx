'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CreditCard, FlaskConical, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/PageChrome';

/** DEV-ONLY stand-in for Chapa's hosted checkout (CHAPA_MODE=mock). Completing
 *  it triggers a genuinely HMAC-signed webhook into the Financial Service. */
function MockCheckout() {
  const params = useSearchParams();
  const txRef = params.get('tx_ref') ?? '';
  const amount = params.get('amount') ?? '';
  const title = params.get('title') ?? 'Course';
  const returnUrl = params.get('return_url') ?? '/';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const complete = async (outcome: 'success' | 'failed') => {
    setBusy(true);
    setError('');
    try {
      await api('/payments/mock/complete', { method: 'POST', auth: false, body: { tx_ref: txRef, outcome } });
      window.location.href = returnUrl;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell icon={<CreditCard className="h-6 w-6" />} title="Chapa Checkout (mock)" subtitle={title}>
      <div className="badge-warn flex w-full items-start gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-xs !font-medium">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
        DEV SANDBOX — this simulates Chapa&apos;s hosted checkout. In production learners see chapa.co with Telebirr, CBE Birr and 18+
        Ethiopian banks.
      </div>
      <p className="gradient-text-blue mt-5 text-center text-4xl font-extrabold">{amount} ETB</p>
      <p className="mt-2 break-all text-center text-xs text-gray-400">tx_ref: {txRef}</p>
      {error && <p className="mt-3 text-sm font-medium text-red-500">{error}</p>}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button className="btn flex-1 !py-3" disabled={busy} onClick={() => complete('success')}>
          <CreditCard className="h-4 w-4" /> Pay (simulate success)
        </button>
        <button className="btn-secondary flex-1 !py-3" disabled={busy} onClick={() => complete('failed')}>
          <XCircle className="h-4 w-4" /> Simulate failure
        </button>
      </div>
    </AuthShell>
  );
}

export default function MockCheckoutPage() {
  return (
    <Suspense>
      <MockCheckout />
    </Suspense>
  );
}
