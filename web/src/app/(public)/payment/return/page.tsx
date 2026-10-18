'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Clock3, LoaderCircle, PartyPopper, RefreshCcw, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/PageChrome';
import { useT, type TKey } from '@/lib/i18n';

type State = 'polling' | 'active' | 'failed' | 'timeout';

/** Post-Chapa-redirect landing page. The redirect itself proves nothing —
 *  we ask the SERVER to reconcile (it verifies with Chapa's API directly) and
 *  it returns the authoritative payment status. Access is only granted by the
 *  PaymentConfirmed event that reconcile publishes (spec §6). */
function PaymentReturn() {
  const params = useSearchParams();
  const courseId = params.get('course_id');
  const txRef = params.get('tx_ref');
  const purpose = params.get('purpose') ?? 'course';
  const { t } = useT();
  const instant = params.get('instant') === '1'; // wallet / 100% coupon — already confirmed server-side
  const [state, setState] = useState<State>('polling');
  const done = useRef(false);

  /** One reconcile + entitlement check. Returns true once a terminal state is reached. */
  const check = useCallback(async (): Promise<boolean> => {
    if (done.current) return true;
    if (instant) { done.current = true; setState('active'); return true; }
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
  }, [courseId, txRef, instant]);

  useEffect(() => {
    // Local dev: Chapa redirects to the 127.0.0.1 form (its validator rejects
    // `localhost`). Bounce to localhost so the logged-in origin's session is
    // available for reconcile/polling.
    if (typeof window !== 'undefined' && window.location.hostname === '127.0.0.1') {
      window.location.replace(window.location.href.replace('//127.0.0.1', '//localhost'));
      return;
    }
    if (!courseId && !txRef) return;
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
  const titles: Record<State, TKey> = {
    polling: 'pay_confirming',
    active: 'pay_youre_in',
    failed: 'pay_not_completed',
    timeout: 'pay_still_processing',
  };

  return (
    <AuthShell icon={icons[state]} title={t(titles[state])}>
      <div className="text-center">
        {state === 'polling' && (
          <p className="text-sm leading-relaxed text-gray-500">
            {t('pay_checking_chapa')}
          </p>
        )}
        {state === 'active' && (
          <>
            <p className="text-sm leading-relaxed text-gray-500">
              {t(purpose === 'wallet_topup' ? 'pay_done_wallet' : purpose === 'gift' || purpose === 'pay_request' ? 'pay_done_gift' : purpose === 'bulk' ? 'pay_done_bulk' : 'pay_done_course')}
            </p>
            <Link href={purpose === 'course' && courseId ? `/learn/${courseId}` : purpose === 'bulk' ? '/institution' : '/dashboard'} className="btn mt-5 inline-flex !px-8 !py-3">
              {t(purpose === 'course' ? 'start_learning' : 'continue')} <ArrowRight className="h-4 w-4" />
            </Link>
          </>
        )}
        {state === 'failed' && (
          <>
            <p className="text-sm leading-relaxed text-gray-500">
              {t('pay_failed_info')}
            </p>
            {courseId && (
              <Link href={`/courses/${courseId}`} className="btn mt-5 inline-flex !px-8 !py-3">
                {t('back_to_course')}
              </Link>
            )}
          </>
        )}
        {state === 'timeout' && (
          <>
            <p className="text-sm leading-relaxed text-gray-500">
              {t('pay_timeout_info')}
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
                <RefreshCcw className="h-4 w-4" /> {t('check_again')}
              </button>
              <Link href="/dashboard" className="btn-secondary inline-flex">
                {t('go_to_dashboard')}
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
