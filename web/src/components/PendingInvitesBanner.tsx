'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { MailOpen } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

/** A nudge on the learner and educator dashboards while an institution invitation is pending. */
export function PendingInvitesBanner() {
  const { user } = useAuth();
  const canAccept = user?.role === 'learner' || user?.role === 'educator';
  const { data: invites } = useQuery({
    queryKey: ['institution-invites'],
    queryFn: () => api<Array<{ id: string; institution: { name: string } }>>('/profiles/me/institution-invites'),
    enabled: canAccept,
  });
  if (!canAccept || !invites?.length) return null;
  const label =
    invites.length === 1 ? `${invites[0].institution.name} invited you to teach with them.` : `${invites.length} institutions invited you to teach with them.`;
  return (
    <Link
      href="/account/invites"
      className="card mb-6 flex items-center justify-between gap-3 !rounded-2xl !py-3 text-sm transition-colors hover:bg-brand-500/5"
    >
      <span className="flex items-center gap-2 text-foreground">
        <MailOpen className="h-4 w-4 shrink-0 text-brand-500" /> {label}
      </span>
      <span className="shrink-0 font-semibold text-brand-600">Review →</span>
    </Link>
  );
}
