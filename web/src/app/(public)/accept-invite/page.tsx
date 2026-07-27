'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, PartyPopper, TriangleAlert } from 'lucide-react';
import { api, setAuth } from '@/lib/api';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';
import { AuthShell } from '@/components/PageChrome';

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
      <AuthShell icon={<TriangleAlert className="h-6 w-6" />} title="Invite link problem">
        <div className="text-center">
          <p className="text-sm leading-relaxed text-gray-500">{loadError}</p>
          <p className="mt-4 text-sm">
            <Link href="/login" className="font-semibold text-brand-600 hover:underline">
              Go to log in →
            </Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  if (!info) {
    return (
      <AuthShell title="Loading your invitation…">
        <div className="space-y-3">
          <div className="skeleton h-5 w-3/4" />
          <div className="skeleton h-10 w-full" />
          <div className="skeleton h-10 w-full" />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      icon={<PartyPopper className="h-6 w-6" />}
      title={`Welcome, ${info.name.split(' ')[0]}!`}
      subtitle={
        <>
          You&apos;ve been invited as <strong className="text-foreground">{info.role.replace('_', ' ')}</strong>. Choose a password for{' '}
          <strong className="text-foreground">{info.email}</strong> to activate your account.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Choose a password</label>
          <input
            type="password"
            minLength={8}
            required
            autoFocus
            autoComplete="new-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <PasswordStrength value={password} />
        </div>
        {error && (
          <p className="badge-danger flex w-full items-start gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm !font-medium">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}
        <button className="btn w-full !py-3" disabled={busy}>
          {busy ? 'Setting up…' : 'Set password & continue'}
        </button>
      </form>
    </AuthShell>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  );
}
