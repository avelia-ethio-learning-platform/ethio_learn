'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { api } from '@/lib/api';
import { FormStatus, useFormStatus } from '@/components/form/FormStatus';

/** Star rating and optional comment, offered once the learner is 20% in (spec §10.7). */
export function ReviewBox({ courseId, progressPercent }: { courseId: string; progressPercent: number }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [status, setOk, setError, clearStatus] = useFormStatus();
  if (progressPercent < 20) return null; // eligible at ≥20% (spec §10.7)
  return (
    <div className="card mt-6">
      <h3 className="font-bold text-foreground">Rate this course</h3>
      <div className="mt-3 flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => setRating(n)} aria-label={`${n} stars`} className="transition-transform hover:scale-110">
            <Star className={`h-7 w-7 ${n <= rating ? 'fill-amber-400 text-amber-400' : 'text-gray-500'}`} />
          </button>
        ))}
      </div>
      <textarea className="input mt-3" rows={3} aria-label="Review comment (optional)" placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} />
      <button
        className="btn mt-3"
        onClick={async () => {
          clearStatus();
          try {
            await api(`/courses/${courseId}/reviews`, { method: 'POST', body: { rating, comment: comment || undefined } });
            setOk('Thanks — your review is in!');
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        Submit review
      </button>
      <div className="mt-2">
        <FormStatus status={status} />
      </div>
    </div>
  );
}
