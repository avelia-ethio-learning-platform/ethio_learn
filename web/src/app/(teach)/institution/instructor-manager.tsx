'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRound, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/PageChrome';

export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed' | 'declined';

export interface Membership {
  membership_id: string;
  status: MembershipStatus;
  status_reason: string | null;
  email: string | null;
  /** Only once the person has accepted. */
  user?: { id: string; name: string; role: string };
}

const linkButton = 'text-xs font-medium hover:underline';

/**
 * The institution's members. An institution admin invites and can suspend or
 * remove a membership; that never touches the person's account, which only
 * platform admins can suspend or ban.
 */
export function InstructorManager({ institutionId }: { institutionId: string }) {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState('');
  const { data: members } = useQuery({
    queryKey: ['instructors', institutionId],
    queryFn: () => api<Membership[]>(`/institutions/${institutionId}/instructors`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['instructors', institutionId] });

  const setStatus = async (m: Membership, status: 'active' | 'suspended' | 'removed') => {
    let reason: string | undefined;
    if (status === 'suspended') {
      const answer = prompt('Reason for suspending (optional):');
      if (answer === null) return; // Cancel means cancel
      reason = answer.trim() || undefined;
    }
    if (status === 'removed' && m.status !== 'invited' && !confirm(`Remove ${m.user?.name ?? m.email} from your institution?`)) return;
    try {
      await api(`/institutions/${institutionId}/instructors/${m.membership_id}/status`, { method: 'POST', body: { status, reason } });
      refresh();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const invite = async (email: string, name?: string) => {
    await api(`/institutions/${institutionId}/instructors`, { method: 'POST', body: { email, name: name || undefined } });
    setMsg('Invitation sent. They need to accept it.');
    refresh();
  };

  return (
    <section className="card animate-fade-in-up !rounded-3xl">
      <h2 className="flex items-center gap-2 font-bold text-foreground">
        <span className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl">
          <Users className="h-4 w-4 text-brand-600" />
        </span>
        Instructors
      </h2>
      <div className="mt-3 text-sm">
        {!members?.length && <p className="py-2 text-gray-500">No instructors yet — invite your first below.</p>}
        {members?.map((m, idx) => (
          <div
            key={m.membership_id}
            data-testid={`member-${m.membership_id}`}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5"
            style={idx > 0 ? { borderTop: '1px solid var(--border)' } : undefined}
          >
            <span className="flex min-w-0 items-center gap-2 text-foreground">
              <UserRound className="h-4 w-4 shrink-0 text-brand-400" />
              <span className="truncate">
                {m.user ? (
                  <>
                    {m.user.name} <span className="text-gray-500">({m.email})</span>
                  </>
                ) : (
                  m.email
                )}
                {m.status === 'suspended' && m.status_reason && <span className="ml-1 text-xs text-gray-500">· {m.status_reason}</span>}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <StatusBadge status={m.status} />
              {m.status === 'invited' && (
                <button className={`${linkButton} text-gray-600`} onClick={() => setStatus(m, 'removed')}>
                  Cancel invite
                </button>
              )}
              {m.status === 'active' && (
                <button className={`${linkButton} text-amber-700 dark:text-amber-400`} onClick={() => setStatus(m, 'suspended')}>
                  Suspend
                </button>
              )}
              {m.status === 'suspended' && (
                <button className={`${linkButton} text-emerald-700 dark:text-emerald-400`} onClick={() => setStatus(m, 'active')}>
                  Reactivate
                </button>
              )}
              {(m.status === 'active' || m.status === 'suspended') && (
                <button className={`${linkButton} text-red-600 dark:text-red-400`} onClick={() => setStatus(m, 'removed')}>
                  Remove
                </button>
              )}
              {(m.status === 'declined' || m.status === 'removed') && m.email && (
                <button
                  className={`${linkButton} text-brand-600`}
                  onClick={() => invite(m.email!).catch((err: Error) => alert(err.message))}
                >
                  Re-invite
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      <form
        className="mt-4 flex flex-wrap gap-2 pt-4"
        style={{ borderTop: '1px solid var(--border)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          const formEl = e.currentTarget;
          const form = new FormData(formEl);
          try {
            await invite(String(form.get('email')), String(form.get('name') ?? '').trim());
            formEl.reset();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <input name="email" type="email" required placeholder="Instructor email" aria-label="Instructor email" className="input flex-1" />
        <input name="name" placeholder="Name (if they're new here)" aria-label="Instructor name" className="input flex-1" />
        <button className="btn-secondary">Invite instructor</button>
        {msg && (
          <p role="status" className="w-full text-xs font-medium text-brand-600">
            {msg}
          </p>
        )}
      </form>
    </section>
  );
}
