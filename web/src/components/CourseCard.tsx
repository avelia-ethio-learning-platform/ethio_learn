import Link from 'next/link';

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

export function priceLabel(course: Pick<CourseSummary, 'pricing_type' | 'price_etb'>): string {
  if (course.pricing_type === 'free') return 'Free';
  if (course.pricing_type === 'freemium') return `Freemium · ${course.price_etb ?? '—'} ETB`;
  return `${course.price_etb ?? '—'} ETB`;
}

const CATEGORY_ART: Record<string, { emoji: string; gradient: string }> = {
  tech: { emoji: '💻', gradient: 'from-blue-500/20 via-indigo-500/15 to-cyan-400/20' },
  business: { emoji: '📊', gradient: 'from-amber-400/20 via-orange-400/15 to-yellow-300/20' },
  freelancing: { emoji: '🚀', gradient: 'from-violet-500/20 via-purple-400/15 to-fuchsia-400/20' },
  healthcare: { emoji: '🏥', gradient: 'from-emerald-400/20 via-teal-400/15 to-green-300/20' },
  other: { emoji: '📚', gradient: 'from-slate-400/20 via-blue-300/15 to-slate-300/20' },
};

/** Course tile used on the landing grid. Server-safe (CSS-only animation). */
export function CourseCard({ course }: { course: CourseSummary }) {
  const art = CATEGORY_ART[course.category] ?? CATEGORY_ART.other;
  const free = course.pricing_type === 'free';

  return (
    <Link href={`/courses/${course.id}`} className="card card-hover group block overflow-hidden !p-0">
      <div className={`relative flex h-40 items-center justify-center overflow-hidden bg-gradient-to-br ${art.gradient}`}>
        {course.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={course.thumbnail_url}
            alt={course.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <span aria-hidden className="text-5xl transition-transform duration-500 group-hover:scale-110">
            {art.emoji}
          </span>
        )}
        <span
          className={`absolute right-3 top-3 rounded-full px-3 py-1 text-xs font-bold shadow-elevated backdrop-blur-md ${
            free ? 'bg-emerald-500/90 text-white' : 'bg-white/85 text-slate-900 dark:bg-slate-900/85 dark:text-white'
          }`}
        >
          {priceLabel(course)}
        </span>
      </div>
      <div className="p-5">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-600">
          {course.category}
          {course.language && (
            <span className="rounded-md bg-brand-500/10 px-1.5 py-0.5 text-[10px] font-bold tracking-normal">
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
