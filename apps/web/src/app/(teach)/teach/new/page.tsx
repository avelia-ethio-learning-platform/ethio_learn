'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';

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
    <div className="mx-auto max-w-xl">
      <BackButton fallback="/teach" label="My courses" />
      <h1 className="text-2xl font-bold">Create a course</h1>
      <form onSubmit={submit} className="card mt-4 space-y-4">
        <div>
          <label className="label">Title (max 120 chars)</label>
          <input name="title" required minLength={4} maxLength={120} className="input" />
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
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Creating…' : 'Create draft'}
        </button>
        <p className="text-xs text-gray-500">Next you&apos;ll add sections, lessons and a thumbnail, then submit for quality review (24–48h).</p>
      </form>
    </div>
  );
}

export default function NewCoursePage() {
  return (
    <RequireRole roles={['educator', 'institution_admin']}>
      <NewCourseForm />
    </RequireRole>
  );
}
