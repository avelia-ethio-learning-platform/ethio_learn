'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setAuth } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';

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

  if (isLoading) return <div className="card mx-auto max-w-2xl animate-pulse text-sm text-gray-400">Loading your account…</div>;
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
    <div className="mx-auto max-w-2xl space-y-6">
      <BackButton fallback="/" label="Back" />
      <div>
        <h1 className="text-2xl font-bold">Account settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          {ROLE_LABEL[me.role] ?? me.role} · member since {new Date(me.created_at).toLocaleDateString()}
          {me.email_verified ? ' · email verified ✓' : ' · email not verified'}
        </p>
      </div>

      <form onSubmit={save} className="card space-y-4">
        <h2 className="font-semibold">Profile</h2>
        <div>
          <label className="label">Email (cannot be changed)</label>
          <input className="input bg-gray-50 text-gray-500" value={me.email} disabled />
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
        {message && <p className="text-sm text-brand-700">{message}</p>}
        <button className="btn">Save changes</button>
      </form>

      <div className="card">
        <h2 className="font-semibold">Security</h2>
        <p className="mt-1 text-sm text-gray-600">Change the password you use to log in.</p>
        <Link href="/account/password" className="btn-secondary mt-3 inline-flex">Change password</Link>
      </div>

      <DangerZone role={me.role} />
    </div>
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
    <div className="card border-red-200">
      <h2 className="font-semibold text-red-700">Danger zone</h2>
      <p className="mt-1 text-sm text-gray-600">
        Deleting your account removes your personal data (name, email, phone) permanently and logs you out.
        {(role === 'educator' || role === 'institution_admin') && ' Published courses must be unpublished or archived first.'}
      </p>
      {!open ? (
        <button className="mt-3 rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50" onClick={() => setOpen(true)}>
          Delete my account…
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="label">Confirm with your password</label>
          <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50" disabled={busy || !password} onClick={remove}>
              {busy ? 'Deleting…' : 'Permanently delete account'}
            </button>
            <button className="btn-secondary text-sm" onClick={() => setOpen(false)}>Cancel</button>
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
