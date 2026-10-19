'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronLeft, ChevronRight, Compass, Languages, RotateCcw, Search, SearchX, SlidersHorizontal, Tag, X } from 'lucide-react';
import { CourseCard, CourseSummary } from '@/components/CourseCard';
import { EmptyRows } from '@/components/EmptyRows';
import { useT } from '@/lib/i18n';
import { Field } from '@/components/form/Field';

const CATEGORIES = ['tech', 'business', 'freelancing', 'healthcare', 'other'] as const;
const PRICING = ['free', 'freemium', 'paid'] as const;
const LANGUAGES = ['en', 'am'] as const;
const PAGE_SIZES = [12, 24, 48] as const;
const DEFAULT_LIMIT = 12;
const SORTS = ['top', 'new', 'popular', 'price_asc', 'price_desc'] as const;
const DEFAULT_SORT = 'top';

export interface ExploreFilters {
  q?: string;
  category?: string;
  pricing_type?: string;
  language?: string;
  sort?: string;
}

type NavPatch = Partial<{
  q: string | undefined;
  category: string | undefined;
  pricing_type: string | undefined;
  language: string | undefined;
  sort: string;
  page: number;
  limit: number;
}>;

/** Windowed page numbers: 1 … around current … last. */
function pageItems(current: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const wanted = Array.from(new Set([1, 2, current - 1, current, current + 1, totalPages - 1, totalPages]))
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const p of wanted) {
    if (p - prev === 2) out.push(prev + 1);
    else if (p - prev > 2) out.push('gap');
    out.push(p);
    prev = p;
  }
  return out;
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { t } = useT();
  return (
    <span className="glass-secondary inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-medium text-brand-700 shadow-glass">
      {label}
      <button
        onClick={onRemove}
        aria-label={t('remove_filter', { label })}
        className="flex h-6 w-6 items-center justify-center rounded-full transition-colors duration-fast hover:bg-brand-500/15"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/** Full course catalog: search, filters, page size and pagination — URL is the source of truth. */
export function ExploreClient({
  courses,
  total,
  page,
  limit,
  filters,
}: {
  courses: CourseSummary[];
  total: number;
  page: number;
  limit: number;
  filters: ExploreFilters;
}) {
  const { t } = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [searchText, setSearchText] = useState(filters.q ?? '');

  // Keep the input in sync when q changes elsewhere (chip removal, back/forward); adjusted while rendering.
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (filters.q !== syncedQ) {
    setSyncedQ(filters.q);
    setSearchText(filters.q ?? '');
  }

  const activeCategory = CATEGORIES.find((c) => c === filters.category);
  const activePricing = PRICING.find((p) => p === filters.pricing_type);
  const activeLanguage = LANGUAGES.find((l) => l === filters.language);
  const activeSort = SORTS.find((s) => s === filters.sort) ?? DEFAULT_SORT;
  const hasFilters = Boolean(filters.q || activeCategory || activePricing || activeLanguage);
  const activeCount = [filters.q, activeCategory, activePricing, activeLanguage].filter(Boolean).length;
  // Below md the filters sit behind a button; they start open when a filter is already applied.
  const [filtersOpen, setFiltersOpen] = useState(hasFilters);

  // The grid crossfades only when its results change; the first results paint as they are (no enter on load).
  const resultsKey = `${filters.q ?? ''}|${activeCategory ?? ''}|${activePricing ?? ''}|${activeLanguage ?? ''}|${activeSort}|${page}|${limit}`;
  const [firstResultsKey] = useState(resultsKey);

  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  const navigate = (patch: NavPatch, { scroll = false } = {}) => {
    const merged = { ...filters, sort: activeSort, page, limit, ...patch };
    const params = new URLSearchParams();
    if (merged.q) params.set('q', merged.q);
    if (merged.category) params.set('category', merged.category);
    if (merged.pricing_type) params.set('pricing_type', merged.pricing_type);
    if (merged.language) params.set('language', merged.language);
    if (merged.sort !== DEFAULT_SORT) params.set('sort', merged.sort);
    if (merged.page > 1) params.set('page', String(merged.page));
    if (merged.limit !== DEFAULT_LIMIT) params.set('limit', String(merged.limit));
    const qs = params.toString();
    startTransition(() => router.push(qs ? `/courses?${qs}` : '/courses', { scroll }));
  };

  const clearAll = () => {
    setSearchText('');
    navigate({ q: undefined, category: undefined, pricing_type: undefined, language: undefined, page: 1 });
  };

  return (
    <div className="relative overflow-hidden">
      {/* Decorative background, matching the landing hero */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-b from-brand-50/60 via-background to-background transition-colors duration-base" />
        <div className="absolute -left-32 -top-24 h-72 w-72 rounded-full bg-brand-400/15 blur-3xl" />
        <div className="absolute -right-24 top-40 h-64 w-64 rounded-full bg-brand-600/10 blur-3xl" />
      </div>

      <div className="page-shell">
        {/* Heading: above the fold, so it doesn't animate in. */}
        <div className="text-center">
          <span className="section-badge">
            <Compass className="h-4 w-4 text-brand-500" />
            {total} {t('courses')}
          </span>
          <h1 className="mt-6 text-3xl font-bold md:text-5xl">
            <span className="gradient-text-blue">{t('explore_courses')}</span>
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-gray-500">{t('courses_section_sub')}</p>
        </div>

        {/* Search + filter panel */}
        <div className="glass mt-10 rounded-3xl p-4 shadow-elevated sm:p-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ q: searchText.trim() || undefined, page: 1 });
            }}
            className="glass-secondary flex items-center gap-2 rounded-2xl border-input-border p-2 focus-within:ring-2 focus-within:ring-brand-500"
          >
            <Search className="ml-2 h-5 w-5 shrink-0 text-brand-500" />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              aria-label={t('search_placeholder')}
              placeholder={t('search_placeholder')}
              className="min-h-11 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-gray-500"
            />
            {searchText && (
              <button
                type="button"
                aria-label={t('clear_search')}
                onClick={() => {
                  setSearchText('');
                  if (filters.q) navigate({ q: undefined, page: 1 });
                }}
                className="btn-ghost !px-2"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button className="btn shrink-0">{t('search')}</button>
          </form>

          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            aria-controls="catalog-filters"
            className="btn-secondary mt-4 flex w-full items-center justify-between md:hidden"
          >
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              {activeCount > 0 ? t('filters_active', { n: activeCount }) : t('filters')}
            </span>
            <ChevronDown className={`h-4 w-4 transition-transform duration-fast ${filtersOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>

          <div id="catalog-filters" className={`mt-5 space-y-4 ${filtersOpen ? 'block' : 'hidden md:block'}`}>
            {/* Category */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex w-24 shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
                <SlidersHorizontal className="h-3.5 w-3.5" /> {t('filter_category')}
              </span>
              <button onClick={() => navigate({ category: undefined, page: 1 })} aria-pressed={!activeCategory} className={!activeCategory ? 'pill-active' : 'pill'}>
                {t('all')}
              </button>
              {CATEGORIES.map((c) => (
                <button key={c} onClick={() => navigate({ category: c, page: 1 })} aria-pressed={activeCategory === c} className={activeCategory === c ? 'pill-active' : 'pill'}>
                  {t(`cat_${c}`)}
                </button>
              ))}
            </div>

            {/* Pricing */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex w-24 shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
                <Tag className="h-3.5 w-3.5" /> {t('filter_pricing')}
              </span>
              <button onClick={() => navigate({ pricing_type: undefined, page: 1 })} aria-pressed={!activePricing} className={!activePricing ? 'pill-active' : 'pill'}>
                {t('all')}
              </button>
              {PRICING.map((p) => (
                <button key={p} onClick={() => navigate({ pricing_type: p, page: 1 })} aria-pressed={activePricing === p} className={activePricing === p ? 'pill-active' : 'pill'}>
                  {t(p)}
                </button>
              ))}
            </div>

            {/* Language */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex w-24 shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
                <Languages className="h-3.5 w-3.5" /> {t('filter_language')}
              </span>
              <button onClick={() => navigate({ language: undefined, page: 1 })} aria-pressed={!activeLanguage} className={!activeLanguage ? 'pill-active' : 'pill'}>
                {t('all')}
              </button>
              {LANGUAGES.map((l) => (
                <button key={l} onClick={() => navigate({ language: l, page: 1 })} aria-pressed={activeLanguage === l} className={activeLanguage === l ? 'pill-active' : 'pill'}>
                  {t(`lang_${l}`)}
                </button>
              ))}
            </div>

            {/* Page size + clear */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">{t('per_page')}</span>
                {PAGE_SIZES.map((n) => (
                  <button key={n} onClick={() => navigate({ limit: n, page: 1 })} aria-pressed={limit === n} className={limit === n ? 'pill-active !px-3' : 'pill !px-3'}>
                    {n}
                  </button>
                ))}
              </div>
              {hasFilters && (
                <button onClick={clearAll} className="btn-ghost text-sm">
                  <RotateCcw className="h-4 w-4" /> {t('clear_filters')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Results meta + active filter chips */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-gray-500">
            {/* Past the last page (`?page=` typed by hand) there is no range to show. */}
            {from > to ? (
              <span>{t('no_courses_on_page')}</span>
            ) : (
              <span>{t('showing_range', { from, to, total })}</span>
            )}
          </p>
          <Field label={t('sort_by')}>
            {(ids) => (
              <select
                {...ids}
                value={activeSort}
                onChange={(e) => navigate({ sort: e.target.value, page: 1 })}
                className="input !w-auto"
              >
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`sort_${s}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {hasFilters && (
            <div className="flex flex-wrap items-center gap-2">
              {filters.q && <Chip label={`“${filters.q}”`} onRemove={() => navigate({ q: undefined, page: 1 })} />}
              {activeCategory && <Chip label={t(`cat_${activeCategory}`)} onRemove={() => navigate({ category: undefined, page: 1 })} />}
              {activePricing && <Chip label={t(activePricing)} onRemove={() => navigate({ pricing_type: undefined, page: 1 })} />}
              {activeLanguage && <Chip label={t(`lang_${activeLanguage}`)} onRemove={() => navigate({ language: undefined, page: 1 })} />}
            </div>
          )}
        </div>

        {/* Grid */}
        {/* Grid. While the next results load, a thin bar runs above the current ones, which stay
            readable and clickable; new results crossfade in (keyed, so .fade-in plays on each change). */}
        <div className="relative mt-6" aria-busy={isPending}>
          {isPending && <div className="loading-bar" data-testid="results-loading" />}
          {courses.length === 0 ? (
            <div className="card mx-auto mt-2 max-w-lg">
              <EmptyRows
                icon={SearchX}
                label={t('no_courses')}
                action={
                  hasFilters ? (
                    <>
                      <p className="mb-4">{t('try_adjusting')}</p>
                      <button onClick={clearAll} className="btn-secondary">
                        <RotateCcw className="h-4 w-4" /> {t('clear_filters')}
                      </button>
                    </>
                  ) : page > 1 ? (
                    <button onClick={() => navigate({ page: 1 }, { scroll: true })} className="btn-secondary">
                      <ChevronLeft className="h-4 w-4" /> {t('view_all_courses')}
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div
              key={resultsKey}
              data-testid="results"
              className={`${resultsKey === firstResultsKey ? '' : 'fade-in '}grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3`}
            >
              {courses.map((c) => (
                <CourseCard key={c.id} course={c} />
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <nav aria-label={t('pagination')} className="mt-12 flex flex-wrap items-center justify-center gap-2">
            <button
              disabled={page <= 1 || isPending}
              onClick={() => navigate({ page: page - 1 }, { scroll: true })}
              className="pill disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> {t('prev')}
            </button>
            {pageItems(page, totalPages).map((it, i) =>
              it === 'gap' ? (
                <span key={`gap-${i}`} className="px-1 text-gray-500">
                  …
                </span>
              ) : (
                <button
                  key={it}
                  onClick={() => navigate({ page: it }, { scroll: true })}
                  aria-current={it === page ? 'page' : undefined}
                  disabled={isPending}
                  className={it === page ? 'pill-active !px-4' : 'pill !px-4'}
                >
                  {it}
                </button>
              ),
            )}
            <button
              disabled={page >= totalPages || isPending}
              onClick={() => navigate({ page: page + 1 }, { scroll: true })}
              className="pill disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('next')} <ChevronRight className="h-4 w-4" />
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}
