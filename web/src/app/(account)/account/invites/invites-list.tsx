'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, MailOpen } from 'lucide-react';
import { api, refreshSession } from '@/lib/api';

export interface InstitutionInvite {
  id: string;
  institution: { id: string; name: string };
  invited_at: string;
}

export const INVITES_QUERY_KEY = ['institution-invites'];

/**
 * Pending institution invitations. Joining is always the user's own choice,
 * made here with the institution named; nothing changes on the account before.
 */
export function InvitesList() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const { data: invites, isLoading } = useQuery({
    queryKey: INVITES_QUERY_KEY,
    queryFn: () => api<InstitutionInvite[]>('/profiles/me/institution-invites'),
  });

  const respond = async (invite: InstitutionInvite, action: 'accept' | 'decline') => {
    setBusy(invite.id);
    setError('');
    try {
      await api(`/profiles/me/institution-invites/${invite.id}/${action}`, { method: 'POST' });
      if (action === 'accept') {
        await refreshSession(); // picks up the educator role
        router.push('/teach');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  };

  if (isLoading) return <div className="skeleton h-28 w-full" />;
  if (!invites?.length) {
    return (
      <div className="card flex flex-col items-center gap-3 py-12 text-center">
        <MailOpen className="h-8 w-8 text-gray-400" />
        <p className="text-sm text-gray-500">No pending invitations.</p>
        <Link href="/dashboard" className="text-sm font-semibold text-brand-600 hover:underline">
          Back to my learning
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="badge-danger !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm">
          {error}
        </p>
      )}
      {invites.map((invite) => (
        <section key={invite.id} className="card flex flex-wrap items-center justify-between gap-4 !rounded-3xl" aria-label={invite.institution.name}>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-bold text-foreground">
              <Building2 className="h-4 w-4 shrink-0 text-brand-500" /> {invite.institution.name}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Invited you to teach with them on {new Date(invite.invited_at).toLocaleDateString()}. If you accept, you become their instructor:
              new courses you create go through their review. Your enrollments and existing courses are unchanged.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button className="btn-secondary" disabled={busy !== null} onClick={() => respond(invite, 'decline')}>
              Decline
            </button>
            <button className="btn" disabled={busy !== null} onClick={() => respond(invite, 'accept')}>
              {busy === invite.id ? 'Working…' : 'Accept'}
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
