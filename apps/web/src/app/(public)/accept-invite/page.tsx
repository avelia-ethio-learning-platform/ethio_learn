'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, setAuth } from '@/lib/api';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';

function AcceptInvite() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<{ email: string; name: string; role: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError('This invite link is missing its token.');
      return;
    }
    api<{ email: string; name: string; role: string }>(`/auth/invite/${token}`, { auth: false })
      .then(setInfo)
      .catch((err) => setLoadError((err as Error).message));
  }, [token]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (scorePassword(password).score < 3) {
      setError('Password must include at least 3 of: lowercase, uppercase, number, symbol (min 8 chars).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api<{ access_token: string; user: any }>('/auth/accept-invite', {
        method: 'POST',
        auth: false,
        body: { token, new_password: password },
      });
      setAuth({ access_token: res.access_token, user: res.user });
      const role = res.user.role;
      router.push(role === 'quality_officer' ? '/qa' : role === 'platform_admin' ? '/admin' : role === 'learner' ? '/dashboard' : '/teach');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="card mx-auto max-w-md text-center">
        <p className="text-3xl">⚠️</p>
        <h1 className="mt-2 text-xl font-semibold">Invite link problem</h1>
        <p className="mt-2 text-sm text-gray-600">{loadError}</p>
        <p className="mt-3 text-sm">
          <Link href="/login" className="text-brand-700 underline">Go to log in</Link>
        </p>
      </div>
    );
  }

  if (!info) {
    return <div className="mx-auto max-w-md animate-pulse card text-center text-sm text-gray-400">Loading your invitation…</div>;
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">Welcome, {info.name.split(' ')[0]}!</h1>
      <p className="mt-2 text-sm text-gray-600">
        You've been invited as <strong>{info.role.replace('_', ' ')}</strong>. Choose a password for <strong>{info.email}</strong> to activate your account.
      </p>
      <form onSubmit={submit} className="card mt-4 space-y-4">
        <div>
          <label className="label">Choose a password</label>
          <input type="password" minLength={8} required autoFocus className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordStrength value={password} />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Setting up…' : 'Set password & continue'}
        </button>
      </form>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  );
}
