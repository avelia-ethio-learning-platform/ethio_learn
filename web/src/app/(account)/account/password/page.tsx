'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { api, AuthUser, setAuth } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';
import { RequireRole } from '@/components/RequireRole';
import { AuthShell } from '@/components/PageChrome';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

function ChangePassword() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const first = params.get('first') === '1';
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  // Set when the server itself says the current password is needed (the
  // profile lookup failed, or the first-login flag does not apply).
  const [serverWantsCurrent, setServerWantsCurrent] = useState(false);
  const [status, , setError, clearStatus] = useFormStatus();
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState(false);

  // Google-only accounts have no password to confirm; the first-login path
  // uses a one-time password the user just typed, so it asks for nothing more.
  const needsCurrent = serverWantsCurrent || (hasPassword && !first && !user?.must_change_password);

  useEffect(() => {
    api<{ has_password: boolean }>('/profiles/me')
      .then((me) => setHasPassword(me.has_password))
      .catch(() => undefined); // the server still enforces the check on submit
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!scorePassword(password).ok) {
      // The field error replaces any earlier server error, which no longer applies.
      clearStatus();
      setPasswordError('Password must include at least 3 of: lowercase, uppercase, number, symbol (min 8 chars).');
      return;
    }
    if (password !== confirm) {
      setPasswordError('');
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    setPasswordError('');
    clearStatus();
    try {
      // Other sessions are revoked; this call returns the caller a fresh one.
      const res = await api<{ access_token: string; user: AuthUser }>('/profiles/password', {
        method: 'PUT',
        body: needsCurrent ? { current_password: current, new_password: password } : { new_password: password },
      });
      setAuth({ access_token: res.access_token, user: res.user });
      const dest =
        user?.role === 'quality_officer' ? '/qa' : user?.role === 'platform_admin' ? '/admin' : user?.role === 'learner' ? '/dashboard' : '/teach';
      router.push(dest);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Current password is required.') setServerWantsCurrent(true);
      setError(message);
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
        {needsCurrent && (
          <Field label="Current password">
            {(ids) => (
              <input
                {...ids}
                type="password"
                required
                autoComplete="current-password"
                className="input"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </Field>
        )}
        <div>
          <Field label="New password" error={passwordError}>
            {(ids) => (
              <input
                {...ids}
                type="password"
                minLength={8}
                required
                autoComplete="new-password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <PasswordStrength value={password} />
        </div>
        <Field label="Confirm new password">
          {(ids) => (
            <input
              {...ids}
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        <FormStatus status={status} />
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
