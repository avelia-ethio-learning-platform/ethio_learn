'use client';

import { FormEvent, Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, getAuth, setAuth } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';
import { RequireRole } from '@/components/RequireRole';

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
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">{first ? 'Set your password' : 'Change password'}</h1>
      {first && (
        <p className="mt-2 text-sm text-gray-600">
          Welcome! You logged in with a one-time password. Choose your own password to continue.
        </p>
      )}
      <form onSubmit={submit} className="card mt-4 space-y-4">
        <div>
          <label className="label">New password</label>
          <input type="password" minLength={8} required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordStrength value={password} />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </div>
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
