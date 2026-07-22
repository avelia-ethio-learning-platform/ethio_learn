'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, BookPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';

function NewCourseForm() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pricing, setPricing] = useState('free');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      const course = await api<{ id: string }>('/courses', {
        method: 'POST',
        body: {
          title: form.get('title'),
          description: form.get('description'),
          category: form.get('category'),
          language: 'en',
          pricing_type: pricing,
          ...(pricing !== 'free' ? { price_etb: Number(form.get('price_etb')) } : {}),
        },
      });
      router.push(`/teach/courses/${course.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <PageShell>
      <div className="mx-auto max-w-xl">
        <BackButton fallback="/teach" label="My courses" />
        <div className="animate-fade-in-up flex items-center gap-4">
          <span className="gradient-bg-blue flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-floating">
            <BookPlus className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">Create a course</h1>
            <p className="mt-0.5 text-sm text-gray-500">Start with the basics — you can edit everything later.</p>
          </div>
        </div>
        <form onSubmit={submit} className="card mt-6 animate-fade-in-up space-y-4 !rounded-3xl">
          <div>
            <label className="label">Title (max 120 chars)</label>
            <input name="title" required minLength={4} maxLength={120} className="input" placeholder="e.g. Practical Web Development in Amharic" />
          </div>
          <div>
            <label className="label">Description (20–2000 chars)</label>
            <textarea name="description" required minLength={20} maxLength={2000} rows={4} className="input" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Category</label>
              <select name="category" className="input">
                <option value="tech">Tech</option>
                <option value="business">Business</option>
                <option value="freelancing">Freelancing</option>
                <option value="healthcare">Healthcare</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="label">Pricing</label>
              <select value={pricing} onChange={(e) => setPricing(e.target.value)} className="input">
                <option value="free">Free</option>
                <option value="freemium">Freemium (first section free)</option>
                <option value="paid">Paid</option>
              </select>
            </div>
          </div>
          {pricing !== 'free' && (
            <div>
              <label className="label">Price (ETB)</label>
              <input name="price_etb" type="number" min={1} required className="input" />
            </div>
          )}
          {error && (
            <p className="badge-danger flex w-full items-start gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm !font-medium">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </p>
          )}
          <button className="btn w-full !py-3" disabled={busy}>
            {busy ? 'Creating…' : 'Create draft'}
          </button>
          <p className="text-xs text-gray-400">Next you&apos;ll add sections, lessons and a thumbnail, then submit for quality review (24–48h).</p>
        </form>
      </div>
    </PageShell>
  );
}

export default function NewCoursePage() {
  return (
    <RequireRole roles={['educator', 'institution_admin']}>
      <NewCourseForm />
    </RequireRole>
  );
}
