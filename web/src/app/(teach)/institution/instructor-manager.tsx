'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRound, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/PageChrome';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

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
  const ask = useConfirm();
  const [formStatus, setOk, setError, clear] = useFormStatus();
  const [busy, setBusy] = useState(false);
  const { data: members } = useQuery({
    queryKey: ['instructors', institutionId],
    queryFn: () => api<Membership[]>(`/institutions/${institutionId}/instructors`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['instructors', institutionId] });

  const setStatus = async (m: Membership, status: 'active' | 'suspended' | 'removed') => {
    if (busy) return; // aria-disabled, not disabled: the clicked button keeps the focus the dialog gives back
    const who = m.user?.name ?? m.email;
    let reason: string | undefined;
    if (status === 'suspended') {
      const answer = await ask({
        title: `Suspend ${who}?`,
        body: 'They stop getting new courses routed through your institution until you reactivate them.',
        confirmLabel: 'Suspend',
        tone: 'danger',
        reason: { label: 'Reason (optional)', maxLength: 500 },
      });
      if (!answer) return; // Cancel means cancel
      reason = answer.reason || undefined;
    }
    if (status === 'removed' && m.status !== 'invited') {
      const answer = await ask({
        title: `Remove ${who} from your institution?`,
        body: 'Their courses stay with the institution. You can invite them again later.',
        confirmLabel: 'Remove',
        tone: 'danger',
      });
      if (!answer) return;
    }
    setBusy(true);
    clear();
    try {
      await api(`/institutions/${institutionId}/instructors/${m.membership_id}/status`, { method: 'POST', body: { status, reason } });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const invite = async (email: string, name?: string) => {
    await api(`/institutions/${institutionId}/instructors`, { method: 'POST', body: { email, name: name || undefined } });
    setOk('Invitation sent. They need to accept it.');
    refresh();
  };

  return (
    <section className="card animate-fade-in-up !rounded-3xl">
      <h2 className="flex items-center gap-2 font-bold text-foreground">
        <span className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl">
          <Users className="h-4 w-4 text-brand-600" aria-hidden />
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
              <UserRound className="h-4 w-4 shrink-0 text-brand-400" aria-hidden />
              <span className="truncate">
                {m.user ? (
                  <>
                    {m.user.name} <span className="text-gray-500">({m.email})</span>
                  </>
                ) : (
                  m.email
                )}
                {(m.status === 'suspended' || m.status === 'removed') && m.status_reason && <span className="ml-1 text-xs text-gray-500">· {m.status_reason}</span>}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={m.status} />
              {m.status === 'invited' && (
                <button className={`${linkButton} text-gray-600`} aria-disabled={busy} onClick={() => setStatus(m, 'removed')}>
                  Cancel invite
                </button>
              )}
              {m.status === 'active' && (
                <button className={`${linkButton} text-amber-700 dark:text-amber-400`} aria-disabled={busy} onClick={() => setStatus(m, 'suspended')}>
                  Suspend
                </button>
              )}
              {m.status === 'suspended' && (
                <button className={`${linkButton} text-emerald-700 dark:text-emerald-400`} aria-disabled={busy} onClick={() => setStatus(m, 'active')}>
                  Reactivate
                </button>
              )}
              {(m.status === 'active' || m.status === 'suspended') && (
                <button className={`${linkButton} text-red-600 dark:text-red-400`} aria-disabled={busy} onClick={() => setStatus(m, 'removed')}>
                  Remove
                </button>
              )}
              {(m.status === 'declined' || m.status === 'removed') && m.email && (
                <button
                  className={`${linkButton} text-brand-600`}
                  aria-disabled={busy}
                  onClick={async () => {
                    if (busy) return;
                    setBusy(true);
                    clear();
                    try {
                      await invite(m.email!);
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
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
          setBusy(true);
          clear();
          try {
            await invite(String(form.get('email')), String(form.get('name') ?? '').trim());
            formEl.reset();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <Field label="Instructor email">{(ids) => <input {...ids} name="email" type="email" required className="input" />}</Field>
        </div>
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <Field label="Instructor name" hint="Only needed if they're new here.">
            {(ids) => <input {...ids} name="name" className="input" />}
          </Field>
        </div>
        <button className="btn-secondary w-full sm:w-auto sm:self-start sm:mt-6" disabled={busy}>
          Invite instructor
        </button>
      </form>
      <div className="mt-3">
        <FormStatus status={formStatus} />
      </div>
    </section>
  );
}
