'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

function VerifyEmail() {
  const params = useSearchParams();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setState('error');
      setMessage('Missing verification token.');
      return;
    }
    api(`/auth/verify-email?token=${encodeURIComponent(token)}`, { method: 'POST', auth: false })
      .then((res: any) => {
        setState('ok');
        setMessage(res.message);
      })
      .catch((err: Error) => {
        setState('error');
        setMessage(err.message);
      });
  }, [params]);

  return (
    <div className="card mx-auto max-w-md text-center">
      <p className="text-3xl">{state === 'working' ? '⏳' : state === 'ok' ? '✅' : '❌'}</p>
      <h1 className="mt-2 text-xl font-semibold">
        {state === 'working' ? 'Verifying…' : state === 'ok' ? 'Email verified' : 'Verification failed'}
      </h1>
      <p className="mt-2 text-sm text-gray-600">{message}</p>
      {state === 'ok' && (
        <Link href="/login" className="btn mt-4 inline-flex">
          Log in
        </Link>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
