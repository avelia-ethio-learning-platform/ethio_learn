'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Hls from 'hls.js';
import {
  BookOpen,
  CheckCircle2,
  Clapperboard,
  FileText,
  GitCompareArrows,
  ImageOff,
  KeyRound,
  ListChecks,
  Loader2,
  Play,
  TriangleAlert,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell, StatusBadge } from '@/components/PageChrome';
import {
  CHIP_CLASS,
  diffChips,
  fieldLabel,
  formatClock,
  formatPrice,
  markAssessmentsUnavailable,
  markVideoOpened,
  readVideosRecord,
  structureTree,
  syncVideosRecord,
  videosReviewedProgress,
  videosToReview,
  wordDiff,
  writeVideosRecord,
  type PendingAssessment,
  type ReviewVideo,
  type RevisionDiff,
  type TreeMarker,
  type VideosReviewedRecord,
} from '@/lib/qa';

function PreviewSkeleton() {
  return (
    <PageShell>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="skeleton h-9 w-2/3" />
          <div className="skeleton aspect-video w-full" />
        </div>
        <div className="skeleton h-40 w-full" />
      </div>
    </PageShell>
  );
}

/** Where "Back" goes when there is no history (opened in a new tab). */
function useBackTarget(courseId: string): { fallback: string; label: string } {
  const { user } = useAuth();
  if (user?.role === 'institution_admin') return { fallback: '/institution/review', label: 'Back to review queue' };
  if (user?.role === 'educator') return { fallback: `/teach/courses/${courseId}`, label: 'Back to course' };
  return { fallback: '/qa', label: 'Back to queue' };
}

function attachStream(video: HTMLVideoElement, url: string): Hls | null {
  if (url.includes('.m3u8') && Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);
    return hls;
  }
  video.src = url;
  return null;
}

/**
 * Authenticated course preview for QOs / admins / owners. Unlike the public
 * course page (SSR, published-only), this fetches with the caller's token so
 * submitted / under-review / flagged courses are viewable — fixes the QO
 * "Preview course content" 404. It always shows the LIVE version; staged
 * changes to a live course are reviewed with ?revision= (RevisionPreview).
 */
function Preview({ courseId }: { courseId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const back = useBackTarget(courseId);
  const [playing, setPlaying] = useState('');
  const [err, setErr] = useState('');
  const { data: course, isError } = useQuery({ queryKey: ['preview', courseId], queryFn: () => api<any>(`/courses/${courseId}`) });
  const { data: reviews } = useQuery({ queryKey: ['preview-reviews', courseId], queryFn: () => api<any>(`/courses/${courseId}/reviews`), retry: false });

  useEffect(() => () => hlsRef.current?.destroy(), []);

  const play = async (lessonId: string, title: string) => {
    setErr('');
    setPlaying(title);
    try {
      const res = await api<{ url: string }>(`/lessons/${lessonId}/stream-url`);
      const v = videoRef.current;
      if (!v) return;
      hlsRef.current?.destroy();
      hlsRef.current = attachStream(v, res.url);
      void v.play().catch(() => undefined);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (isError) {
    return (
      <PageShell>
        <div className="card mx-auto max-w-md py-8 text-center text-sm font-medium text-red-500">Could not load this course for preview.</div>
      </PageShell>
    );
  }
  if (!course) return <PreviewSkeleton />;

  return (
    <PageShell>
      <BackButton fallback={back.fallback} label={back.label} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 animate-fade-in-up lg:col-span-2">
          <span className="badge-warn">Preview · status: {course.status}</span>
          <h1 className="mt-3 break-words text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">{course.title}</h1>
          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
            <Thumbnail url={course.thumbnail_url} alt={`Thumbnail of ${course.title}`} className="w-full shrink-0 sm:w-56" />
            <p className="min-w-0 whitespace-pre-line break-words leading-relaxed text-gray-600">{course.description}</p>
          </div>
          <p className="mt-2 text-sm text-gray-500">
            {course.category} · {course.pricing_type}
            {course.price_etb ? ` · ${course.price_etb} ETB` : ''}
            {reviews?.average_rating ? ` · ★ ${reviews.average_rating}` : ''}
          </p>
          <div className="mt-5 overflow-hidden rounded-2xl bg-black shadow-floating">
            <video ref={videoRef} controls playsInline className="aspect-video w-full" />
          </div>
          {playing && <p className="mt-3 text-sm font-semibold text-foreground">Now playing: {playing}</p>}
          {err && <p className="mt-2 text-sm font-medium text-amber-600 dark:text-amber-400">{err}</p>}
        </div>
        <aside className="min-w-0 animate-fade-in-up space-y-3">
          {course.sections?.map((s: any) => (
            <div key={s.id} className="card !p-4">
              <h3 className="break-words text-sm font-bold text-foreground">
                {s.title} {s.is_free_preview && <span className="text-xs font-medium text-brand-600">(free preview)</span>}
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {s.lessons.map((l: any) => (
                  <li key={l.id}>
                    <button
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-gray-600 transition-colors hover:bg-brand-500/5 hover:text-brand-600 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-transparent"
                      disabled={!l.has_video}
                      onClick={() => play(l.id, l.title)}
                    >
                      <Play className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{l.title}</span>
                      {!l.has_video && <span className="shrink-0 text-xs text-gray-400">(no video)</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
      </div>
    </PageShell>
  );
}

// ---- revision diff mode ---------------------------------------------------------

function Thumbnail({ url, alt, className = '' }: { url: string | null | undefined; alt: string; className?: string }) {
  return (
    <div className={`relative aspect-video overflow-hidden rounded-xl border border-[var(--border)] bg-gray-500/10 ${className}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-gray-500">
          <ImageOff className="h-5 w-5" aria-hidden /> No thumbnail
        </span>
      )}
    </div>
  );
}

function Section({ id, icon, title, children }: { id?: string; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card min-w-0 scroll-mt-28 !rounded-3xl" aria-label={title}>
      <h2 className="flex items-center gap-2 font-bold text-foreground">
        {icon} {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Before/after text; title and description get word-level highlights when cheap enough. */
function TextChange({ before, after, highlight }: { before: string; after: string; highlight: boolean }) {
  const segments = useMemo(() => (highlight ? wordDiff(before, after) : null), [before, after, highlight]);
  const block = 'min-w-0 whitespace-pre-line break-words rounded-xl px-3 py-2 text-sm leading-relaxed';
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <p className="mb-1 text-xs font-semibold text-gray-500">Before (live)</p>
        <p className={`${block} bg-red-500/5 text-gray-600`}>
          {segments
            ? segments
                .filter((s) => s.op !== 'add')
                .map((s, i) =>
                  s.op === 'del' ? (
                    <del key={i} className="rounded bg-red-500/15 text-red-700 dark:text-red-300">
                      {s.text}
                    </del>
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )
            : before || <em className="text-gray-400">empty</em>}
        </p>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-gray-500">After (staged)</p>
        <p className={`${block} bg-emerald-500/5 text-foreground`}>
          {segments
            ? segments
                .filter((s) => s.op !== 'del')
                .map((s, i) =>
                  s.op === 'add' ? (
                    <ins key={i} className="rounded bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300">
                      {s.text}
                    </ins>
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )
            : after || <em className="text-gray-400">empty</em>}
        </p>
      </div>
    </div>
  );
}

function ValueChange({ before, after }: { before: string; after: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className="rounded-lg bg-red-500/10 px-2 py-0.5 text-red-700 line-through dark:text-red-300">{before}</span>
      <span aria-hidden>→</span>
      <span className="sr-only">changes to</span>
      <span className="rounded-lg bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300">{after}</span>
    </p>
  );
}

function MetadataChanges({ diff }: { diff: RevisionDiff }) {
  return (
    <div className="space-y-5">
      {diff.metadata.map((m) => (
        <div key={m.field}>
          <h3 className="mb-2 text-sm font-semibold capitalize text-foreground">{fieldLabel(m.field)}</h3>
          {m.field === 'thumbnail_url' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">Before (live)</p>
                <Thumbnail url={m.before as string | null} alt="Current thumbnail" />
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-500">After (staged)</p>
                <Thumbnail url={m.after as string | null} alt="New thumbnail" />
              </div>
            </div>
          ) : m.field === 'price_etb' ? (
            <ValueChange before={formatPrice(m.before)} after={formatPrice(m.after)} />
          ) : m.field === 'title' || m.field === 'description' ? (
            <TextChange before={String(m.before ?? '')} after={String(m.after ?? '')} highlight />
          ) : (
            <ValueChange before={String(m.before ?? 'none')} after={String(m.after ?? 'none')} />
          )}
        </div>
      ))}
    </div>
  );
}

const MARKER: Record<TreeMarker, { symbol: string; label: string; className: string }> = {
  '+': { symbol: '+', label: 'Added', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  '−': { symbol: '−', label: 'Removed', className: 'bg-red-500/15 text-red-700 dark:text-red-300' },
  '~': { symbol: '~', label: 'Edited', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  '': { symbol: '·', label: 'Unchanged', className: 'bg-gray-500/10 text-gray-500' },
};

function Marker({ marker }: { marker: TreeMarker }) {
  const m = MARKER[marker];
  return (
    <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs font-bold ${m.className}`} title={m.label}>
      <span aria-hidden>{m.symbol}</span>
      <span className="sr-only">{m.label}:</span>
    </span>
  );
}

function StructureTree({ diff }: { diff: RevisionDiff }) {
  const tree = useMemo(() => structureTree(diff), [diff]);
  return (
    <>
      <p className="mb-3 text-xs text-gray-500">
        <span className="font-semibold">+</span> added · <span className="font-semibold">−</span> removed · <span className="font-semibold">~</span> edited ·
        unchanged sections appear only when a lesson inside them changed.
      </p>
      <ul className="space-y-3">
        {tree.map((s) => (
          <li key={s.key} className="min-w-0">
            <div className="flex items-start gap-2">
              <Marker marker={s.marker} />
              <div className="min-w-0">
                <p className={`break-words text-sm font-semibold text-foreground ${s.marker === '−' ? 'line-through opacity-70' : ''}`}>{s.title}</p>
                {s.titleBefore && <p className="break-words text-xs text-gray-500">was “{s.titleBefore}”</p>}
                {s.note && <p className="text-xs font-medium text-amber-600 dark:text-amber-400">{s.note}</p>}
              </div>
            </div>
            {s.lessons.length > 0 && (
              <ul className="ml-3 mt-2 space-y-1.5 border-l border-[var(--border)] pl-4">
                {s.lessons.map((l) => (
                  <li key={l.id} className="flex items-start gap-2">
                    <Marker marker={l.marker} />
                    <div className="min-w-0">
                      <p className={`break-words text-sm text-gray-700 ${l.marker === '−' ? 'line-through opacity-70' : ''}`}>
                        {l.title}
                        {l.note && <span className="ml-1.5 text-xs text-gray-500">({l.note})</span>}
                      </p>
                      {l.titleBefore && <p className="break-words text-xs text-gray-500">was “{l.titleBefore}”</p>}
                      {l.summary && <p className="whitespace-pre-line break-words text-xs text-gray-500">{l.summary}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function LessonEdits({ diff }: { diff: RevisionDiff }) {
  return (
    <ul className="space-y-5">
      {diff.lessons.changed.map((l) => (
        <li key={l.id} className="min-w-0 border-b border-[var(--border)] pb-5 last:border-0 last:pb-0">
          <p className="break-words text-xs text-gray-500">{l.section_title}</p>
          <h3 className="break-words text-sm font-semibold text-foreground">{l.title_after}</h3>
          <div className="mt-2 space-y-3">
            {l.title_before !== l.title_after && (
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-600">Title</p>
                <TextChange before={l.title_before} after={l.title_after} highlight />
              </div>
            )}
            {(l.summary_before ?? '') !== (l.summary_after ?? '') && (
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-600">Summary</p>
                <TextChange before={l.summary_before ?? ''} after={l.summary_after ?? ''} highlight />
              </div>
            )}
            {l.duration_before !== l.duration_after && (
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-600">Duration</p>
                <ValueChange before={formatClock(l.duration_before)} after={formatClock(l.duration_after)} />
              </div>
            )}
            {l.video_replaced && (
              <a href="#videos" className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:underline">
                <Clapperboard className="h-3.5 w-3.5" /> New video — compare it under “Videos to review”
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * One player per video. Nothing is signed until the reviewer asks for it (stream URLs are
 * rate-limited and short-lived). `version` picks the staged video or the approved one.
 */
function ReviewPlayer({
  lessonId,
  version,
  label,
  onPlayed,
}: {
  lessonId: string;
  version: 'pending' | 'live';
  label: string;
  onPlayed?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const v = videoRef.current;
    if (!url || !v) return;
    const hls = attachStream(v, url);
    void v.play().catch(() => undefined);
    return () => hls?.destroy();
  }, [url]);

  const load = async () => {
    setLoading(true);
    setError('');
    setUrl(null);
    try {
      const res = await api<{ url: string }>(`/lessons/${lessonId}/stream-url${version === 'pending' ? '?version=pending' : ''}`);
      setUrl(res.url);
    } catch (e) {
      const noLiveVideo = version === 'live' && e instanceof ApiError && e.status === 403 && /no video/i.test(e.message);
      setError(noLiveVideo ? 'No approved video — this lesson had none before this update.' : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const buttonText = loading ? 'Loading…' : error ? 'Try again' : 'Load video';

  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs font-semibold text-gray-500">{label}</p>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        {url ? (
          <video
            ref={videoRef}
            controls
            playsInline
            aria-label={label}
            className="h-full w-full"
            onPlay={onPlayed}
            onError={() => {
              setUrl(null);
              setError('The video could not be played — the link may have expired. Load it again.');
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <button
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-60"
              onClick={load}
              disabled={loading}
              aria-label={`${buttonText} — ${label}`}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {buttonText}
            </button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          {error}
        </p>
      )}
    </div>
  );
}

function VideoReview({ videos, opened, onPlayed }: { videos: ReviewVideo[]; opened: string[]; onPlayed: (lessonId: string) => void }) {
  return (
    <ul className="space-y-6">
      {videos.map((v) => {
        const done = opened.includes(v.lesson_id);
        return (
          <li key={v.lesson_id} className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className={v.change === 'new' ? 'badge-info' : 'badge-warn'}>{v.change === 'new' ? 'New video' : 'Replaced video'}</span>
              {done ? (
                <span className="badge-success">
                  <CheckCircle2 className="h-3 w-3" /> Opened
                </span>
              ) : (
                <span className="badge-neutral">Not opened yet</span>
              )}
            </div>
            <p className="break-words text-sm font-semibold text-foreground">{v.title}</p>
            <p className="mb-3 break-words text-xs text-gray-500">{v.section_title}</p>
            {v.change === 'replaced' ? (
              <div className="grid gap-4 md:grid-cols-2">
                <ReviewPlayer lessonId={v.lesson_id} version="live" label="Current video (live)" />
                <ReviewPlayer lessonId={v.lesson_id} version="pending" label="New video (staged)" onPlayed={() => onPlayed(v.lesson_id)} />
              </div>
            ) : (
              <div className="md:max-w-xl">
                <ReviewPlayer lessonId={v.lesson_id} version="pending" label="New video (staged)" onPlayed={() => onPlayed(v.lesson_id)} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const ASSESSMENT_LABEL: Record<string, string> = { quiz: 'Quiz', ai_viva: 'AI viva', project: 'Project' };

function PendingAssessments({ items }: { items: PendingAssessment[] }) {
  return (
    <ul className="space-y-5">
      {items.map((a) => (
        <li key={a.id} className="min-w-0 rounded-2xl border border-[var(--border)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground">{ASSESSMENT_LABEL[a.type] ?? a.type}</span>
            <span className={a.is_required ? 'badge-warn' : 'badge-neutral'}>{a.is_required ? 'Required for the certificate' : 'Optional'}</span>
            <span className="badge-neutral">Pass mark {a.pass_score}%</span>
            {a.type === 'quiz' && <span className="badge-neutral">{a.question_count} questions</span>}
          </div>
          {a.type === 'quiz' && (
            <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm">
              {a.questions.map((q, qi) => (
                <li key={qi} className="min-w-0">
                  <p className="whitespace-pre-line break-words font-medium text-foreground">{q.prompt}</p>
                  {q.kind === 'written' ? (
                    <p className="mt-1 break-words text-xs text-gray-500">
                      Written answer{q.guidance ? ` — marking guidance: ${q.guidance}` : ' — no marking guidance given.'}
                    </p>
                  ) : (
                    <>
                      <ul className="mt-1.5 space-y-1">
                        {(q.options ?? []).map((opt, oi) => {
                          const correct = oi === q.correct_index;
                          return (
                            <li
                              key={oi}
                              className={`flex items-start gap-2 break-words rounded-lg px-2 py-1 ${correct ? 'bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-300' : 'text-gray-600'}`}
                            >
                              {correct ? <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <span className="w-3.5 shrink-0" aria-hidden />}
                              <span className="min-w-0">
                                {opt}
                                {correct && <span className="sr-only"> (answer key)</span>}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      {(q.correct_index === undefined || q.correct_index === null || !(q.options ?? [])[q.correct_index]) && (
                        <p className="mt-1 text-xs font-medium text-red-500">No valid answer key — learners cannot pass this question.</p>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
          {a.type === 'project' && (
            <p className="mt-3 whitespace-pre-line break-words text-sm text-gray-600">{a.instructions || <em>No instructions given.</em>}</p>
          )}
          {a.type === 'ai_viva' && (
            <p className="mt-3 whitespace-pre-line break-words text-sm text-gray-600">
              <span className="font-semibold">Topic context: </span>
              {a.topic_context || <em>none — the viva uses the course outline.</em>}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function KnowledgeAdded({ items }: { items: RevisionDiff['knowledge_added'] }) {
  return (
    <ul className="space-y-4">
      {items.map((k) => (
        <li key={k.title} className="min-w-0">
          <p className="break-words text-sm font-semibold text-foreground">
            {k.title} <span className="font-normal text-gray-500">· {k.chars.toLocaleString()} characters</span>
          </p>
          <p className="mt-1 whitespace-pre-line break-words rounded-xl bg-gray-500/5 px-3 py-2 text-sm text-gray-600">
            {k.excerpt}
            {k.chars > k.excerpt.length ? '…' : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function RevisionPreview({ courseId, revisionId, itemId }: { courseId: string; revisionId: string; itemId: string | null }) {
  const back = useBackTarget(courseId);
  const { user } = useAuth();
  const { data: diff, error, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['revision-diff', courseId],
    queryFn: () => api<RevisionDiff>(`/courses/${courseId}/revisions/current/diff`),
    retry: false,
    // Every visit loads the diff afresh: the educator's "Preview changes" right after an edit
    // or a submit must not show the cached change set (nothing on the teach page invalidates it).
    staleTime: 0,
    gcTime: 0,
    // Keep the players and the checklist stable while the reviewer switches tabs;
    // the decision endpoint rejects a stale review anyway.
    refetchOnWindowFocus: false,
  });
  // 503: the course service could not load the update's new assessments. Showing the rest
  // would let an officer approve assessments nobody has seen, so nothing is shown instead.
  const assessmentsUnavailable = error instanceof ApiError && error.status === 503;
  const videos = useMemo(() => (diff ? videosToReview(diff) : []), [diff]);
  // The checklist belongs to the change set actually shown, even if the link was older.
  const recordKey = diff?.revision?.id ?? revisionId;
  const [record, setRecord] = useState<VideosReviewedRecord | null>(null);

  // dataUpdatedAt: a successful retry must clear a stored load failure even when the diff is unchanged.
  useEffect(() => {
    if (!diff || assessmentsUnavailable) return;
    setRecord(syncVideosRecord(readVideosRecord(recordKey), itemId, videos.map((v) => v.lesson_id)));
  }, [diff, dataUpdatedAt, assessmentsUnavailable, recordKey, itemId, videos]);

  useEffect(() => {
    if (record && !assessmentsUnavailable) writeVideosRecord(recordKey, record);
  }, [record, recordKey, assessmentsUnavailable]);

  // Tell the QA page (another tab, via localStorage) to keep Approve locked for this item.
  useEffect(() => {
    if (assessmentsUnavailable) writeVideosRecord(revisionId, markAssessmentsUnavailable(readVideosRecord(revisionId), itemId));
  }, [assessmentsUnavailable, revisionId, itemId]);

  const onPlayed = useCallback((lessonId: string) => setRecord((prev) => (prev ? markVideoOpened(prev, lessonId) : prev)), []);

  if (isLoading) return <PreviewSkeleton />;
  if (assessmentsUnavailable) {
    const isQaReviewer = user?.role === 'quality_officer' || user?.role === 'platform_admin';
    return (
      <PageShell>
        <BackButton fallback={back.fallback} label={back.label} />
        <div role="alert" className="card mx-auto max-w-lg space-y-3 !border-amber-400/50 py-8 text-center text-sm">
          <TriangleAlert className="mx-auto h-6 w-6 text-amber-500" aria-hidden />
          <p className="font-semibold text-foreground">The new assessments in this update could not be loaded.</p>
          {/* The course service's 503 already says to try again in a minute. */}
          <p className="text-gray-600">
            {error.message}
            {isQaReviewer && ' Approve stays locked on the QA page until this page loads completely, so nobody approves assessments they have not seen.'}
          </p>
          <button className="btn-secondary" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Try again
          </button>
        </div>
      </PageShell>
    );
  }
  if (!diff) {
    return (
      <PageShell>
        <BackButton fallback={back.fallback} label={back.label} />
        <div className="card mx-auto max-w-lg space-y-2 py-8 text-center text-sm">
          <p className="font-semibold text-red-500">Could not load the staged changes.</p>
          <p className="text-gray-500">
            {(error as Error | null)?.message ?? 'Unknown error.'} If the educator withdrew the update or it was already decided, refresh the queue.
          </p>
        </div>
      </PageShell>
    );
  }

  const progress = videosReviewedProgress(record);
  const chips = diffChips(diff.diff_summary);
  const revision = diff.revision;
  const staleLink = !!revision && revision.id !== revisionId;
  const isQaReviewer = user?.role === 'quality_officer' || user?.role === 'platform_admin';
  const hasStructure = [diff.sections.added, diff.sections.removed, diff.sections.changed, diff.lessons.added, diff.lessons.removed, diff.lessons.changed].some(
    (list) => list.length > 0,
  );

  return (
    <PageShell>
      <BackButton fallback={back.fallback} label={back.label} />
      <div className="animate-fade-in-up">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge-info">
            <GitCompareArrows className="h-3 w-3" /> Update to a live course
          </span>
          {revision && <StatusBadge status={revision.status} />}
          {revision?.major && <span className="badge-warn">Major update — enrolled learners are notified</span>}
        </div>
        <h1 className="mt-3 break-words text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">{diff.course.title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          Live course ({diff.course.status.replace(/_/g, ' ')}){revision?.submitted_at ? ` · submitted ${formatWhen(revision.submitted_at)}` : ''}. Learners keep
          seeing the live version until these changes are approved.
        </p>
      </div>

      {staleLink && (
        <p role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          This link was for an earlier change set. Showing the course&apos;s current staged changes — refresh the queue before deciding.
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <aside className="order-first min-w-0 space-y-4 lg:order-last lg:sticky lg:top-28 lg:self-start">
          <div className="card !rounded-3xl">
            <h2 aria-live="polite" className="flex items-center gap-2 font-bold text-foreground">
              <ListChecks className="h-5 w-5 text-brand-500" /> Videos reviewed {progress.opened}/{progress.total}
            </h2>
            {progress.total > 0 ? (
              <>
                <div
                  className="progress-track mt-3"
                  role="progressbar"
                  aria-label="Videos reviewed"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.opened}
                >
                  <div className="progress-fill" style={{ width: `${(progress.opened / progress.total) * 100}%` }} />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  {progress.complete
                    ? `Every new or replaced video has been opened.${isQaReviewer ? ' Approve is unlocked on the QA page.' : ''}`
                    : `Play every new or replaced video below.${isQaReviewer ? ' Approve on the QA page unlocks once all of them have been opened in this browser.' : ''}`}
                </p>
                {!progress.complete && (
                  <a href="#videos" className="mt-2 inline-flex text-xs font-semibold text-brand-600 hover:underline">
                    Go to the videos
                  </a>
                )}
              </>
            ) : (
              <p className="mt-2 text-xs text-gray-500">This update adds or replaces no videos.</p>
            )}
          </div>

          <div className="card !rounded-3xl">
            <h2 className="font-bold text-foreground">Summary of changes</h2>
            {chips.length ? (
              <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="What changed">
                {chips.map((c) => (
                  <li key={c.text} className={CHIP_CLASS[c.tone]}>
                    {c.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-gray-500">No changes.</p>
            )}
            <h3 className="mt-4 text-xs font-semibold text-gray-500">Educator&apos;s summary (becomes the change-log entry)</h3>
            <p className="mt-1 whitespace-pre-line break-words text-sm text-gray-600">
              {revision?.changelog_summary || <em className="text-gray-400">No summary — a sentence is generated from the changes.</em>}
            </p>
            {revision?.decision_notes && (
              <>
                <h3 className="mt-4 text-xs font-semibold text-gray-500">Earlier reviewer notes</h3>
                <p className="mt-1 whitespace-pre-line break-words text-sm text-gray-600">{revision.decision_notes}</p>
              </>
            )}
          </div>
        </aside>

        <div className="min-w-0 space-y-6 lg:col-span-2">
          {diff.empty && (
            <div className="card py-8 text-center text-sm text-gray-500">No staged changes remain in this update.</div>
          )}

          {diff.metadata.length > 0 && (
            <Section icon={<FileText className="h-5 w-5 text-brand-500" />} title="Course details">
              <MetadataChanges diff={diff} />
            </Section>
          )}

          {hasStructure && (
            <Section icon={<BookOpen className="h-5 w-5 text-brand-500" />} title="Outline changes">
              <StructureTree diff={diff} />
            </Section>
          )}

          {diff.lessons.changed.length > 0 && (
            <Section icon={<FileText className="h-5 w-5 text-brand-500" />} title={`Edited lessons (${diff.lessons.changed.length})`}>
              <LessonEdits diff={diff} />
            </Section>
          )}

          {videos.length > 0 && (
            <Section id="videos" icon={<Clapperboard className="h-5 w-5 text-brand-500" />} title={`Videos to review (${progress.opened}/${videos.length} opened)`}>
              <VideoReview videos={videos} opened={record?.opened ?? []} onPlayed={onPlayed} />
            </Section>
          )}

          {diff.pending_assessments.length > 0 && (
            <Section icon={<KeyRound className="h-5 w-5 text-brand-500" />} title={`New assessments (${diff.pending_assessments.length})`}>
              <p className="mb-3 text-xs text-gray-500">Learners do not see these until the update is approved. Check the answer keys.</p>
              <PendingAssessments items={diff.pending_assessments} />
            </Section>
          )}

          {diff.knowledge_added.length > 0 && (
            <Section icon={<BookOpen className="h-5 w-5 text-brand-500" />} title={`New tutor notes (${diff.knowledge_added.length})`}>
              <p className="mb-3 text-xs text-gray-500">The AI tutor answers learners from these notes once the update is approved.</p>
              <KnowledgeAdded items={diff.knowledge_added} />
            </Section>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function PreviewSwitch({ courseId }: { courseId: string }) {
  const search = useSearchParams();
  const revisionId = search.get('revision');
  return revisionId ? <RevisionPreview courseId={courseId} revisionId={revisionId} itemId={search.get('item')} /> : <Preview courseId={courseId} />;
}

export default function PreviewPage() {
  const params = useParams<{ id: string }>();
  return (
    <RequireRole roles={['quality_officer', 'platform_admin', 'educator', 'institution_admin']}>
      <Suspense fallback={<PreviewSkeleton />}>
        <PreviewSwitch courseId={params.id} />
      </Suspense>
    </RequireRole>
  );
}
