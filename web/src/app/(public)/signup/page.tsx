'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, MailCheck, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';
import { AuthShell } from '@/components/PageChrome';

function SignupForm() {
  const params = useSearchParams();
  const { t } = useT();
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (scorePassword(password).score < 3) {
      setError('Password must include at least 3 of: lowercase, uppercase, number, symbol (min 8 chars).');
      return;
    }
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      await api('/auth/signup', {
        method: 'POST',
        auth: false,
        body: { name: form.get('name'), email: form.get('email'), password: form.get('password'), role: form.get('role') },
      });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (done) {
    return (
      <AuthShell icon={<MailCheck className="h-6 w-6" />} title="Check your email" subtitle="One more step to activate your account.">
        <div className="text-center">
          <p className="text-sm leading-relaxed text-gray-500">
            We sent a verification link to your inbox. Click it, then{' '}
            <Link className="font-semibold text-brand-600 hover:underline" href="/login">
              {t('login')}
            </Link>
            .
          </p>
          <p className="mt-3 text-xs text-gray-400">Local dev without an email key? The link is printed in the notification service logs.</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      icon={<UserPlus className="h-6 w-6" />}
      title={t('create_account')}
      subtitle="Join Ethiopia's educator-first learning community."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            {t('login')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">{t('full_name')}</label>
          <input name="name" required minLength={2} className="input" placeholder="Abebe Bikila" />
        </div>
        <div>
          <label className="label">{t('email')}</label>
          <input name="email" type="email" required autoComplete="email" className="input" placeholder="you@example.com" />
        </div>
        <div>
          <label className="label">{t('password')} (8+ characters)</label>
          <input
            name="password"
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
        <div>
          <label className="label">I am joining as</label>
          <select name="role" defaultValue={params.get('role') ?? 'learner'} className="input">
            <option value="learner">Learner — I want to take courses</option>
            <option value="educator">Educator — I want to teach</option>
            <option value="institution_admin">Institution — training center / bootcamp</option>
          </select>
        </div>
        <p className="text-xs text-gray-400">No phone number required — just email and password.</p>
        {error && (
          <p className="badge-danger flex w-full items-start gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm !font-medium">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}
        <button className="btn w-full !py-3" disabled={busy}>
          {busy ? 'Creating…' : t('signup')}
        </button>
        <GoogleSignInButton next={params.get('next')} />
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
