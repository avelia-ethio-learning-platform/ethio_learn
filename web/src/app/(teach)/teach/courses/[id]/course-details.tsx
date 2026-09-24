'use client';

import { FormEvent, useState } from 'react';
import { Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { categoryLabel, COURSE_CATEGORIES } from '@/lib/categories';
import { fieldLabel, type WorkingCourse } from './working';

/** "Edited" chip when any of `fields` has a staged change (live courses only). */
export function EditedChip({ course, fields }: { course: Pick<WorkingCourse, 'pending_fields'>; fields: string[] }) {
  const changed = fields.filter((f) => course.pending_fields.includes(f));
  if (!changed.length) return null;
  return (
    <span className="badge-warn !text-[10px]" title={`The ${changed.map(fieldLabel).join(' and ')} change goes live after review`}>
      Edited
    </span>
  );
}

/** Title, description, category and pricing. On a live course a save is staged for review. */
export function CourseDetails({ course, live, disabled, onSaved }: { course: WorkingCourse; live: boolean; disabled: boolean; onSaved: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [pricing, setPricing] = useState(course.pricing_type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title')).trim();
    const description = String(form.get('description')).trim();
    const category = String(form.get('category'));
    const price = pricing === 'free' ? null : Number(form.get('price_etb'));
    // Only changed fields: on a live course every field sent is staged for review.
    const body: Record<string, unknown> = {};
    if (title !== course.title) body.title = title;
    if (description !== course.description) body.description = description;
    if (category !== course.category) body.category = category;
    if (pricing !== course.pricing_type) body.pricing_type = pricing;
    // A free course carries no price, so the catalog never shows a stale one.
    if (price !== course.price_etb) body.price_etb = price;
    if (!Object.keys(body).length) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/courses/${course.id}`, { method: 'PUT', body });
      setEditing(false);
      onSaved(live ? 'Saved — the change is staged and goes live after review.' : 'Course details saved.');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="card animate-fade-in-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Course details</h2>
        {!editing && (
          <button
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={disabled}
            onClick={() => {
              setPricing(course.pricing_type);
              setError('');
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" /> Edit details
          </button>
        )}
      </div>
      {!editing ? (
        <dl className="mt-2 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="flex items-center gap-1.5 text-gray-500">
            Title <EditedChip course={course} fields={['title']} />
          </dt>
          <dd className="min-w-0 break-words">{course.title}</dd>
          <dt className="flex items-center gap-1.5 text-gray-500">
            Description <EditedChip course={course} fields={['description']} />
          </dt>
          <dd className="min-w-0 whitespace-pre-line break-words text-gray-700 dark:text-gray-300">{course.description}</dd>
          <dt className="flex items-center gap-1.5 text-gray-500">
            Category <EditedChip course={course} fields={['category']} />
          </dt>
          <dd>{categoryLabel(course.category)}</dd>
          <dt className="flex items-center gap-1.5 text-gray-500">
            Pricing <EditedChip course={course} fields={['pricing_type', 'price_etb']} />
          </dt>
          <dd className="capitalize">
            {course.pricing_type}
            {course.pricing_type !== 'free' && course.price_etb ? ` · ${course.price_etb} ETB` : ''}
          </dd>
        </dl>
      ) : (
        <form onSubmit={save} className="mt-3 space-y-3">
          <div>
            <label className="label" htmlFor="course-title">
              Title (4–120 chars)
            </label>
            <input id="course-title" name="title" required minLength={4} maxLength={120} defaultValue={course.title} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="course-description">
              Description (20–2000 chars)
            </label>
            <textarea id="course-description" name="description" required minLength={20} maxLength={2000} rows={4} defaultValue={course.description} className="input" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="course-category">
                Category
              </label>
              <select id="course-category" name="category" defaultValue={course.category} className="input">
                {COURSE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="course-pricing">
                Pricing
              </label>
              <select id="course-pricing" value={pricing} onChange={(e) => setPricing(e.target.value as WorkingCourse['pricing_type'])} className="input">
                <option value="free">Free</option>
                <option value="freemium">Freemium (first section free)</option>
                <option value="paid">Paid</option>
              </select>
            </div>
            {pricing !== 'free' && (
              <div>
                <label className="label" htmlFor="course-price">
                  Price (ETB)
                </label>
                <input id="course-price" name="price_etb" type="number" min={1} step="any" required defaultValue={course.price_etb ?? undefined} className="input" />
              </div>
            )}
          </div>
          {live && <p className="text-xs text-gray-500">Learners keep seeing the current details until your changes are approved.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn" disabled={busy}>
              {busy ? 'Saving…' : 'Save details'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {error && <p className="text-sm font-medium text-red-500">{error}</p>}
        </form>
      )}
    </div>
  );
}
