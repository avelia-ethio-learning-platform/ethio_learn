import Link from 'next/link';

export interface CourseSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  thumbnail_url: string | null;
  pricing_type: 'free' | 'freemium' | 'paid';
  price_etb: number | null;
}

export function priceLabel(course: Pick<CourseSummary, 'pricing_type' | 'price_etb'>): string {
  if (course.pricing_type === 'free') return 'Free';
  if (course.pricing_type === 'freemium') return `Freemium · ${course.price_etb ?? '—'} ETB`;
  return `${course.price_etb ?? '—'} ETB`;
}

export function CourseCard({ course }: { course: CourseSummary }) {
  return (
    <Link href={`/courses/${course.id}`} className="card block transition hover:shadow-md">
      <div className="mb-3 flex h-32 items-center justify-center rounded-md bg-brand-50 text-4xl">
        {course.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={course.thumbnail_url} alt={course.title} className="h-full w-full rounded-md object-cover" />
        ) : (
          <span aria-hidden>📚</span>
        )}
      </div>
      <p className="text-xs uppercase tracking-wide text-brand-700">{course.category}</p>
      <h3 className="mt-1 font-semibold">{course.title}</h3>
      <p className="mt-1 line-clamp-2 text-sm text-gray-600">{course.description}</p>
      <p className="mt-2 text-sm font-semibold text-gray-900">{priceLabel(course)}</p>
    </Link>
  );
}
