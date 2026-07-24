'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, setAuth } from '@/lib/api';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
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
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">Log in</h1>
      <form onSubmit={submit} className="card mt-4 space-y-4">
        <div>
          <label className="label">Email</label>
          <input name="email" type="email" required className="input" />
        </div>
        <div>
          <label className="label">Password</label>
          <input name="password" type="password" required className="input" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <GoogleSignInButton next={params.get('next')} />
        <p className="text-center text-sm text-gray-500">
          <Link href="/reset-password" className="text-brand-700 underline">Forgot password?</Link>
          {' · '}
          <Link href="/signup" className="text-brand-700 underline">Create account</Link>
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
