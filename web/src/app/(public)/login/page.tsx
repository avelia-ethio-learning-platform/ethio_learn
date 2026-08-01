'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, LogIn } from 'lucide-react';
import { api, setAuth } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AuthShell } from '@/components/PageChrome';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useT();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      const res = await api<{ access_token: string; user: any }>('/auth/login', {
        method: 'POST',
        auth: false,
        body: { email: form.get('email'), password: form.get('password') },
      });
      setAuth({ access_token: res.access_token, user: res.user });
      const next = params.get('next');
      if (res.user.must_change_password) router.push('/account/password?first=1');
      else if (next) router.push(next);
      else if (res.user.role === 'learner') router.push('/dashboard');
      else if (res.user.role === 'quality_officer') router.push('/qa');
      else if (res.user.role === 'platform_admin') router.push('/admin');
      else router.push('/teach');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell
      icon={<LogIn className="h-6 w-6" />}
      title={t('login')}
      subtitle="Welcome back — pick up right where you left off."
      footer={
        <>
          <Link href="/reset-password" className="font-medium text-brand-600 hover:underline">
            {t('forgot_password')}
          </Link>
          <span className="mx-2 text-gray-400">·</span>
          <Link href="/signup" className="font-medium text-brand-600 hover:underline">
            {t('create_account')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">{t('email')}</label>
          <input name="email" type="email" required autoComplete="email" className="input" placeholder="you@example.com" />
        </div>
        <div>
          <label className="label">{t('password')}</label>
          <input name="password" type="password" required autoComplete="current-password" className="input" placeholder="••••••••" />
        </div>
        {error && (
          <p className="badge-danger flex w-full items-start gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm !font-medium">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}
        <button className="btn w-full !py-3" disabled={busy}>
          {busy ? 'Logging in…' : t('login')}
        </button>
        <GoogleSignInButton next={params.get('next')} />
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
