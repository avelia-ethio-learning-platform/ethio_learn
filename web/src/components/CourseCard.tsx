import Link from 'next/link';
import { hasRealThumbnail } from '@/lib/categories';
import { CourseCover } from './CourseCover';
import { CategoryName, PriceLabel } from './Localized';

export interface CourseSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  thumbnail_url: string | null;
  pricing_type: 'free' | 'freemium' | 'paid';
  price_etb: number | null;
  language?: string | null;
  published_at?: string | null;
}

const LANG_LABEL: Record<string, string> = { en: 'EN', am: 'አማ' };

/** Course tile used on the landing grid. Server-safe (CSS-only animation). */
export function CourseCard({ course }: { course: CourseSummary }) {
  const free = course.pricing_type === 'free';

  return (
    <Link href={`/courses/${course.id}`} className="card card-hover group block overflow-hidden !p-0">
      <div className="relative overflow-hidden">
        {hasRealThumbnail(course.thumbnail_url) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={course.thumbnail_url}
            alt="" // the card's heading names the course
            width={400}
            height={160}
            decoding="async"
            loading="lazy"
            className="h-40 w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <CourseCover title={course.title} category={course.category} size="card" decorative />
        )}
        <span
          className={`absolute right-3 top-3 rounded-full px-3 py-1 text-xs font-bold shadow-elevated backdrop-blur-md ${
            free ? 'bg-emerald-700 text-white' : 'bg-white/85 text-slate-900 dark:bg-slate-900/85 dark:text-white'
          }`}
        >
          <PriceLabel pricingType={course.pricing_type} priceEtb={course.price_etb} />
        </span>
      </div>
      <div className="p-5">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-600">
          <CategoryName value={course.category} />
          {course.language && (
            <span className="rounded-md bg-brand-500/10 px-1.5 py-0.5 text-xs font-bold tracking-normal">
              {LANG_LABEL[course.language] ?? course.language.toUpperCase()}
            </span>
          )}
        </p>
        <h3 className="mt-1.5 line-clamp-2 font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-600">
          {course.title}
        </h3>
        <p className="mt-1.5 line-clamp-2 text-sm text-gray-500">{course.description}</p>
        <p className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">
          <span className="transition-transform duration-300 group-hover:translate-x-1">→</span>
        </p>
      </div>
    </Link>
  );
}
