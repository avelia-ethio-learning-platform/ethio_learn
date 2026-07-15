'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import { CheckCircle2, ChevronLeft, ChevronRight, CircleCheck, ListVideo, LoaderCircle, Play, PlayCircle, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';
import { AssessmentsPanel } from './assessments-panel';

interface Lesson {
  id: string;
  title: string;
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
}

function Player({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [videoError, setVideoError] = useState('');
  const [videoLoading, setVideoLoading] = useState(false);

  // Tear down any HLS instance when leaving the page.
  useEffect(() => () => hlsRef.current?.destroy(), []);

  const { data: course } = useQuery({ queryKey: ['course', courseId], queryFn: () => api<CourseDetail>(`/courses/${courseId}`) });
  const { data: status } = useQuery({
    queryKey: ['enrollment-status', courseId],
    queryFn: () => api<{ entitlement_status: string; enrollment_id: string | null }>(`/enrollments/status?course_id=${courseId}`),
  });
  const { data: progress } = useQuery({
    queryKey: ['progress', status?.enrollment_id],
    queryFn: () =>
      api<{ completed_lessons: { lesson_id: string }[]; progress_percent: number; completed_at: string | null }>(
        `/enrollments/${status!.enrollment_id}/progress`,
      ),
    enabled: !!status?.enrollment_id,
  });

  // Flat, ordered lesson list for prev/next navigation.
  const flat = useMemo(() => (course?.sections ?? []).flatMap((s) => s.lessons.map((l) => ({ ...l, sectionTitle: s.title }))), [course]);
  const activeIndex = flat.findIndex((l) => l.id === activeId);
  const completedIds = new Set(progress?.completed_lessons.map((l) => l.lesson_id) ?? []);

  const playLesson = async (lesson: Lesson) => {
    setActiveId(lesson.id);
    setVideoError('');
    // Always tear down a previous HLS instance so streams don't stack up.
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (!lesson.has_video) {
      setVideoError('This lesson has no video uploaded yet.');
      return;
    }
    setVideoLoading(true);
    try {
      const res = await api<{ url: string }>(`/lessons/${lesson.id}/stream-url`);
      const video = videoRef.current;
      if (!video) return;
      if (res.url.includes('.m3u8') && Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setVideoError('Could not play this video. Please try again.'); });
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
    await api(`/progress/lessons/${lessonId}/complete`, { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['progress'] });
    await queryClient.invalidateQueries({ queryKey: ['enrollments'] });
  };

  const goto = (delta: number) => {
    const next = flat[activeIndex + delta];
    if (next) playLesson(next);
  };

  if (!course) {
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
  const active = flat[activeIndex];

  return (
    <PageShell>
      <BackButton fallback="/dashboard" label="My Learning" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="animate-fade-in-up lg:col-span-2">
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">{course.title}</h1>
          <div className="relative mt-5 overflow-hidden rounded-2xl bg-black shadow-floating">
            <video
              ref={videoRef}
              controls
              playsInline
              className="aspect-video w-full"
              onEnded={() => active && markComplete(active.id)}
              onError={() => active?.has_video && setVideoError('Could not play this video. Please try again.')}
            />
            {videoLoading && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-sm text-white backdrop-blur-sm">
                <LoaderCircle className="h-4 w-4 animate-spin" /> Loading video…
              </div>
            )}
            {!active && !videoLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-gray-300">
                <PlayCircle className="h-10 w-10 opacity-70" />
                Select a lesson to begin
              </div>
            )}
          </div>

          {active ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 font-semibold text-foreground">{active.title}</p>
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
          ) : (
            <p className="mt-4 text-sm text-gray-500">Select a lesson from the list to start.</p>
          )}
          {videoError && <p className="mt-2 text-sm font-medium text-amber-600 dark:text-amber-400">{videoError}</p>}
          {progress && (
            <div className="card mt-5 !p-4">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>
                  {progress.progress_percent}% complete{progress.completed_at ? ' — course completed 🎉' : ''}
                </span>
                <span className="font-semibold text-brand-600">{progress.progress_percent}%</span>
              </div>
              <div className="progress-track mt-2">
                <div className="progress-fill" style={{ width: `${progress.progress_percent}%` }} />
              </div>
            </div>
          )}

          <AssessmentsPanel courseId={courseId} />
          <ReviewBox courseId={courseId} progressPercent={progress?.progress_percent ?? 0} />
        </div>

        <aside className="animate-fade-in-up space-y-3">
          <p className="flex items-center gap-2 px-1 text-sm font-bold uppercase tracking-wider text-gray-500">
            <ListVideo className="h-4 w-4 text-brand-500" /> Lessons
          </p>
          {course.sections.map((section) => (
            <div key={section.id} className="card !p-4">
              <h3 className="text-sm font-bold text-foreground">{section.title}</h3>
              <ul className="mt-2 space-y-1">
                {section.lessons.map((lesson) => {
                  const isActive = lesson.id === activeId;
                  const done = completedIds.has(lesson.id);
                  return (
                    <li key={lesson.id}>
                      <button
                        onClick={() => playLesson(lesson)}
                        className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
                          isActive ? 'bg-brand-500/10 font-semibold text-brand-600' : 'text-gray-600 hover:bg-brand-500/5 hover:text-foreground'
                        }`}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          {done ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                          ) : (
                            <Play className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-500' : 'text-gray-400'}`} />
                          )}
                          <span className="truncate">{lesson.title}</span>
                        </span>
                        <span className="shrink-0 text-xs text-gray-400">{Math.max(1, Math.round(lesson.duration_seconds / 60))}m</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </aside>
      </div>
    </PageShell>
  );
}

function ReviewBox({ courseId, progressPercent }: { courseId: string; progressPercent: number }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState('');
  if (progressPercent < 20) return null; // eligible at ≥20% (spec §10.7)
  return (
    <div className="card mt-6">
      <h3 className="font-bold text-foreground">Rate this course</h3>
      <div className="mt-3 flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => setRating(n)} aria-label={`${n} stars`} className="transition-transform hover:scale-110">
            <Star className={`h-7 w-7 ${n <= rating ? 'fill-amber-400 text-amber-400' : 'text-gray-300'}`} />
          </button>
        ))}
      </div>
      <textarea className="input mt-3" rows={3} placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} />
      <button
        className="btn mt-3"
        onClick={async () => {
          try {
            await api(`/courses/${courseId}/reviews`, { method: 'POST', body: { rating, comment: comment || undefined } });
            setMessage('Thanks — your review is in!');
          } catch (err) {
            setMessage((err as Error).message);
          }
        }}
      >
        Submit review
      </button>
      {message && <p className="mt-2 text-sm font-medium text-brand-600">{message}</p>}
    </div>
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
