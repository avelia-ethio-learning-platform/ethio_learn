'use client';

import { useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Hls from 'hls.js';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';

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

  if (isError) return <div className="card text-sm text-red-600">Could not load this course for preview.</div>;
  if (!course) return <p className="text-gray-500">Loading…</p>;

  return (
    <div>
      <BackButton fallback="/qa" label="Back to queue" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Preview · status: {course.status}</span>
          <h1 className="mt-2 text-2xl font-bold">{course.title}</h1>
          <p className="mt-2 text-gray-700">{course.description}</p>
          <p className="mt-1 text-sm text-gray-500">
            {course.category} · {course.pricing_type}
            {course.price_etb ? ` · ${course.price_etb} ETB` : ''}
            {reviews?.average_rating ? ` · ★ ${reviews.average_rating}` : ''}
          </p>
          <div className="mt-4 overflow-hidden rounded-lg bg-black">
            <video ref={videoRef} controls className="aspect-video w-full" />
          </div>
          {playing && <p className="mt-2 text-sm font-medium">Now playing: {playing}</p>}
          {err && <p className="mt-2 text-sm text-amber-700">{err}</p>}
        </div>
        <aside className="space-y-3">
          {course.sections?.map((s: any) => (
            <div key={s.id} className="card">
              <h3 className="text-sm font-semibold">
                {s.title} {s.is_free_preview && <span className="text-xs text-brand-700">(free preview)</span>}
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {s.lessons.map((l: any) => (
                  <li key={l.id}>
                    <button
                      className="text-left text-gray-700 hover:text-brand-700 disabled:text-gray-300"
                      disabled={!l.has_video}
                      onClick={() => play(l.id, l.title)}
                    >
                      ▶ {l.title} {!l.has_video && <span className="text-xs text-gray-400">(no video)</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
      </div>
    </div>
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
