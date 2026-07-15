'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Clock3, LoaderCircle, PartyPopper, RefreshCcw, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/PageChrome';

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

  const icons: Record<State, React.ReactNode> = {
    polling: <LoaderCircle className="h-6 w-6 animate-spin" />,
    active: <PartyPopper className="h-6 w-6" />,
    failed: <XCircle className="h-6 w-6" />,
    timeout: <Clock3 className="h-6 w-6" />,
  };
  const titles: Record<State, string> = {
    polling: 'Confirming your payment…',
    active: "You're in!",
    failed: 'Payment not completed',
    timeout: 'Still processing',
  };

  return (
    <AuthShell icon={icons[state]} title={titles[state]}>
      <div className="text-center">
        {state === 'polling' && (
          <p className="text-sm leading-relaxed text-gray-500">
            We&apos;re checking with Chapa. If you just finished on the Chapa page, this takes a few seconds.
          </p>
        )}
        {state === 'active' && (
          <>
            <p className="text-sm leading-relaxed text-gray-500">Payment confirmed and your course is unlocked.</p>
            <Link href={`/learn/${courseId}`} className="btn mt-5 inline-flex !px-8 !py-3">
              Start learning <ArrowRight className="h-4 w-4" />
            </Link>
          </>
        )}
        {state === 'failed' && (
          <>
            <p className="text-sm leading-relaxed text-gray-500">
              Chapa reported this checkout was cancelled or didn&apos;t go through — no money was taken. You can try again.
            </p>
            {courseId && (
              <Link href={`/courses/${courseId}`} className="btn mt-5 inline-flex !px-8 !py-3">
                Back to the course
              </Link>
            )}
          </>
        )}
        {state === 'timeout' && (
          <>
            <p className="text-sm leading-relaxed text-gray-500">
              We haven&apos;t seen a confirmation yet. If you completed the payment on Chapa, click below to check again.
            </p>
            <div className="mt-5 flex flex-col items-center gap-3">
              <button
                className="btn inline-flex !px-8 !py-3"
                onClick={async () => {
                  setState('polling');
                  done.current = false;
                  if (!(await check())) setState('timeout');
                }}
              >
                <RefreshCcw className="h-4 w-4" /> Check again
              </button>
              <Link href="/dashboard" className="btn-secondary inline-flex">
                Go to dashboard
              </Link>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function PaymentReturnPage() {
  return (
    <Suspense>
      <PaymentReturn />
    </Suspense>
  );
}
