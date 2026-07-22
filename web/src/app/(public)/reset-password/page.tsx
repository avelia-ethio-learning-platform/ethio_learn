'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AuthShell } from '@/components/PageChrome';

function ResetPassword() {
  const params = useSearchParams();
  const { t } = useT();
  const token = params.get('token');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      if (token) {
        const res: any = await api('/auth/reset-password/confirm', {
          method: 'POST',
          auth: false,
          body: { token, new_password: form.get('password') },
        });
        setMessage(`${res.message} `);
      } else {
        const res: any = await api('/auth/reset-password', { method: 'POST', auth: false, body: { email: form.get('email') } });
        setMessage(res.message);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <AuthShell
      icon={<KeyRound className="h-6 w-6" />}
      title={token ? 'Set a new password' : 'Reset your password'}
      subtitle={token ? 'Choose a strong password for your account.' : "We'll email you a signed, time-limited reset link."}
      footer={
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          ← {t('login')}
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {token ? (
          <div>
            <label className="label">New password (8+ characters)</label>
            <input name="password" type="password" minLength={8} required autoComplete="new-password" className="input" />
          </div>
        ) : (
          <div>
            <label className="label">Account email</label>
            <input name="email" type="email" required autoComplete="email" className="input" placeholder="you@example.com" />
          </div>
        )}
        {message && (
          <p className="badge-success flex w-full items-start gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm !font-medium">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {message}
              {token && (
                <Link href="/login" className="ml-1 font-semibold underline">
                  {t('login')}
                </Link>
              )}
            </span>
          </p>
        )}
        {error && (
          <p className="badge-danger flex w-full items-start gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm !font-medium">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}
        <button className="btn w-full !py-3" disabled={busy}>
          {busy ? 'Working…' : token ? 'Update password' : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
