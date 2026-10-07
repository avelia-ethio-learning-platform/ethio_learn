'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { BookPlus, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { COURSE_CATEGORIES } from '@/lib/categories';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';
import { Field } from '@/components/form/Field';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

function NewCourseForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [status, , setError, clear] = useFormStatus();
  const [busy, setBusy] = useState<'draft' | 'generate' | null>(null);
  const [pricing, setPricing] = useState('free');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Which button submitted: "Create and generate from a file" opens the outline generator next.
    const generate = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'generate';
    setBusy(generate ? 'generate' : 'draft');
    clear();
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
      queryClient.invalidateQueries({ queryKey: ['own-courses'] });
      router.push(generate ? `/teach/courses/${course.id}?generate=1` : `/teach/courses/${course.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
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
          <Field label="Title (max 120 chars)">
            {(ids) => <input {...ids} name="title" required minLength={4} maxLength={120} className="input" placeholder="e.g. Practical Web Development in Amharic" />}
          </Field>
          <Field label="Description (20–2000 chars)">
            {(ids) => <textarea {...ids} name="description" required minLength={20} maxLength={2000} rows={4} className="input" />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              {(ids) => (
                <select {...ids} name="category" className="input" defaultValue="tech">
                  {COURSE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Pricing">
              {(ids) => (
                <select {...ids} value={pricing} onChange={(e) => setPricing(e.target.value)} className="input">
                  <option value="free">Free</option>
                  <option value="freemium">Freemium (first section free)</option>
                  <option value="paid">Paid</option>
                </select>
              )}
            </Field>
          </div>
          {pricing !== 'free' && <Field label="Price (ETB)">{(ids) => <input {...ids} name="price_etb" type="number" min={1} required className="input" />}</Field>}
          <FormStatus status={status} />
          <div className="grid gap-2 sm:grid-cols-2">
            <button className="btn w-full !py-3" name="action" value="draft" disabled={!!busy}>
              {busy === 'draft' ? 'Creating…' : 'Create draft'}
            </button>
            <button className="btn-secondary w-full !py-3" name="action" value="generate" disabled={!!busy}>
              <FileText className="h-4 w-4" /> {busy === 'generate' ? 'Creating…' : 'Create and generate from a file'}
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Next you&apos;ll add sections, lessons and a thumbnail, then submit for quality review (24–48h). &ldquo;Generate from a file&rdquo; opens the AI
            outline tool: upload a PDF, Word file or notes and it drafts the sections and lessons for you to edit.
          </p>
        </form>
      </div>
    </PageShell>
  );
}

export default function NewCoursePage() {
  return (
    <RequireRole roles={['educator']}>
      <NewCourseForm />
    </RequireRole>
  );
}
