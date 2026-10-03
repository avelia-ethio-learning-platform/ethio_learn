'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import Link from 'next/link';
import { BellRing, ChevronLeft, ChevronRight, CircleCheck, CloudOff, Compass, History, LoaderCircle, Lock, Play, PlayCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { queuedApi, useOffline } from '@/lib/offline-queue';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';
import { WakingUp } from '@/components/WakingUp';
import { AssessmentsPanel } from './assessments-panel';
import { TutorPanel } from './tutor-panel';
import { ReviewBox } from './review-box';
import { CompletionCard } from './completion-card';
import { LessonList } from './lesson-list';
import { formatDate } from '@/lib/format';
import { useT } from '@/lib/i18n';

interface Lesson {
  id: string;
  title: string;
  summary?: string | null;
  duration_seconds: number;
  has_video: boolean;
}
interface Section {
  id: string;
  title: string;
  is_free_preview: boolean;
  lessons: Lesson[];
}
interface CourseDetail {
  id: string;
  title: string;
  sections: Section[];
  last_major_update_at?: string | null;
}
interface ChangelogEntry {
  id: string;
  kind: 'major' | 'minor';
  summary: string;
  created_at: string;
}
interface VideoProgress {
  last_lesson_id: string | null;
  lessons: { lesson_id: string; position_seconds: number; duration_seconds: number; percent_watched: number }[];
}

const HEARTBEAT_MS = 10_000;

function StateCard({ icon, title, body, children }: { icon: React.ReactNode; title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="card w-full max-w-md animate-fade-in-up !rounded-3xl p-8 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-600">{icon}</span>
        <h1 className="text-xl font-bold text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">{body}</p>
        <div className="mt-6 flex justify-center">{children}</div>
      </div>
    </div>
  );
}

function Player({ courseId }: { courseId: string }) {
  const { locale } = useT();
  const queryClient = useQueryClient();
  const search = useSearchParams();
  const { user } = useAuth();
  const { online, pending } = useOffline();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [videoError, setVideoError] = useState('');
  const [videoLoading, setVideoLoading] = useState(false);
  const [watermark, setWatermark] = useState('');
  const [showChangelog, setShowChangelog] = useState(search.get('changelog') === '1');
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  // Tear down any HLS instance when leaving the page.
  useEffect(() => () => hlsRef.current?.destroy(), []);

  const { data: course, error: courseError, refetch: refetchCourse } = useQuery({
    queryKey: ['course', courseId],
    queryFn: () => api<CourseDetail>(`/courses/${courseId}`),
  });
  const { data: status, isError: statusError, refetch: refetchStatus } = useQuery({
    queryKey: ['enrollment-status', courseId],
    queryFn: () => api<{ entitlement_status: string; enrollment_id: string | null }>(`/enrollments/status?course_id=${courseId}`),
  });
  const enrollmentId = status?.enrollment_id ?? null;
  const { data: progress } = useQuery({
    queryKey: ['progress', enrollmentId],
    queryFn: () =>
      api<{ completed_lessons: { lesson_id: string }[]; progress_percent: number; completed_at: string | null; changelog_seen_at: string | null }>(
        `/enrollments/${enrollmentId}/progress`,
      ),
    enabled: !!enrollmentId,
  });
  const { data: videoProgress } = useQuery({
    queryKey: ['video-progress', enrollmentId],
    queryFn: () => api<VideoProgress>(`/enrollments/${enrollmentId}/video-progress`),
    enabled: !!enrollmentId,
    staleTime: 60_000,
  });
  const { data: changelog } = useQuery({
    queryKey: ['changelog', courseId],
    queryFn: () => api<ChangelogEntry[]>(`/courses/${courseId}/changelog`),
  });

  // Flat, ordered lesson list for prev/next navigation.
  const flat = useMemo(() => (course?.sections ?? []).flatMap((s) => s.lessons.map((l) => ({ ...l, sectionTitle: s.title }))), [course]);
  const activeIndex = flat.findIndex((l) => l.id === activeId);
  const completedIds = new Set(progress?.completed_lessons.map((l) => l.lesson_id) ?? []);
  const positions = useMemo(() => new Map((videoProgress?.lessons ?? []).map((v) => [v.lesson_id, v])), [videoProgress]);

  // "Updated" badge: a major change newer than the last time this learner opened the log.
  const latestMajor = changelog?.find((c) => c.kind === 'major');
  const hasUnseenUpdate =
    !!latestMajor && (!progress?.changelog_seen_at || new Date(latestMajor.created_at).getTime() > new Date(progress.changelog_seen_at).getTime());

  const openChangelog = async () => {
    setShowChangelog((v) => !v);
    if (hasUnseenUpdate && enrollmentId) {
      await api(`/enrollments/${enrollmentId}/changelog-seen`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['progress', enrollmentId] });
    }
  };

  // ---- Video progress: heartbeat every 10s, on pause, and on leave; resume from the saved position.
  const sendHeartbeat = useCallback(async () => {
    const video = videoRef.current;
    const lessonId = activeIdRef.current;
    if (!video || !lessonId || !Number.isFinite(video.duration) || video.duration <= 0) return;
    await queuedApi(`/progress/lessons/${lessonId}/video`, {
      method: 'POST',
      body: { position_seconds: Math.floor(video.currentTime), duration_seconds: Math.floor(video.duration) },
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (video && !video.paused && !video.ended) void sendHeartbeat();
    }, HEARTBEAT_MS);
    const onLeave = () => void sendHeartbeat();
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && onLeave());
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', onLeave);
    };
  }, [sendHeartbeat]);

  const playLesson = async (lesson: Lesson) => {
    await sendHeartbeat(); // save the lesson we are leaving
    setActiveId(lesson.id);
    setVideoError('');
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (!lesson.has_video) {
      setVideoError('This lesson has no video uploaded yet.');
      return;
    }
    setVideoLoading(true);
    try {
      const res = await api<{ url: string; watermark?: string }>(`/lessons/${lesson.id}/stream-url`);
      setWatermark(res.watermark ?? user?.email ?? '');
      const video = videoRef.current;
      if (!video) return;
      const resumeAt = positions.get(lesson.id)?.position_seconds ?? 0;
      const seekToResume = () => {
        if (resumeAt > 5 && resumeAt < (video.duration || Infinity) - 5) video.currentTime = resumeAt;
      };
      video.addEventListener('loadedmetadata', seekToResume, { once: true });
      if (res.url.includes('.m3u8') && Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setVideoError('Could not play this video. Please try again.');
        });
        hls.loadSource(res.url);
        hls.attachMedia(video);
      } else {
        video.src = res.url;
      }
      video.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      void video.play().catch(() => undefined);
    } catch (err) {
      setVideoError((err as Error).message);
    } finally {
      setVideoLoading(false);
    }
  };

  const markComplete = async (lessonId: string) => {
    await queuedApi(`/progress/lessons/${lessonId}/complete`, { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['progress'] });
    await queryClient.invalidateQueries({ queryKey: ['enrollments'] });
  };

  const goto = (delta: number) => {
    const next = flat[activeIndex + delta];
    if (next) playLesson(next);
  };

  // States, in order: course not found, course unreachable, loading, enrollment unreachable, not enrolled.
  if (courseError instanceof ApiError && (courseError.status === 400 || courseError.status === 404)) {
    return (
      <PageShell>
        <StateCard icon={<Compass className="h-5 w-5" aria-hidden />} title="Course not found" body="This course doesn't exist, or the link is wrong.">
          <Link href="/courses" className="btn !px-6">
            Browse courses
          </Link>
        </StateCard>
      </PageShell>
    );
  }
  if (courseError) return <WakingUp onRetry={refetchCourse} />;
  // A sleeping enrollment service must never read as "not enrolled".
  if (statusError) return <WakingUp onRetry={refetchStatus} />;
  if (!course || !status) {
    return (
      <PageShell>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <div className="skeleton h-9 w-2/3" />
            <div className="skeleton aspect-video w-full" />
          </div>
          <div className="space-y-3">
            <div className="skeleton h-28 w-full" />
            <div className="skeleton h-28 w-full" />
          </div>
        </div>
      </PageShell>
    );
  }
  if (status.entitlement_status !== 'active') {
    return (
      <PageShell>
        <StateCard icon={<Lock className="h-5 w-5" aria-hidden />} title="You're not enrolled in this course" body="Enroll to watch the lessons and track your progress.">
          <Link href={`/courses/${courseId}`} className="btn !px-6">
            View the course
          </Link>
        </StateCard>
      </PageShell>
    );
  }
  const active = flat[activeIndex];
  const resumeLesson = videoProgress?.last_lesson_id ? flat.find((l) => l.id === videoProgress.last_lesson_id) : undefined;
  const startLesson = resumeLesson ?? flat[0];

  return (
    <PageShell>
      <BackButton fallback="/dashboard" label="My Learning" />
      {(!online || pending > 0) && (
        <p className="badge-warn mb-4 flex w-fit items-center gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-xs">
          <CloudOff className="h-3.5 w-3.5" aria-hidden />
          {online ? `Syncing ${pending} saved update${pending === 1 ? '' : 's'}…` : `You're offline — your progress is saved on this device${pending ? ` (${pending} pending)` : ''} and will sync when you reconnect.`}
        </p>
      )}
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-3">
        {/* DOM order is the mobile order: player, lesson list, then the panels. Desktop places them by grid lines. */}
        <div className="animate-fade-in-up min-w-0 lg:col-span-2 lg:col-start-1 lg:row-start-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">{course.title}</h1>
            {changelog && changelog.length > 0 && (
              <button onClick={openChangelog} className={hasUnseenUpdate ? 'badge-warn !rounded-xl !px-3 !py-1.5 !text-xs' : 'btn-secondary !px-3 !py-1.5 !text-xs'}>
                {hasUnseenUpdate ? <BellRing className="h-3.5 w-3.5" aria-hidden /> : <History className="h-3.5 w-3.5" aria-hidden />}
                {hasUnseenUpdate ? 'Updated — see what changed' : "What's changed"}
              </button>
            )}
          </div>
          {showChangelog && changelog && (
            <div className="card mt-3 !p-4 text-sm">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-500">Course updates</p>
              <ul className="space-y-2">
                {changelog.map((c) => (
                  <li key={c.id} className="flex gap-3">
                    <span className={c.kind === 'major' ? 'badge-info shrink-0' : 'badge-neutral shrink-0'}>{c.kind}</span>
                    <span className="min-w-0 flex-1 text-gray-600">
                      {c.summary} <span className="text-xs text-gray-500">· {formatDate(c.created_at, locale)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="relative mt-5 overflow-hidden rounded-2xl bg-black shadow-floating" onContextMenu={(e) => e.preventDefault()}>
            {activeId && active?.has_video ? (
              <video
                ref={videoRef}
                controls
                playsInline
                controlsList="nodownload noremoteplayback"
                disablePictureInPicture
                className="aspect-video w-full"
                onPause={() => void sendHeartbeat()}
                onEnded={() => {
                  void sendHeartbeat();
                  if (active) markComplete(active.id);
                }}
                onError={() => active?.has_video && setVideoError('Could not play this video. Please try again.')}
              />
            ) : (
              <div className="aspect-video w-full" />
            )}
            {watermark && active && (
              // Moving viewer watermark — a screen recording carries the viewer's identity.
              <div className="pointer-events-none absolute inset-0 select-none">
                <span className="el-watermark absolute text-xs font-semibold text-white/40 drop-shadow">{watermark}</span>
              </div>
            )}
            {videoLoading && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-sm text-white backdrop-blur-sm">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> Loading video…
              </div>
            )}
            {!activeId && !videoLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-sm text-white/80">
                <PlayCircle className="h-10 w-10 opacity-70" aria-hidden />
                {startLesson ? (
                  <button className="btn !px-4 !py-2 !text-xs" onClick={() => playLesson(startLesson)}>
                    <Play className="h-3.5 w-3.5" aria-hidden /> {resumeLesson ? `Resume: ${resumeLesson.title}` : 'Start lesson 1'}
                  </button>
                ) : (
                  'This course has no lessons yet.'
                )}
              </div>
            )}
          </div>

          {active ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground">{active.title}</p>
                {active.summary && <p className="mt-0.5 text-xs text-gray-500">{active.summary}</p>}
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary !px-3 !py-1.5 !text-xs" disabled={activeIndex <= 0} onClick={() => goto(-1)}>
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </button>
                <button className="btn-secondary !px-3 !py-1.5 !text-xs" onClick={() => active && markComplete(active.id)}>
                  <CircleCheck className="h-3.5 w-3.5" /> Mark complete
                </button>
                <button className="btn !px-3 !py-1.5 !text-xs" disabled={activeIndex >= flat.length - 1} onClick={() => goto(1)}>
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
          {videoError && <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">{videoError}</p>}
        </div>

        <aside className="animate-fade-in-up my-6 min-w-0 space-y-3 lg:sticky lg:top-28 lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:my-0 lg:max-h-[calc(100vh-8.5rem)] lg:self-start lg:overflow-y-auto lg:pb-4 lg:pr-1">
          <LessonList
            sections={course.sections}
            activeId={activeId}
            completedIds={completedIds}
            watchedPercent={(id) => positions.get(id)?.percent_watched ?? 0}
            onPlay={(id) => {
              const lesson = flat.find((l) => l.id === id);
              if (lesson) void playLesson(lesson);
            }}
          />
        </aside>

        <div className="animate-fade-in-up min-w-0 lg:col-span-2 lg:col-start-1 lg:row-start-2">
          {progress && (
            <div className="card mt-5 !p-4">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>
                  {/* Completion is permanent (the certificate stands), but an approved
                      course update can add lessons afterwards and pull the percentage below 100. */}
                  {progress.completed_at && progress.progress_percent < 100
                    ? `${progress.progress_percent}% complete — new lessons were added since you completed`
                    : `${progress.progress_percent}% complete${progress.completed_at ? ' — course completed' : ''}`}
                </span>
                <span className="font-semibold text-brand-600">{progress.progress_percent}%</span>
              </div>
              <div className="progress-track mt-2">
                <div className="progress-fill" style={{ width: `${progress.progress_percent}%` }} />
              </div>
            </div>
          )}

          {progress?.completed_at && <CompletionCard courseId={courseId} />}

          <div id="assessments" className="scroll-mt-28">
            <AssessmentsPanel courseId={courseId} />
          </div>
          <TutorPanel courseId={courseId} />
          <ReviewBox courseId={courseId} progressPercent={progress?.progress_percent ?? 0} />
        </div>

      </div>
      <style jsx global>{`
        @keyframes el-wm {
          0% { top: 8%; left: 6%; }
          25% { top: 70%; left: 60%; }
          50% { top: 15%; left: 65%; }
          75% { top: 75%; left: 10%; }
          100% { top: 8%; left: 6%; }
        }
        .el-watermark { animation: el-wm 90s linear infinite; }
      `}</style>
    </PageShell>
  );
}

export default function LearnPage() {
  const params = useParams<{ courseId: string }>();
  return (
    <RequireRole roles={['learner']}>
      <Player courseId={params.courseId} />
    </RequireRole>
  );
}
