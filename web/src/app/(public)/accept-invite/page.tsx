'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PartyPopper, TriangleAlert } from 'lucide-react';
import { api, setAuth } from '@/lib/api';
import { roleHome } from '@/lib/safe-next';
import { roleLabel } from '@/lib/labels';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';
import { AuthShell } from '@/components/PageChrome';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

function AcceptInvite() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<{ email: string; name: string; role: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [status, , setError, clearStatus] = useFormStatus();
  const [passwordError, setPasswordError] = useState('');
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
    if (!scorePassword(password).ok) {
      // The field error replaces any earlier server error, which no longer applies.
      clearStatus();
      setPasswordError('Password must include at least 3 of: lowercase, uppercase, number, symbol (min 8 chars).');
      return;
    }
    setBusy(true);
    setPasswordError('');
    clearStatus();
    try {
      const res = await api<{ access_token: string; user: any; pending_institution_invites?: number }>('/auth/accept-invite', {
        method: 'POST',
        auth: false,
        body: { token, new_password: password },
      });
      setAuth({ access_token: res.access_token, user: res.user });
      // An institution's invitation is accepted next, by name, on its own page.
      router.push(res.pending_institution_invites ? '/account/invites' : roleHome(res.user.role));
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
        info.role === 'learner' ? (
          // An institution's invitee: the account is a learner until they accept.
          <>
            Choose a password for <strong className="text-foreground">{info.email}</strong>. Then you can accept your invitation to teach.
          </>
        ) : (
          <>
            You&apos;ve been invited as <strong className="text-foreground">{roleLabel(info.role)}</strong>. Choose a password for{' '}
            <strong className="text-foreground">{info.email}</strong> to activate your account.
          </>
        )
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Field label="Choose a password" error={passwordError}>
            {(ids) => (
              <input
                {...ids}
                type="password"
                minLength={8}
                required
                autoFocus
                autoComplete="new-password"
                maxLength={128}
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <PasswordStrength value={password} />
        </div>
        <FormStatus status={status} />
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
