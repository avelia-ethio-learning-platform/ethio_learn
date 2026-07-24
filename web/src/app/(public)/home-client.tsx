'use client';

import Link from 'next/link';
import { CourseCard, CourseSummary } from '@/components/CourseCard';
import { COURSE_CATEGORIES } from '@/lib/categories';
import { useT } from '@/lib/i18n';

const SORTS = [
  { value: 'top', label: '⭐ Top rated' },
  { value: 'popular', label: '🔥 Most popular' },
  { value: 'new', label: '🆕 Newest' },
  { value: 'price_asc', label: 'Price ↑' },
  { value: 'price_desc', label: 'Price ↓' },
];

export function HomeClient({
  courses,
  searchParams,
}: {
  courses: CourseSummary[];
  searchParams: { q?: string; category?: string; pricing_type?: string; sort?: string };
}) {
  const { t } = useT();
  const withParam = (key: string, value: string) => {
    const p = new URLSearchParams();
    if (searchParams.q) p.set('q', searchParams.q);
    if (searchParams.category) p.set('category', searchParams.category);
    if (searchParams.pricing_type) p.set('pricing_type', searchParams.pricing_type);
    if (searchParams.sort) p.set('sort', searchParams.sort);
    p.set(key, value);
    return `/?${p.toString()}`;
  };
  return (
    <div>
      <section className="mb-10 rounded-2xl bg-brand-700 px-8 py-12 text-white">
        <h1 className="text-3xl font-bold sm:text-4xl">{t('hero_title')}</h1>
        <p className="mt-3 max-w-2xl text-brand-100">{t('hero_sub')}</p>
        <form className="mt-6 flex max-w-lg gap-2" action="/">
          <input name="q" defaultValue={searchParams.q ?? ''} placeholder={t('search_placeholder')} className="input flex-1 text-gray-900" />
          <button className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-brand-800">{t('search')}</button>
        </form>
      </section>

      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/" className={`rounded-full px-3 py-1 ${!searchParams.category ? 'bg-brand-700 text-white' : 'bg-white border'}`}>
          {t('all')}
        </Link>
        {COURSE_CATEGORIES.map((c) => (
          <Link
            key={c.value}
            href={`/?category=${c.value}`}
            className={`rounded-full px-3 py-1 transition-colors ${searchParams.category === c.value ? 'bg-brand-700 text-white' : 'bg-white border hover:border-brand-400'}`}
          >
            <span aria-hidden>{c.icon}</span> {c.label}
          </Link>
        ))}
        <span className="mx-2 text-gray-300">|</span>
        {(['free', 'freemium', 'paid'] as const).map((p) => (
          <Link
            key={p}
            href={withParam('pricing_type', p)}
            className={`rounded-full px-3 py-1 ${searchParams.pricing_type === p ? 'bg-brand-700 text-white' : 'bg-white border'}`}
          >
            {t(p)}
          </Link>
        ))}
        <span className="mx-2 text-gray-300">|</span>
        {SORTS.map((s) => (
          <Link
            key={s.value}
            href={withParam('sort', s.value)}
            className={`rounded-full px-3 py-1 ${(searchParams.sort ?? 'top') === s.value ? 'bg-gray-900 text-white' : 'bg-white border'}`}
          >
            {s.label}
          </Link>
        ))}
        <span className="ml-auto">
          <Link href="/educators" className="font-medium text-brand-700 hover:underline">
            🏆 Top educators →
          </Link>
        </span>
      </div>

      {courses.length === 0 ? (
        <div className="card text-center text-gray-500">
          <p className="text-lg">{t('no_courses')}</p>
          <p className="mt-1 text-sm">
            <Link className="text-brand-700 underline" href="/signup?role=educator">
              {t('become_educator')}
            </Link>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((c, i) => (
            <CourseCard key={c.id} course={c} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
