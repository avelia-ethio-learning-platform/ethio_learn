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

const ROLE_LABEL: Record<string, string> = {
  learner: 'Learner',
  educator: 'Educator',
  institution_admin: 'Institution admin',
  quality_officer: 'Quality officer',
  platform_admin: 'Platform admin',
};

function AccountPage() {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useQuery({ queryKey: ['profile'], queryFn: () => api<any>('/profiles/me') });
  const [message, setMessage] = useState('');

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
  if (!me) return null;

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage('');
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
      setMessage('Profile saved.');
    } catch (err) {
      setMessage((err as Error).message);
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
                <span className="badge-info">{ROLE_LABEL[me.role] ?? me.role}</span>
                member since {new Date(me.created_at).toLocaleDateString()}
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
          <div>
            <label className="label">Email (cannot be changed)</label>
            <input className="input opacity-60" value={me.email} disabled />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Full name</label>
              <input name="name" required minLength={2} className="input" defaultValue={me.name} />
            </div>
            <div>
              <label className="label">Phone (optional)</label>
              <input name="phone" className="input" defaultValue={me.phone ?? ''} placeholder="09…" />
            </div>
          </div>
          {me.role === 'educator' && (
            <>
              <div>
                <label className="label">Expertise area</label>
                <input name="expertise" className="input" defaultValue={me.educator_profile?.expertise_area ?? ''} />
              </div>
              <div>
                <label className="label">Bio</label>
                <textarea name="bio" rows={3} className="input" defaultValue={me.educator_profile?.bio ?? ''} />
              </div>
            </>
          )}
          {message && <p className="text-sm font-medium text-brand-600">{message}</p>}
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!confirm('Delete your account permanently? This cannot be undone.')) return;
    setBusy(true);
    setError('');
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
      <h2 className="flex items-center gap-2 font-bold text-red-500">
        <ShieldAlert className="h-4 w-4" /> Danger zone
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-gray-500">
        Deleting your account removes your personal data (name, email, phone) permanently and logs you out.
        {(role === 'educator' || role === 'institution_admin') && ' Published courses must be unpublished or archived first.'}
      </p>
      {!open ? (
        <button
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-400/40 px-4 py-2 text-sm font-semibold text-red-500 transition-colors hover:bg-red-500/10"
          onClick={() => setOpen(true)}
        >
          Delete my account…
        </button>
      ) : (
        <div className="mt-4 space-y-2">
          <label className="label">Confirm with your password</label>
          <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          {error && <p className="text-sm font-medium text-red-500">{error}</p>}
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
