'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { COURSE_CATEGORIES } from '@/lib/categories';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';

interface Prefs {
  new_course_categories: string[];
  new_course_instructor_ids: string[];
  new_course_email: boolean;
  new_course_in_app: boolean;
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 py-3 text-left"
      aria-pressed={checked}
    >
      <span>
        <span className="block text-sm font-medium text-gray-900">{label}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

function PreferencesForm() {
  const { user } = useAuth();
  const userId = user?.id;
  const { data, isLoading } = useQuery({
    queryKey: ['notif-prefs', userId],
    queryFn: () => api<Prefs>(`/notification-preferences/${userId}`),
    enabled: !!userId,
  });

  const [cats, setCats] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState(true);
  const [inApp, setInApp] = useState(true);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    if (!data) return;
    setCats(new Set(data.new_course_categories ?? []));
    setEmail(data.new_course_email ?? true);
    setInApp(data.new_course_in_app ?? true);
  }, [data]);

  const toggleCat = (value: string) => {
    setStatus('idle');
    setCats((prev) => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  };

  const save = async () => {
    if (!userId) return;
    setStatus('saving');
    await api(`/notification-preferences/${userId}`, {
      method: 'PUT',
      body: { new_course_categories: Array.from(cats), new_course_email: email, new_course_in_app: inApp },
    });
    setStatus('saved');
  };

  const followCount = data?.new_course_instructor_ids?.length ?? 0;

  return (
    <div className="mx-auto max-w-2xl">
      <BackButton fallback="/notifications" label="Notifications" />
      <h1 className="text-2xl font-bold">New-course alerts</h1>
      <p className="mt-1 text-sm text-gray-600">
        Tell us what you care about and we&apos;ll let you know the moment a matching course goes live.
      </p>

      <section className="card mt-5">
        <h2 className="text-sm font-semibold text-gray-900">Categories you follow</h2>
        <p className="mt-0.5 text-xs text-gray-500">Get alerted when a new course drops in any of these.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {COURSE_CATEGORIES.map((c) => {
            const on = cats.has(c.value);
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => toggleCat(c.value)}
                aria-pressed={on}
                className={`rounded-full border px-3 py-1.5 text-sm transition active:scale-95 ${
                  on ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-brand-400'
                }`}
              >
                <span aria-hidden>{c.icon}</span> {c.label}
                {on && <span className="ml-1" aria-hidden>✓</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="card mt-4 divide-y">
        <h2 className="pb-1 text-sm font-semibold text-gray-900">How you hear about them</h2>
        <Toggle checked={inApp} onChange={(v) => { setInApp(v); setStatus('idle'); }} label="In-app notifications" hint="Show new-course alerts in your notification bell." />
        <Toggle checked={email} onChange={(v) => { setEmail(v); setStatus('idle'); }} label="Email" hint="Send a short email when a matching course launches." />
      </section>

      <section className="card mt-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Instructors you follow</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {followCount > 0 ? `You follow ${followCount} instructor${followCount !== 1 ? 's' : ''}.` : 'Follow an instructor from their profile to hear about their new courses.'}
          </p>
        </div>
        <Link href="/educators" className="text-sm font-medium text-brand-700 hover:underline">Browse educators →</Link>
      </section>

      <div className="mt-5 flex items-center gap-3">
        <button onClick={save} disabled={isLoading || status === 'saving'} className="btn">
          {status === 'saving' ? 'Saving…' : 'Save preferences'}
        </button>
        {status === 'saved' && <span className="text-sm text-green-600">✓ Saved</span>}
      </div>
    </div>
  );
}

export default function NotificationPreferencesPage() {
  return (
    <RequireRole roles={['learner', 'educator', 'institution_admin', 'quality_officer', 'platform_admin']}>
      <PreferencesForm />
    </RequireRole>
  );
}
