'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Eye,
  Flag,
  GitCompareArrows,
  Hand,
  Lock,
  MessageSquareText,
  PartyPopper,
  ShieldCheck,
  Timer,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { RequireRole } from '@/components/RequireRole';
import { PageHeader, PageShell } from '@/components/PageChrome';
import {
  actionsForKind,
  approveGate,
  CHIP_CLASS,
  claimState,
  decisionNotesError,
  diffChips,
  itemKind,
  KIND_LABEL,
  readVideosRecord,
  slaCountdown,
  videosReviewedKey,
  type QaActionOption,
  type QaItemKind,
  type QaQueueItem,
  type VideosReviewedRecord,
} from '@/lib/qa';

const QUEUE_KEY = ['qa-queue'];

const KIND_CLASS: Record<QaItemKind, string> = {
  new_course: 'badge-neutral',
  revision: 'badge-info',
  appeal: 'badge-warn',
  post_publish: 'badge-warn',
};

const DANGER_BTN =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow transition-all hover:-translate-y-px hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-red-600';

const ACTION_ICON = { approve: CheckCircle2, coach: MessageSquareText, flag: Flag, reject: XCircle } as const;

/** Re-render on an interval so SLA countdowns and claim expiry stay current between polls. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * The preview page records opened videos (and a failed load of the new assessments) in
 * localStorage, so "Review changes" opened in another tab counts too. Re-read it whenever this
 * page becomes visible again, and when another tab writes a record (the `storage` event).
 */
function useVideoRecords(items: QaQueueItem[] | undefined): Record<string, VideosReviewedRecord | null> {
  const [records, setRecords] = useState<Record<string, VideosReviewedRecord | null>>({});
  useEffect(() => {
    const load = () => {
      const next: Record<string, VideosReviewedRecord | null> = {};
      for (const item of items ?? []) {
        if (itemKind(item) === 'revision' && item.revision_id) next[item.revision_id] = readVideosRecord(item.revision_id);
      }
      setRecords(next);
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    // key null: storage was cleared.
    const onStorage = (e: StorageEvent) => (e.key === null || e.key.startsWith(videosReviewedKey(''))) && load();
    window.addEventListener('focus', load);
    window.addEventListener('pageshow', load);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', load);
      window.removeEventListener('pageshow', load);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [items]);
  return records;
}

function QaQueue() {
  const { user } = useAuth();
  const now = useNow(30_000);
  const { data: queue, isLoading, isError, refetch } = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => api<QaQueueItem[]>('/qa/queue'),
    refetchInterval: 30_000,
  });
  const records = useVideoRecords(queue);
  const [message, setMessage] = useState('');

  return (
    <PageShell>
      <PageHeader
        badge={
          <span className="section-badge">
            <ShieldCheck className="h-4 w-4 text-brand-500" /> Quality
          </span>
        }
        title="Quality review queue"
        subtitle="Checklist review: spam · illegal content · policy violations · fraud signals. SLA: 24h for updates to live courses, 48h for everything else."
        actions={queue?.length ? <span className="badge-info">{queue.length} open</span> : undefined}
      />
      <div className="space-y-6">
        <p aria-live="polite" className={message ? 'badge-info w-fit !whitespace-normal !rounded-xl !px-4 !py-2 !text-sm' : 'sr-only'}>
          {message}
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
            <PartyPopper className="h-5 w-5 text-brand-500" /> Queue is empty.
          </div>
        ) : (
          queue.map((item) => (
            <QueueCard
              key={item.id}
              item={item}
              userId={user?.id ?? null}
              now={now}
              record={item.revision_id ? (records[item.revision_id] ?? null) : null}
              onDecided={setMessage}
            />
          ))
        )}
      </div>
    </PageShell>
  );
}

function QueueCard({
  item,
  userId,
  now,
  record,
  onDecided,
}: {
  item: QaQueueItem;
  userId: string | null;
  now: number;
  record: VideosReviewedRecord | null;
  onDecided: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const uid = useId();
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const kind = itemKind(item);
  const isRevision = kind === 'revision';
  const actions = actionsForKind(kind);
  const sla = slaCountdown(item.sla_deadline, now);
  const claim = claimState(item, userId, now);
  const lockedByOther = claim.state === 'other';
  const gate = approveGate(item, record);
  const chips = isRevision ? diffChips(item.diff_summary, item.priority ?? 0) : [];
  const plagiarism = (item.plagiarism ?? {}) as Record<string, unknown>;
  const notesId = `${uid}-notes`;
  const gateId = `${uid}-gate`;

  const refreshQueue = () => queryClient.invalidateQueries({ queryKey: QUEUE_KEY });

  const onClaim = async () => {
    setBusy(true);
    setError('');
    try {
      const updated = await api<QaQueueItem>(`/qa/items/${item.id}/claim`, { method: 'POST' });
      queryClient.setQueryData<QaQueueItem[]>(QUEUE_KEY, (rows) => rows?.map((r) => (r.id === item.id ? { ...r, ...updated } : r)));
    } catch (err) {
      setError((err as Error).message);
      refreshQueue();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (opt: QaActionOption) => {
    const notesError = decisionNotesError(opt.action, notes);
    if (notesError) {
      setError(notesError);
      notesRef.current?.focus();
      return;
    }
    if (opt.confirm && !window.confirm(opt.confirm)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/qa/items/${item.id}/decision`, { method: 'POST', body: { action: opt.action, notes: notes.trim() || undefined } });
      onDecided(`${item.course_title}: ${opt.done}`);
      refreshQueue();
    } catch (err) {
      setError((err as Error).message);
      // Someone else claimed or decided it — show the current state.
      if (err instanceof ApiError && err.status === 409) refreshQueue();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card animate-fade-in-up !rounded-3xl" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={KIND_CLASS[kind]}>{KIND_LABEL[kind]}</span>
          {claim.state === 'mine' && (
            <span className="badge-success">
              <UserCheck className="h-3 w-3" /> You are reviewing · {claim.expiresIn} left
            </span>
          )}
          {claim.state === 'other' && (
            <span className="badge-neutral">
              <Lock className="h-3 w-3" /> Being reviewed by another officer
            </span>
          )}
        </div>
        <span className={sla.tone === 'danger' ? 'badge-danger' : sla.tone === 'warn' ? 'badge-warn' : 'badge-neutral'}>
          <Timer className="h-3 w-3" /> SLA: {sla.text}
        </span>
      </div>

      <h2 id={`${uid}-title`} className="mt-3 break-words font-bold text-foreground">
        {item.course_title}
      </h2>
      <p className="mt-0.5 break-words text-xs text-gray-500">
        by {item.owner_name || item.owner_email || item.owner_id} ({item.owner_type})
        {!isRevision && ` · trigger: ${item.trigger}`}
      </p>

      {isRevision && (
        <div className="mt-3 space-y-2">
          {chips.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="What changed">
              {chips.map((c) => (
                <li key={c.text} className={CHIP_CLASS[c.tone]}>
                  {c.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500">No change counts recorded — open “Review changes” to see the diff.</p>
          )}
          {item.changelog_summary ? (
            <blockquote className="whitespace-pre-line break-words rounded-xl border-l-4 border-brand-400 bg-brand-500/5 px-3 py-2 text-sm text-gray-600">
              <span className="block text-xs font-semibold text-gray-500">Educator&apos;s summary</span>
              {item.changelog_summary}
            </blockquote>
          ) : (
            <p className="text-xs text-gray-500">The educator did not write a summary.</p>
          )}
        </div>
      )}

      {'similarity_score' in plagiarism && (
        <p className={`mt-3 text-sm font-medium ${plagiarism.flagged ? 'text-red-500' : 'text-gray-500'}`}>
          AI plagiarism screen{isRevision ? ' (new text only)' : ''}: score {String(plagiarism.similarity_score)}/100
          {plagiarism.flagged ? ' — FLAGGED' : ' — clear'} {plagiarism.reason ? `(${String(plagiarism.reason)})` : ''}
        </p>
      )}
      {isRevision && 'skipped' in plagiarism && <p className="mt-3 text-sm text-gray-500">AI plagiarism screen skipped: {String(plagiarism.skipped)}.</p>}
      {/* Items are queued before their screen finishes; the queue polls, so the score replaces this. */}
      {plagiarism.pending === true && <p className="mt-3 text-sm text-gray-500">AI plagiarism screen still running — the result appears here within a minute.</p>}

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {isRevision && item.revision_id && (
          <Link
            href={`/preview/${item.course_id}?revision=${item.revision_id}&item=${item.id}`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
          >
            <GitCompareArrows className="h-4 w-4" /> Review changes
          </Link>
        )}
        <Link href={`/preview/${item.course_id}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline">
          <Eye className="h-4 w-4" /> {isRevision ? 'View live course' : 'Preview course content'}
        </Link>
      </div>

      {lockedByOther ? (
        <p className="mt-4 rounded-xl bg-gray-500/10 px-3 py-2 text-sm text-gray-600">
          Another officer claimed this review. It unlocks if they don&apos;t decide within 30 minutes of claiming.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={onClaim} disabled={busy}>
              <Hand className="h-4 w-4" /> {claim.state === 'mine' ? 'Extend my claim' : 'Claim — I’m reviewing this'}
            </button>
            {claim.state === 'unclaimed' && <span className="text-xs text-gray-500">Claiming shows other officers you are on it (30 minutes).</span>}
          </div>

          <label htmlFor={notesId} className="label mt-4">
            Notes for the educator{' '}
            <span className="font-normal text-gray-500">({isRevision ? 'required to request changes or reject' : 'required to coach'})</span>
          </label>
          <textarea
            id={notesId}
            ref={notesRef}
            className="input"
            rows={3}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              if (error) setError('');
            }}
          />

          <div className="mt-4 flex flex-wrap gap-2">
            {actions.map((opt) => {
              const Icon = ACTION_ICON[opt.action];
              const gated = opt.action === 'approve' && !gate.allowed;
              const className = opt.tone === 'primary' ? 'btn' : opt.tone === 'danger' ? DANGER_BTN : 'btn-secondary';
              return (
                <button
                  key={opt.action}
                  className={className}
                  disabled={busy || gated}
                  aria-describedby={gated ? gateId : undefined}
                  onClick={() => decide(opt)}
                >
                  <Icon className="h-4 w-4" /> {opt.label}
                </button>
              );
            })}
          </div>
          {!gate.allowed && (
            <p id={gateId} className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
              {gate.reason}
            </p>
          )}
          <ul className="mt-3 space-y-0.5 text-xs text-gray-500">
            {actions.map((opt) => (
              <li key={opt.action}>
                <span className="font-semibold text-gray-600">{opt.label}:</span> {opt.hint}
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-500">
          {error}
        </p>
      )}
    </article>
  );
}

export default function QaPage() {
  return (
    <RequireRole roles={['quality_officer', 'platform_admin']}>
      <QaQueue />
    </RequireRole>
  );
}
