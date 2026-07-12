'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

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
    <div className="card mx-auto max-w-md">
      <p className="rounded bg-amber-100 px-3 py-2 text-xs text-amber-800">
        DEV SANDBOX — this simulates Chapa&apos;s hosted checkout. In production learners see chapa.co with Telebirr,
        CBE Birr and 18+ Ethiopian banks.
      </p>
      <h1 className="mt-4 text-xl font-semibold">Chapa Checkout (mock)</h1>
      <p className="mt-2 text-sm text-gray-600">{title}</p>
      <p className="mt-1 text-3xl font-bold">{amount} ETB</p>
      <p className="mt-1 break-all text-xs text-gray-400">tx_ref: {txRef}</p>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-6 flex gap-3">
        <button className="btn flex-1" disabled={busy} onClick={() => complete('success')}>
          Pay (simulate success)
        </button>
        <button className="btn-secondary flex-1" disabled={busy} onClick={() => complete('failed')}>
          Simulate failure
        </button>
      </div>
    </div>
  );
}

export default function MockCheckoutPage() {
  return (
    <Suspense>
      <MockCheckout />
    </Suspense>
  );
}
