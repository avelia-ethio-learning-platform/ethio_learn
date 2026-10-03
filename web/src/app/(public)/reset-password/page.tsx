'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AuthShell } from '@/components/PageChrome';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

function ResetPassword() {
  const params = useSearchParams();
  const { t } = useT();
  const token = params.get('token');
  const [status, setOk, setError, clearStatus] = useFormStatus();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    clearStatus();
    const form = new FormData(e.currentTarget);
    try {
      if (token) {
        const res: any = await api('/auth/reset-password/confirm', {
          method: 'POST',
          auth: false,
          body: { token, new_password: form.get('password') },
        });
        setOk(res.message);
        setDone(true);
      } else {
        const res: any = await api('/auth/reset-password', { method: 'POST', auth: false, body: { email: form.get('email') } });
        setOk(res.message);
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
          <Field label="New password (8+ characters)">
            {(ids) => <input {...ids} name="password" type="password" minLength={8} required autoComplete="new-password" className="input" />}
          </Field>
        ) : (
          <Field label="Account email">
            {(ids) => <input {...ids} name="email" type="email" required autoComplete="email" className="input" placeholder="you@example.com" />}
          </Field>
        )}
        <FormStatus status={status} />
        {done && (
          <Link href="/login" className="block text-center text-sm font-semibold text-brand-600 hover:underline">
            {t('login')} →
          </Link>
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
