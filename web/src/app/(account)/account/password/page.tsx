'use client';

import { FormEvent, Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, KeyRound } from 'lucide-react';
import { api, getAuth, setAuth } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';
import { RequireRole } from '@/components/RequireRole';
import { AuthShell } from '@/components/PageChrome';

function ChangePassword() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const first = params.get('first') === '1';
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (scorePassword(password).score < 3) {
      setError('Password must include at least 3 of: lowercase, uppercase, number, symbol (min 8 chars).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/profiles/password', { method: 'PUT', body: { new_password: password } });
      // clear the must_change flag locally so guards don't loop
      const auth = getAuth();
      if (auth) setAuth({ ...auth, user: { ...auth.user, must_change_password: false } });
      const dest =
        user?.role === 'quality_officer' ? '/qa' : user?.role === 'platform_admin' ? '/admin' : user?.role === 'learner' ? '/dashboard' : '/teach';
      router.push(dest);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell
      icon={<KeyRound className="h-6 w-6" />}
      title={first ? 'Set your password' : 'Change password'}
      subtitle={first ? 'Welcome! You logged in with a one-time password. Choose your own password to continue.' : undefined}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">New password</label>
          <input
            type="password"
            minLength={8}
            required
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
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </AuthShell>
  );
}

export default function ChangePasswordPage() {
  return (
    <Suspense>
      <RequireRole roles={['learner', 'educator', 'institution_admin', 'quality_officer', 'platform_admin']}>
        <ChangePassword />
      </RequireRole>
    </Suspense>
  );
}
