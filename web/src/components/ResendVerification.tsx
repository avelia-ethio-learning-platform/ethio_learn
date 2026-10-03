'use client';

import { useEffect, useState } from 'react';
import { ApiError, WakingError, api } from '@/lib/api';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

const COOLDOWN_SECONDS = 60;

interface ResendVerificationProps {
  email: string;
  /** The signup success screen: the signup email already counts toward the server's 60 s cap. */
  startCooledDown?: boolean;
  label?: string;
}

/** "Resend email" with a 60 s cooldown (the server caps one per minute) and an announced result. */
export function ResendVerification({ email, startCooledDown = false, label = 'Resend email' }: ResendVerificationProps) {
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
      if (err instanceof ApiError && err.status === 400) setError('Enter a valid email address.');
      else if (err instanceof ApiError && err.status === 429) setError('Too many requests. Wait a minute and try again.');
      else if (err instanceof WakingError) setError(err.message);
      else setError("Couldn't send right now. Try again in a minute.");
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <FormStatus status={status} />
      <button type="button" className="btn-secondary w-full" disabled={busy || cooling} onClick={resend}>
        {cooling ? `Resend in ${secondsLeft} s` : label}
      </button>
    </div>
  );
}
