'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Hls from 'hls.js';
import { Clapperboard, PlayCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';

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
  const { t } = useT();
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
    <div className="card mt-8 !rounded-3xl border-2 !border-brand-200/60 bg-gradient-to-br from-brand-50/70 to-brand-100/40 dark:from-blue-950/30 dark:to-blue-900/15">
      <h2 className="flex items-center gap-2 font-bold text-foreground">
        <span className="glass-secondary flex h-9 w-9 items-center justify-center rounded-xl">
          <Clapperboard className="h-5 w-5 text-brand-600" />
        </span>
        {t('free_preview')}
      </h2>
      <p className="mt-2 text-sm text-gray-500">Watch these lessons for free before you enroll.</p>
      <div className="mt-4 overflow-hidden rounded-2xl bg-black shadow-elevated">
        <video ref={videoRef} controls className="aspect-video w-full" />
      </div>
      {playing && <p className="mt-3 text-sm font-semibold text-foreground">Now playing: {playing}</p>}
      {error && <p className="mt-2 text-sm font-medium text-amber-600 dark:text-amber-400">{error}</p>}
      <ul className="mt-4 space-y-1">
        {previewLessons.map((l) => (
          <li key={l.id}>
            <button
              onClick={() => play(l)}
              className="group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-brand-600 transition-colors hover:bg-brand-500/10"
            >
              <PlayCircle className="h-4 w-4 shrink-0 transition-transform group-hover:scale-110" />
              <span className="min-w-0 flex-1 truncate">{l.title}</span>
              <span className="shrink-0 text-xs text-gray-400">({l.section})</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
