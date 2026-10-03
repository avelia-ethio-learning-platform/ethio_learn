'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, KeyRound, Save, ShieldAlert, UserRound } from 'lucide-react';
import { api, setAuth } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';
import { PanelError } from '@/components/PanelError';
import { formatDate } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { roleLabel } from '@/lib/labels';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

function AccountPage() {
  const { locale } = useT();
  const queryClient = useQueryClient();
  const { data: me, isLoading, isError, refetch } = useQuery({ queryKey: ['profile'], queryFn: () => api<any>('/profiles/me') });
  const [status, setOk, setError, clearStatus] = useFormStatus();

  if (isLoading) {
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="skeleton h-9 w-56" />
          <div className="skeleton h-64 w-full" />
        </div>
      </PageShell>
    );
  }
  // Not `isError`: a failed background refetch keeps `me`, and the form (with what was typed) must stay.
  if (!me) {
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl">
          <h1 className="sr-only">Account settings</h1>
          <div className="card !rounded-3xl">
            <PanelError panel="your account" onRetry={refetch} />
          </div>
        </div>
      </PageShell>
    );
  }

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearStatus();
    const form = new FormData(e.currentTarget);
    try {
      await api('/profiles/me', {
        method: 'PUT',
        body: {
          name: form.get('name'),
          phone: form.get('phone') || undefined,
          ...(me.role === 'educator'
            ? { bio: form.get('bio') ?? undefined, expertise_area: form.get('expertise') ?? undefined }
            : {}),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      setOk('Profile saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-6">
        <BackButton fallback="/" label="Back" />
        <div className="animate-fade-in-up">
          <div className="flex items-center gap-4">
            <span className="gradient-bg-blue flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-extrabold text-white shadow-floating">
              {me.name?.charAt(0)?.toUpperCase() ?? <UserRound className="h-6 w-6" />}
            </span>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">Account settings</h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
                <span className="badge-info">{roleLabel(me.role)}</span>
                member since {formatDate(me.created_at, locale)}
                {me.email_verified ? (
                  <span className="badge-success">
                    <BadgeCheck className="h-3 w-3" /> verified
                  </span>
                ) : (
                  <span className="badge-warn">email not verified</span>
                )}
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={save} className="card animate-fade-in-up space-y-4 !rounded-3xl">
          <h2 className="font-bold text-foreground">Profile</h2>
          <Field label="Email (cannot be changed)">
            {(ids) => <input {...ids} className="input opacity-60" value={me.email} disabled />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name">
              {(ids) => <input {...ids} name="name" required minLength={2} className="input" defaultValue={me.name} />}
            </Field>
            <Field label="Phone (optional)">
              {(ids) => <input {...ids} name="phone" className="input" defaultValue={me.phone ?? ''} placeholder="09…" />}
            </Field>
          </div>
          {me.role === 'educator' && (
            <>
              <Field label="Expertise area">
                {(ids) => <input {...ids} name="expertise" className="input" defaultValue={me.educator_profile?.expertise_area ?? ''} />}
              </Field>
              <Field label="Bio">
                {(ids) => <textarea {...ids} name="bio" rows={3} className="input" defaultValue={me.educator_profile?.bio ?? ''} />}
              </Field>
            </>
          )}
          <FormStatus status={status} />
          <button className="btn">
            <Save className="h-4 w-4" /> Save changes
          </button>
        </form>

        <div className="card animate-fade-in-up !rounded-3xl">
          <h2 className="flex items-center gap-2 font-bold text-foreground">
            <KeyRound className="h-4 w-4 text-brand-500" /> Security
          </h2>
          <p className="mt-1 text-sm text-gray-500">Change the password you use to log in.</p>
          <Link href="/account/password" className="btn-secondary mt-4 inline-flex">
            Change password
          </Link>
        </div>

        <DangerZone role={me.role} />
      </div>
    </PageShell>
  );
}

function DangerZone({ role }: { role: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [status, , setError, clearStatus] = useFormStatus();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!confirm('Delete your account permanently? This cannot be undone.')) return;
    setBusy(true);
    clearStatus();
    try {
      await api('/profiles/me', { method: 'DELETE', body: { password } });
      setAuth(null);
      router.push('/?deleted=1');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="card animate-fade-in-up !rounded-3xl !border-red-400/30">
      <h2 className="flex items-center gap-2 font-bold text-red-600 dark:text-red-400">
        <ShieldAlert className="h-4 w-4" /> Danger zone
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-gray-500">
        Deleting your account removes your personal data (name, email, phone) permanently and logs you out.
        {(role === 'educator' || role === 'institution_admin') && ' Published courses must be unpublished or archived first.'}
      </p>
      <FormStatus status={status} />
      {!open ? (
        <button
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-400/40 px-4 py-2 text-sm font-semibold text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/10"
          onClick={() => setOpen(true)}
        >
          Delete my account…
        </button>
      ) : (
        <div className="mt-4 space-y-2">
          <Field label="Confirm with your password">
            {(ids) => <input {...ids} type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
          </Field>
          <div className="flex gap-2 pt-1">
            <button
              className="inline-flex items-center justify-center rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow transition-all hover:bg-red-700 disabled:opacity-50"
              disabled={busy || !password}
              onClick={remove}
            >
              {busy ? 'Deleting…' : 'Permanently delete account'}
            </button>
            <button className="btn-secondary text-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Account() {
  return (
    <RequireRole roles={['learner', 'educator', 'institution_admin', 'quality_officer', 'platform_admin']}>
      <AccountPage />
    </RequireRole>
  );
}
