'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { LocalDate } from '@/components/Localized';

export interface Review {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

/** Reviews the page shows before "Show more reviews". */
const FIRST = 5;

/**
 * The course page's reviews: the newest five of the API's first page (20), then
 * "Show more reviews" reveals the rest of that page and fetches the next ones
 * while the API says there are more (`has_more`).
 */
export function ReviewsList({ courseId, initial, hasMore }: { courseId: string; initial: Review[]; hasMore: boolean }) {
  const { t } = useT();
  const [items, setItems] = useState(initial);
  const [visible, setVisible] = useState(FIRST);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(hasMore);
  const [loading, setLoading] = useState(false);

  const showMore = async () => {
    if (visible < items.length) {
      setVisible(items.length);
      return;
    }
    setLoading(true);
    try {
      const next = await api<{ reviews: Review[]; has_more?: boolean }>(`/courses/${courseId}/reviews?page=${page + 1}`, { auth: false });
      setItems((prev) => [...prev, ...next.reviews.filter((r) => !prev.some((p) => p.id === r.id))]);
      setVisible((v) => v + next.reviews.length);
      setPage((p) => p + 1);
      setMore(!!next.has_more);
    } catch {
      // The button stays, so the reader can try again.
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 space-y-3">
      {items.slice(0, visible).map((r) => (
        <div key={r.id} className="card">
          <p className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <Star key={n} className={`h-4 w-4 ${n <= r.rating ? 'fill-rating text-rating' : 'text-gray-500'}`} />
            ))}
          </p>
          {r.comment && <p className="mt-2 text-sm leading-relaxed text-gray-600">{r.comment}</p>}
          <p className="mt-2 text-xs text-gray-500">
            <LocalDate iso={r.created_at} />
          </p>
        </div>
      ))}
      {(visible < items.length || more) && (
        <button type="button" className="btn-secondary text-sm" disabled={loading} onClick={() => void showMore()}>
          {loading ? t('loading_more') : t('show_more_reviews')}
        </button>
      )}
    </div>
  );
}
