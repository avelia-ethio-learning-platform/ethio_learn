'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

function ResetPassword() {
  const params = useSearchParams();
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
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">{token ? 'Set a new password' : 'Reset your password'}</h1>
      <form onSubmit={submit} className="card mt-4 space-y-4">
        {token ? (
          <div>
            <label className="label">New password (8+ characters)</label>
            <input name="password" type="password" minLength={8} required className="input" />
          </div>
        ) : (
          <div>
            <label className="label">Account email</label>
            <input name="email" type="email" required className="input" />
            <p className="mt-1 text-xs text-gray-500">We&apos;ll email you a signed, time-limited reset link.</p>
          </div>
        )}
        {message && (
          <p className="text-sm text-green-700">
            {message}
            {token && <Link href="/login" className="text-brand-700 underline">Log in</Link>}
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Working…' : token ? 'Update password' : 'Send reset link'}
        </button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
