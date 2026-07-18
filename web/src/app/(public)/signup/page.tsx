'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';

function SignupForm() {
  const params = useSearchParams();
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
      <div className="card mx-auto max-w-md text-center">
        <p className="text-3xl">📬</p>
        <h1 className="mt-2 text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-gray-600">
          We sent a verification link to your inbox. Click it, then <Link className="text-brand-700 underline" href="/login">log in</Link>.
        </p>
        <p className="mt-2 text-xs text-gray-400">Local dev without an email key? The link is printed in the notification service logs.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">Create your account</h1>
      <form onSubmit={submit} className="card mt-4 space-y-4">
        <div>
          <label className="label">Full name</label>
          <input name="name" required minLength={2} className="input" />
        </div>
        <div>
          <label className="label">Email</label>
          <input name="email" type="email" required className="input" />
        </div>
        <div>
          <label className="label">Password (8+ characters)</label>
          <input name="password" type="password" minLength={8} required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
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
        <p className="text-xs text-gray-500">No phone number required — just email and password.</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Creating…' : 'Sign up'}
        </button>
      </form>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
