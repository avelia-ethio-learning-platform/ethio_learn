'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { MailCheck, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { PasswordStrength, scorePassword } from '@/components/PasswordStrength';
import { AuthShell } from '@/components/PageChrome';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { ResendVerification } from '@/components/ResendVerification';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';

function SignupForm() {
  const params = useSearchParams();
  // Referral / gift context survives the email-verification round trip via
  // localStorage; the dashboard claims it on first login.
  if (typeof window !== 'undefined') {
    const ref = params.get('ref');
    const gift = params.get('gift');
    try {
      if (ref) localStorage.setItem('el_ref', ref.toUpperCase());
      if (gift) localStorage.setItem('el_gift', gift);
    } catch {
      /* private mode */
    }
  }
  const { t } = useT();
  const [status, , setError, clearStatus] = useFormStatus();
  const [passwordError, setPasswordError] = useState('');
  const [doneEmail, setDoneEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!scorePassword(password).ok) {
      // The field error replaces any earlier server error, which no longer applies.
      clearStatus();
      setPasswordError(t('password_rule'));
      return;
    }
    setBusy(true);
    setPasswordError('');
    clearStatus();
    const form = new FormData(e.currentTarget);
    try {
      await api('/auth/signup', {
        method: 'POST',
        auth: false,
        body: { name: form.get('name'), email: form.get('email'), password: form.get('password'), role: form.get('role') },
      });
      setDoneEmail(String(form.get('email')));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (doneEmail !== null) {
    return (
      <AuthShell icon={<MailCheck className="h-6 w-6" />} title={t('check_email_title')} subtitle={t('check_email_subtitle')}>
        <div className="text-center">
          <p className="text-sm leading-relaxed text-gray-500">
            {t('check_email_body')}{' '}
            <Link className="font-semibold text-brand-600 hover:underline" href="/login">
              {t('login')}
            </Link>
            .
          </p>
          <div className="mt-5">
            <ResendVerification email={doneEmail} startCooledDown />
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      icon={<UserPlus className="h-6 w-6" />}
      title={t('create_account')}
      subtitle={t('signup_subtitle')}
      footer={
        <>
          {t('have_account')}{' '}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            {t('login')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('full_name')}>
          {(ids) => <input {...ids} name="name" required minLength={2} className="input" placeholder="Abebe Bikila" />}
        </Field>
        <Field label={t('email')}>
          {(ids) => <input {...ids} name="email" type="email" required autoComplete="email" className="input" placeholder="you@example.com" />}
        </Field>
        <div>
          <Field label={t('password_min')} error={passwordError}>
            {(ids) => (
              <input
                {...ids}
                name="password"
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
        <Field label={t('joining_as')}>
          {(ids) => (
            <select {...ids} name="role" defaultValue={params.get('role') ?? 'learner'} className="input">
              <option value="learner">{t('role_learner_option')}</option>
              <option value="educator">{t('role_educator_option')}</option>
              <option value="institution_admin">{t('role_institution_option')}</option>
            </select>
          )}
        </Field>
        <p className="text-xs text-gray-500">{t('no_phone')}</p>
        <FormStatus status={status} />
        <button className="btn w-full !py-3" disabled={busy}>
          {busy ? t('creating') : t('signup')}
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
