'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
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

  if (!course) return <p className="text-gray-500">Loading course…</p>;
  const active = flat[activeIndex];

  return (
    <div>
      <BackButton fallback="/dashboard" label="My Learning" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h1 className="text-2xl font-bold">{course.title}</h1>
          <div className="relative mt-4 overflow-hidden rounded-lg bg-black">
            <video
              ref={videoRef}
              controls
              playsInline
              className="aspect-video w-full"
              onEnded={() => active && markComplete(active.id)}
              onError={() => active?.has_video && setVideoError('Could not play this video. Please try again.')}
            />
            {videoLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white">Loading video…</div>
            )}
            {!active && !videoLoading && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-300">▶ Select a lesson to begin</div>
            )}
          </div>

          {active ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{active.title}</p>
              <div className="flex gap-2">
                <button className="btn-secondary text-xs" disabled={activeIndex <= 0} onClick={() => goto(-1)}>
                  ← Previous
                </button>
                <button className="btn-secondary text-xs" onClick={() => active && markComplete(active.id)}>
                  Mark complete
                </button>
                <button className="btn text-xs" disabled={activeIndex >= flat.length - 1} onClick={() => goto(1)}>
                  Next →
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-gray-500">Select a lesson from the list to start.</p>
          )}
          {videoError && <p className="mt-2 text-sm text-amber-700">{videoError}</p>}
          {progress && (
            <div className="mt-3">
              <div className="h-2 rounded bg-gray-100">
                <div className="h-2 rounded bg-brand-600" style={{ width: `${progress.progress_percent}%` }} />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {progress.progress_percent}% complete{progress.completed_at ? ' — course completed 🎉' : ''}
              </p>
            </div>
          )}

          <AssessmentsPanel courseId={courseId} />
          <ReviewBox courseId={courseId} progressPercent={progress?.progress_percent ?? 0} />
        </div>

        <aside className="space-y-3">
          {course.sections.map((section) => (
            <div key={section.id} className="card">
              <h3 className="text-sm font-semibold">{section.title}</h3>
              <ul className="mt-2 space-y-1">
                {section.lessons.map((lesson) => {
                  const isActive = lesson.id === activeId;
                  const done = completedIds.has(lesson.id);
                  return (
                    <li key={lesson.id}>
                      <button
                        onClick={() => playLesson(lesson)}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm ${
                          isActive ? 'bg-brand-50 text-brand-800' : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span className="truncate">
                          {done ? '✅' : isActive ? '▶️' : '▶'} {lesson.title}
                        </span>
                        <span className="text-xs text-gray-400">{Math.max(1, Math.round(lesson.duration_seconds / 60))}m</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

function ReviewBox({ courseId, progressPercent }: { courseId: string; progressPercent: number }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState('');
  if (progressPercent < 20) return null; // eligible at ≥20% (spec §10.7)
  return (
    <div className="card mt-6">
      <h3 className="font-semibold">Rate this course</h3>
      <div className="mt-2 flex items-center gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => setRating(n)} className={`text-2xl ${n <= rating ? 'text-amber-500' : 'text-gray-300'}`}>
            ★
          </button>
        ))}
      </div>
      <textarea className="input mt-2" placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} />
      <button
        className="btn mt-2"
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
      {message && <p className="mt-2 text-sm text-gray-600">{message}</p>}
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
