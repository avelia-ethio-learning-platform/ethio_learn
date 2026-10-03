'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, LoaderCircle, MailWarning } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AuthShell } from '@/components/PageChrome';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

function VerifyEmail() {
  const params = useSearchParams();
  const { t } = useT();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [status, setOk, setError] = useFormStatus();

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setState('error');
      setError('Missing verification token.');
      return;
    }
    api(`/auth/verify-email?token=${encodeURIComponent(token)}`, { method: 'POST', auth: false })
      .then((res: any) => {
        setState('ok');
        setOk(res.message);
      })
      .catch((err: Error) => {
        setState('error');
        setError(err.message);
      });
  }, [params, setOk, setError]);

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
        <FormStatus status={status} />
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
