'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Eye, GitCompareArrows, PartyPopper, Undo2, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';
import { CHIP_CLASS, diffChips, type RevisionDiffSummary } from '@/lib/qa';

const QUEUE_KEY = ['institution-review'];

/** GET /institution/review-queue row: a new course, or a staged update to one of the institution's live courses. */
interface InstitutionQueueRow {
  id: string;
  title: string;
  description: string;
  category: string;
  pricing_type: string;
  instructor_name?: string;
  instructor_email?: string;
  kind?: 'new_course' | 'revision';
  revision_id?: string | null;
  changelog_summary?: string | null;
  major?: boolean;
  submitted_at?: string | null;
  diff_summary?: Partial<RevisionDiffSummary> | null;
}

function ReviewQueue() {
  const { data: queue, isLoading, isError, refetch } = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => api<InstitutionQueueRow[]>('/institution/review-queue'),
  });
  const [msg, setMsg] = useState('');

  return (
    <PageShell>
      <div className="space-y-6">
        <BackButton fallback="/institution" label="Institution" />
        <div className="animate-fade-in-up">
          <span className="section-badge">
            <ClipboardList className="h-4 w-4 text-brand-500" /> Internal review
          </span>
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">Internal review queue</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-500">
            Review your instructors&apos; new courses and their updates to live courses. Approving forwards them to the platform quality officers for final
            review; live courses stay unchanged until then.
          </p>
        </div>
        <p aria-live="polite" className={msg ? 'badge-info w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm' : 'sr-only'}>
          {msg}
        </p>
        {isLoading ? (
          <div className="space-y-4">
            <div className="skeleton h-40 w-full" />
            <div className="skeleton h-40 w-full" />
          </div>
        ) : isError ? (
          <div className="card flex flex-col items-center gap-3 py-10 text-center text-sm text-red-500">
            Could not load the review queue.
            <button className="btn-secondary" onClick={() => refetch()}>
              Try again
            </button>
          </div>
        ) : !queue?.length ? (
          <div className="card flex animate-fade-in-up items-center justify-center gap-2 py-10 text-sm text-gray-500">
            <PartyPopper className="h-5 w-5 text-brand-500" /> Nothing awaiting your review.
          </div>
        ) : (
          queue.map((row) => <ReviewRow key={row.revision_id ?? row.id} row={row} onDecided={setMsg} />)
        )}
      </div>
    </PageShell>
  );
}

function ReviewRow({ row, onDecided }: { row: InstitutionQueueRow; onDecided: (message: string) => void }) {
  const queryClient = useQueryClient();
  const uid = useId();
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isRevision = row.kind === 'revision' && !!row.revision_id;
  const chips = isRevision ? diffChips(row.diff_summary) : [];

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true);
    setError('');
    try {
      // One endpoint for both: the server decides the course itself when it is in
      // institution review, otherwise its open update.
      await api(`/institution/courses/${row.id}/decision`, { method: 'POST', body: { action, notes: notes.trim() || undefined } });
      onDecided(
        action === 'approve'
          ? `${row.title}: ${isRevision ? 'update' : 'course'} approved and forwarded to platform quality review.`
          : `${row.title}: ${isRevision ? 'update' : 'course'} sent back to the instructor.`,
      );
      queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card animate-fade-in-up !rounded-3xl" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={isRevision ? 'badge-info' : 'badge-neutral'}>{isRevision ? 'Update to a live course' : 'New course'}</span>
          {isRevision && row.major && <span className="badge-warn">Major update</span>}
        </div>
        <span className="badge-neutral">
          {row.category} · {row.pricing_type}
        </span>
      </div>
      <h2 id={`${uid}-title`} className="mt-3 break-words font-bold text-foreground">
        {row.title}
      </h2>
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
        <UserRound className="h-3.5 w-3.5 text-brand-400" />
        Created by <span className="font-semibold text-foreground">{row.instructor_name || 'Unknown instructor'}</span>
        {row.instructor_email && <span className="break-all text-gray-400">({row.instructor_email})</span>}
        {isRevision && row.submitted_at && <span>· submitted {new Date(row.submitted_at).toLocaleDateString()}</span>}
      </p>

      {isRevision ? (
        <div className="mt-3 space-y-2">
          {chips.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="What changed">
              {chips.map((c) => (
                <li key={c.text} className={CHIP_CLASS[c.tone]}>
                  {c.text}
                </li>
              ))}
            </ul>
          )}
          {row.changelog_summary && (
            <p className="whitespace-pre-line break-words rounded-xl bg-brand-500/5 px-3 py-2 text-sm text-gray-600">
              <span className="block text-xs font-semibold text-gray-500">Instructor&apos;s summary</span>
              {row.changelog_summary}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 line-clamp-2 break-words text-sm leading-relaxed text-gray-600">{row.description}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {isRevision && (
          <Link
            href={`/preview/${row.id}?revision=${row.revision_id}`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
          >
            <GitCompareArrows className="h-4 w-4" /> Review changes
          </Link>
        )}
        <Link href={`/preview/${row.id}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline">
          <Eye className="h-4 w-4" /> {isRevision ? 'View live course' : 'Preview content'}
        </Link>
      </div>

      <label htmlFor={`${uid}-notes`} className="label mt-4">
        Notes for the instructor <span className="font-normal text-gray-500">(shown when you send it back)</span>
      </label>
      <textarea id={`${uid}-notes`} className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn" disabled={busy} onClick={() => decide('approve')}>
          <CheckCircle2 className="h-4 w-4" /> Approve → send to platform
        </button>
        <button className="btn-secondary" disabled={busy} onClick={() => decide('reject')}>
          <Undo2 className="h-4 w-4" /> Send back to instructor
        </button>
      </div>
      {isRevision && (
        <p className="mt-2 text-xs text-gray-500">Sending an update back keeps the instructor&apos;s edits so they can fix and resubmit them.</p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-500">
          {error}
        </p>
      )}
    </article>
  );
}

export default function InstitutionReviewPage() {
  return (
    <RequireRole roles={['institution_admin']}>
      <ReviewQueue />
    </RequireRole>
  );
}
