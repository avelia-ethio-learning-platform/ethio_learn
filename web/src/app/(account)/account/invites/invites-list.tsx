'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, MailOpen } from 'lucide-react';
import { api, ApiError, refreshSession } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';
import { useConfirm } from '@/components/confirm/ConfirmProvider';

export interface InstitutionInvite {
  id: string;
  institution: { id: string; name: string };
  invited_at: string;
}

export interface InstitutionMembership {
  id: string;
  institution: { id: string; name: string };
  status: 'active' | 'suspended';
  joined_at: string;
}

export const INVITES_QUERY_KEY = ['institution-invites'];
export const MEMBERSHIPS_QUERY_KEY = ['institution-memberships'];

/**
 * Pending institution invitations, then the institution the user teaches with (and Leave). Joining is always the user's own choice,
 * made here with the institution named; nothing changes on the account before.
 */
export function InvitesList() {
  const { locale } = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const ask = useConfirm();
  const [leaveStatus, setLeaveOk, setLeaveError, clearLeaveStatus] = useFormStatus();
  const { data: invites, isLoading } = useQuery({
    queryKey: INVITES_QUERY_KEY,
    queryFn: () => api<InstitutionInvite[]>('/profiles/me/institution-invites'),
  });

  // A 404 means the web is deployed before the API: the section just hides.
  const { data: memberships } = useQuery({
    queryKey: MEMBERSHIPS_QUERY_KEY,
    queryFn: async () => {
      try {
        return await api<InstitutionMembership[]>('/profiles/me/institution-memberships');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
  });

  const leave = async (m: InstitutionMembership) => {
    const name = m.institution.name;
    const answer = await ask({
      title: `Leave ${name}?`,
      body: "New courses you create won't go through their review. Courses you already made for them stay with them.",
      confirmLabel: 'Leave institution',
      tone: 'danger',
    });
    if (!answer) return;
    setBusy(m.id);
    clearLeaveStatus();
    try {
      await api(`/profiles/me/institution-memberships/${m.id}/leave`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: MEMBERSHIPS_QUERY_KEY });
      setLeaveOk(`You left ${name}.`);
    } catch (err) {
      setLeaveError((err as Error).message);
    }
    setBusy(null);
  };

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
  const hasInvites = !!invites?.length;
  const hasMemberships = !!memberships?.length;
  return (
    <div className="space-y-6">
      {!hasInvites && !hasMemberships && (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <MailOpen className="h-8 w-8 text-gray-500" />
          <p className="text-sm text-gray-500">No pending invitations.</p>
          <Link href="/dashboard" className="text-sm font-semibold text-brand-600 hover:underline">
            Back to my learning
          </Link>
        </div>
      )}
      {hasInvites && (
        <div className="space-y-4">
          {error && (
            <p role="alert" className="badge-danger !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm">
              {error}
            </p>
          )}
          {invites?.map((invite) => (
            <section key={invite.id} className="card flex flex-wrap items-center justify-between gap-4 !rounded-3xl" aria-label={invite.institution.name}>
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 font-bold text-foreground">
                  <Building2 className="h-4 w-4 shrink-0 text-brand-500" /> {invite.institution.name}
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  Invited you to teach with them on {formatDate(invite.invited_at, locale)}. If you accept, you become their instructor:
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
      )}
      {(hasMemberships || leaveStatus) && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-foreground">Your institution</h2>
          <FormStatus status={leaveStatus} />
          {memberships?.map((m) => (
            <section key={m.id} className="card flex flex-wrap items-center justify-between gap-4 !rounded-3xl" aria-label={`${m.institution.name} membership`}>
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 font-bold text-foreground">
                  <Building2 className="h-4 w-4 shrink-0 text-brand-500" /> {m.institution.name}
                  {m.status === 'suspended' && <span className="badge-warn">Suspended</span>}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  You have taught with them since {formatDate(m.joined_at, locale)}. New courses you create go through their review.
                </p>
              </div>
              <button className="btn-secondary shrink-0" disabled={busy !== null} onClick={() => leave(m)}>
                {busy === m.id ? 'Working…' : 'Leave'}
              </button>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
