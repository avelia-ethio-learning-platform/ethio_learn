'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type State = 'polling' | 'active' | 'failed' | 'timeout';

/** Post-Chapa-redirect landing page. The redirect itself proves nothing —
 *  we ask the SERVER to reconcile (it verifies with Chapa's API directly) and
 *  it returns the authoritative payment status. Access is only granted by the
 *  PaymentConfirmed event that reconcile publishes (spec §6). */
function PaymentReturn() {
  const params = useSearchParams();
  const courseId = params.get('course_id');
  const txRef = params.get('tx_ref');
  const [state, setState] = useState<State>('polling');
  const done = useRef(false);

  /** One reconcile + entitlement check. Returns true once a terminal state is reached. */
  const check = useCallback(async (): Promise<boolean> => {
    if (done.current) return true;
    // Server verifies directly with Chapa and returns the real status — the
    // browser's word grants nothing.
    if (txRef) {
      try {
        const p = await api<{ status: string }>('/payments/reconcile', { method: 'POST', body: { tx_ref: txRef } });
        if (p.status === 'confirmed') { done.current = true; setState('active'); return true; }
        if (p.status === 'failed' || p.status === 'refunded') { done.current = true; setState('failed'); return true; }
      } catch {
        /* keep trying */
      }
    }
    // Entitlement may already be active (webhook path in production).
    if (courseId) {
      try {
        const res = await api<{ entitlement_status: string }>(`/enrollments/status?course_id=${courseId}`);
        if (res.entitlement_status === 'active') { done.current = true; setState('active'); return true; }
      } catch {
        /* keep trying */
      }
    }
    return false;
  }, [courseId, txRef]);

  useEffect(() => {
    // Local dev: Chapa redirects to the 127.0.0.1 form (its validator rejects
    // `localhost`). Bounce to localhost so the logged-in origin's session is
    // available for reconcile/polling.
    if (typeof window !== 'undefined' && window.location.hostname === '127.0.0.1') {
      window.location.replace(window.location.href.replace('//127.0.0.1', '//localhost'));
      return;
    }
    if (!courseId) return;
    let attempts = 0;
    void check();
    const timer = setInterval(async () => {
      attempts += 1;
      if (await check()) { clearInterval(timer); return; }
      if (attempts >= 12) { // ~30s of checking
        setState((s) => (s === 'polling' ? 'timeout' : s));
        clearInterval(timer);
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [courseId, check]);

  return (
    <div className="card mx-auto max-w-md text-center">
      {state === 'polling' && (
        <>
          <p className="text-3xl">⏳</p>
          <h1 className="mt-2 text-xl font-semibold">Confirming your payment…</h1>
          <p className="mt-2 text-sm text-gray-600">
            We&apos;re checking with Chapa. If you just finished on the Chapa page, this takes a few seconds.
          </p>
        </>
      )}
      {state === 'active' && (
        <>
          <p className="text-3xl">🎉</p>
          <h1 className="mt-2 text-xl font-semibold">You&apos;re in!</h1>
          <p className="mt-2 text-sm text-gray-600">Payment confirmed and your course is unlocked.</p>
          <Link href={`/learn/${courseId}`} className="btn mt-4 inline-flex">
            Start learning →
          </Link>
        </>
      )}
      {state === 'failed' && (
        <>
          <p className="text-3xl">❌</p>
          <h1 className="mt-2 text-xl font-semibold">Payment not completed</h1>
          <p className="mt-2 text-sm text-gray-600">
            Chapa reported this checkout was cancelled or didn&apos;t go through — no money was taken. You can try again.
          </p>
          {courseId && (
            <Link href={`/courses/${courseId}`} className="btn mt-4 inline-flex">
              Back to the course
            </Link>
          )}
        </>
      )}
      {state === 'timeout' && (
        <>
          <p className="text-3xl">🕐</p>
          <h1 className="mt-2 text-xl font-semibold">Still processing</h1>
          <p className="mt-2 text-sm text-gray-600">
            We haven&apos;t seen a confirmation yet. If you completed the payment on Chapa, click below to check again.
          </p>
          <button
            className="btn mt-4 inline-flex"
            onClick={async () => {
              setState('polling');
              done.current = false;
              if (!(await check())) setState('timeout');
            }}
          >
            Check again
          </button>
          <Link href="/dashboard" className="btn-secondary mt-3 inline-flex">
            Go to dashboard
          </Link>
        </>
      )}
    </div>
  );
}

export default function PaymentReturnPage() {
  return (
    <Suspense>
      <PaymentReturn />
    </Suspense>
  );
}
