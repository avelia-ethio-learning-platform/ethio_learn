'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Hls from 'hls.js';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

interface Lesson {
  id: string;
  title: string;
  has_video: boolean;
}
interface Section {
  id: string;
  title: string;
  is_free_preview: boolean;
  lessons: Lesson[];
}

/**
 * Free-preview player shown on the public course page: for sections marked
 * `is_free_preview`, learners can watch lessons before paying (backend allows
 * stream-url for free-preview sections without entitlement).
 */
export function CoursePreviewPlayer({ sections }: { sections: Section[] }) {
  const { user, ready } = useAuth();
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState('');
  const [error, setError] = useState('');

  const previewLessons = sections
    .filter((s) => s.is_free_preview)
    .flatMap((s) => s.lessons.filter((l) => l.has_video).map((l) => ({ ...l, section: s.title })));

  if (previewLessons.length === 0) return null;

  const play = async (lesson: Lesson & { section: string }) => {
    setError('');
    if (!ready) return;
    if (!user) {
      router.push('/login?next=' + encodeURIComponent(location.pathname));
      return;
    }
    setPlaying(lesson.title);
    try {
      const res = await api<{ url: string }>(`/lessons/${lesson.id}/stream-url`);
      const v = videoRef.current;
      if (!v) return;
      if (res.url.includes('.m3u8') && Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(res.url);
        hls.attachMedia(v);
      } else {
        v.src = res.url;
      }
      v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      void v.play().catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card mt-6 border-brand-200 bg-brand-50/40">
      <h2 className="font-semibold text-brand-800">🎬 Free preview</h2>
      <p className="mt-1 text-sm text-gray-600">Watch these lessons for free before you enroll.</p>
      <div className="mt-3 overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} controls className="aspect-video w-full" />
      </div>
      {playing && <p className="mt-2 text-sm font-medium">Now playing: {playing}</p>}
      {error && <p className="mt-2 text-sm text-amber-700">{error}</p>}
      <ul className="mt-3 space-y-1">
        {previewLessons.map((l) => (
          <li key={l.id}>
            <button onClick={() => play(l)} className="text-left text-sm text-brand-700 hover:underline">
              ▶ {l.title} <span className="text-xs text-gray-400">({l.section})</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
