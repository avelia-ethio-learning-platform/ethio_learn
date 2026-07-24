import Link from 'next/link';
import { categoryIcon, categoryLabel } from '@/lib/categories';

export interface CourseSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  thumbnail_url: string | null;
  pricing_type: 'free' | 'freemium' | 'paid';
  price_etb: number | null;
  rating_avg?: number | null;
  rating_count?: number;
  enrolled_count?: number;
}

export function priceLabel(course: Pick<CourseSummary, 'pricing_type' | 'price_etb'>): string {
  if (course.pricing_type === 'free') return 'Free';
  if (course.pricing_type === 'freemium') return `Freemium · ${course.price_etb ?? '—'} ETB`;
  return `${course.price_etb ?? '—'} ETB`;
}

export function CourseCard({ course }: { course: CourseSummary }) {
  return (
    <Link
      href={`/courses/${course.id}`}
      className="card group block transition duration-200 hover:-translate-y-1 hover:shadow-lg"
    >
      <div className="mb-3 flex h-32 items-center justify-center overflow-hidden rounded-md bg-brand-50 text-4xl">
        {course.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={course.thumbnail_url}
            alt={course.title}
            className="h-full w-full rounded-md object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <span aria-hidden className="transition-transform duration-300 group-hover:scale-110">
            {categoryIcon(course.category)}
          </span>
        )}
      </div>
      <p className="text-xs uppercase tracking-wide text-brand-700">
        <span aria-hidden>{categoryIcon(course.category)}</span> {categoryLabel(course.category)}
      </p>
      <h3 className="mt-1 font-semibold">{course.title}</h3>
      <p className="mt-1 line-clamp-2 text-sm text-gray-600">{course.description}</p>
      <div className="mt-2 flex items-center justify-between text-sm">
        <span className="font-semibold text-gray-900">{priceLabel(course)}</span>
        <span className="text-xs text-gray-500">
          {course.rating_avg ? (
            <span className="text-amber-600">★ {course.rating_avg} <span className="text-gray-400">({course.rating_count})</span></span>
          ) : (
            <span className="text-gray-300">no ratings yet</span>
          )}
          {(course.enrolled_count ?? 0) > 0 && <span className="ml-2">👥 {course.enrolled_count}</span>}
        </span>
      </div>
    </Link>
  );
}
