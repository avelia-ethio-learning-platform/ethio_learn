'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, LoaderCircle, MailWarning } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AuthShell } from '@/components/PageChrome';

function VerifyEmail() {
  const params = useSearchParams();
  const { t } = useT();
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
    <AuthShell
      icon={
        state === 'working' ? (
          <LoaderCircle className="h-6 w-6 animate-spin" />
        ) : state === 'ok' ? (
          <CheckCircle2 className="h-6 w-6" />
        ) : (
          <MailWarning className="h-6 w-6" />
        )
      }
      title={state === 'working' ? 'Verifying…' : state === 'ok' ? 'Email verified' : 'Verification failed'}
    >
      <div className="text-center">
        <p className="text-sm leading-relaxed text-gray-500">{message}</p>
        {state === 'ok' && (
          <Link href="/login" className="btn mt-5 inline-flex !px-8">
            {t('login')}
          </Link>
        )}
      </div>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
