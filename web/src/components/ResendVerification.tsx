'use client';

import { useEffect, useState } from 'react';
import { ApiError, WakingError, api } from '@/lib/api';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { useT } from '@/lib/i18n';

const COOLDOWN_SECONDS = 60;

interface ResendVerificationProps {
  email: string;
  /** The signup success screen: the signup email already counts toward the server's 60 s cap. */
  startCooledDown?: boolean;
  label?: string;
}

/** "Resend email" with a 60 s cooldown (the server caps one per minute) and an announced result. */
export function ResendVerification({ email, startCooledDown = false, label }: ResendVerificationProps) {
  const { t } = useT();
  const [status, setOk, setError] = useFormStatus();
  const [secondsLeft, setSecondsLeft] = useState(startCooledDown ? COOLDOWN_SECONDS : 0);
  const [busy, setBusy] = useState(false);
  const cooling = secondsLeft > 0;

  useEffect(() => {
    if (!cooling) return;
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooling]);

  const resend = async () => {
    setBusy(true);
    try {
      const res = await api<{ message: string }>('/auth/resend-verification', { method: 'POST', auth: false, body: { email } });
      setOk(res.message);
      setSecondsLeft(COOLDOWN_SECONDS);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setError(t('enter_valid_email'));
      else if (err instanceof ApiError && err.status === 429) setError(t('too_many_requests'));
      else if (err instanceof WakingError) setError(err.message);
      else setError(t('send_failed'));
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <FormStatus status={status} />
      <button type="button" className="btn-secondary w-full" disabled={busy || cooling} onClick={resend}>
        {cooling ? t('resend_in', { s: secondsLeft }) : (label ?? t('resend_email'))}
      </button>
    </div>
  );
}
