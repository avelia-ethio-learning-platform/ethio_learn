'use client';

import { useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Hls from 'hls.js';
import { Play } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell, StatusBadge } from '@/components/PageChrome';

/**
 * Authenticated course preview for QOs / admins / owners. Unlike the public
 * course page (SSR, published-only), this fetches with the caller's token so
 * submitted / under-review / flagged courses are viewable — fixes the QO
 * "Preview course content" 404.
 */
function Preview({ courseId }: { courseId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState('');
  const [err, setErr] = useState('');
  const { data: course, isError } = useQuery({ queryKey: ['preview', courseId], queryFn: () => api<any>(`/courses/${courseId}`) });
  const { data: reviews } = useQuery({ queryKey: ['preview-reviews', courseId], queryFn: () => api<any>(`/courses/${courseId}/reviews`), retry: false });

  const play = async (lessonId: string, title: string) => {
    setErr('');
    setPlaying(title);
    try {
      const res = await api<{ url: string }>(`/lessons/${lessonId}/stream-url`);
      const v = videoRef.current;
      if (!v) return;
      if (res.url.includes('.m3u8') && Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(res.url);
        hls.attachMedia(v);
      } else {
        v.src = res.url;
      }
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
  if (!course) {
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

  return (
    <PageShell>
      <BackButton fallback="/qa" label="Back to queue" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="animate-fade-in-up lg:col-span-2">
          <span className="badge-warn">Preview · status: {course.status}</span>
          <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">{course.title}</h1>
          <p className="mt-3 leading-relaxed text-gray-600">{course.description}</p>
          <p className="mt-2 text-sm text-gray-500">
            {course.category} · {course.pricing_type}
            {course.price_etb ? ` · ${course.price_etb} ETB` : ''}
            {reviews?.average_rating ? ` · ★ ${reviews.average_rating}` : ''}
          </p>
          <div className="mt-5 overflow-hidden rounded-2xl bg-black shadow-floating">
            <video ref={videoRef} controls className="aspect-video w-full" />
          </div>
          {playing && <p className="mt-3 text-sm font-semibold text-foreground">Now playing: {playing}</p>}
          {err && <p className="mt-2 text-sm font-medium text-amber-600 dark:text-amber-400">{err}</p>}
        </div>
        <aside className="animate-fade-in-up space-y-3">
          {course.sections?.map((s: any) => (
            <div key={s.id} className="card !p-4">
              <h3 className="text-sm font-bold text-foreground">
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

export default function PreviewPage() {
  const params = useParams<{ id: string }>();
  return (
    <RequireRole roles={['quality_officer', 'platform_admin', 'educator', 'institution_admin']}>
      <Preview courseId={params.id} />
    </RequireRole>
  );
}
