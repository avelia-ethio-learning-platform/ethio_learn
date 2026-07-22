'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Compass, RotateCcw, Search, SlidersHorizontal, Tag, X } from 'lucide-react';
import { CourseCard, CourseSummary } from '@/components/CourseCard';
import { useT } from '@/lib/i18n';

const CATEGORIES = ['tech', 'business', 'freelancing', 'healthcare', 'other'] as const;
const PRICING = ['free', 'freemium', 'paid'] as const;
const PAGE_SIZES = [12, 24, 48] as const;
const DEFAULT_LIMIT = 12;

export interface ExploreFilters {
  q?: string;
  category?: string;
  pricing_type?: string;
}

type NavPatch = Partial<{
  q: string | undefined;
  category: string | undefined;
  pricing_type: string | undefined;
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
  return (
    <span className="glass-secondary inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-medium text-brand-700 shadow-glass">
      {label}
      <button
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-brand-500/15"
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

  // Keep the input in sync when q changes elsewhere (chip removal, back/forward).
  useEffect(() => setSearchText(filters.q ?? ''), [filters.q]);

  const activeCategory = CATEGORIES.find((c) => c === filters.category);
  const activePricing = PRICING.find((p) => p === filters.pricing_type);
  const hasFilters = Boolean(filters.q || activeCategory || activePricing);

  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  const navigate = (patch: NavPatch, { scroll = false } = {}) => {
    const merged = { ...filters, page, limit, ...patch };
    const params = new URLSearchParams();
    if (merged.q) params.set('q', merged.q);
    if (merged.category) params.set('category', merged.category);
    if (merged.pricing_type) params.set('pricing_type', merged.pricing_type);
    if (merged.page > 1) params.set('page', String(merged.page));
    if (merged.limit !== DEFAULT_LIMIT) params.set('limit', String(merged.limit));
    const qs = params.toString();
    startTransition(() => router.push(qs ? `/courses?${qs}` : '/courses', { scroll }));
  };

  const clearAll = () => {
    setSearchText('');
    navigate({ q: undefined, category: undefined, pricing_type: undefined, page: 1 });
  };

  return (
    <div className="relative overflow-hidden">
      {/* Decorative background, matching the landing hero */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-b from-brand-50/60 via-background to-background transition-colors duration-300 dark:from-blue-950/30" />
        <div className="absolute -left-32 -top-24 h-72 w-72 rounded-full bg-blue-400/15 blur-3xl dark:bg-blue-500/10" />
        <div className="absolute -right-24 top-40 h-64 w-64 rounded-full bg-blue-600/10 blur-3xl dark:bg-blue-700/10" />
      </div>

      <div className="page-shell">
        {/* Heading */}
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="text-center">
          <span className="section-badge">
            <Compass className="h-4 w-4 text-brand-500" />
            {total} {t('courses')}
          </span>
          <h1 className="mt-6 text-3xl font-bold md:text-5xl">
            <span className="gradient-text-blue">{t('explore_courses')}</span>
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-gray-500">{t('courses_section_sub')}</p>
        </motion.div>

        {/* Search + filter panel */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="glass mt-10 rounded-3xl p-4 shadow-elevated sm:p-6"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ q: searchText.trim() || undefined, page: 1 });
            }}
            className="glass-secondary flex items-center gap-2 rounded-2xl p-2"
          >
            <Search className="ml-2 h-5 w-5 shrink-0 text-brand-500" />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={t('search_placeholder')}
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-gray-400"
            />
            {searchText && (
              <button
                type="button"
                aria-label="Clear search"
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

          <div className="mt-5 space-y-4">
            {/* Category */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex w-24 shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <SlidersHorizontal className="h-3.5 w-3.5" /> {t('filter_category')}
              </span>
              <button onClick={() => navigate({ category: undefined, page: 1 })} className={!activeCategory ? 'pill-active' : 'pill'}>
                {t('all')}
              </button>
              {CATEGORIES.map((c) => (
                <button key={c} onClick={() => navigate({ category: c, page: 1 })} className={activeCategory === c ? 'pill-active' : 'pill'}>
                  {t(`cat_${c}`)}
                </button>
              ))}
            </div>

            {/* Pricing */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex w-24 shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                <Tag className="h-3.5 w-3.5" /> {t('filter_pricing')}
              </span>
              <button onClick={() => navigate({ pricing_type: undefined, page: 1 })} className={!activePricing ? 'pill-active' : 'pill'}>
                {t('all')}
              </button>
              {PRICING.map((p) => (
                <button key={p} onClick={() => navigate({ pricing_type: p, page: 1 })} className={activePricing === p ? 'pill-active' : 'pill'}>
                  {t(p)}
                </button>
              ))}
            </div>

            {/* Page size + clear */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">{t('per_page')}</span>
                {PAGE_SIZES.map((n) => (
                  <button key={n} onClick={() => navigate({ limit: n, page: 1 })} className={limit === n ? 'pill-active !px-3' : 'pill !px-3'}>
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
        </motion.div>

        {/* Results meta + active filter chips */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <span className="font-semibold text-foreground">
              {from}–{to}
            </span>
            / {total} · {t('courses')}
            {isPending && <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />}
          </p>
          {hasFilters && (
            <div className="flex flex-wrap items-center gap-2">
              {filters.q && <Chip label={`“${filters.q}”`} onRemove={() => navigate({ q: undefined, page: 1 })} />}
              {activeCategory && <Chip label={t(`cat_${activeCategory}`)} onRemove={() => navigate({ category: undefined, page: 1 })} />}
              {activePricing && <Chip label={t(activePricing)} onRemove={() => navigate({ pricing_type: undefined, page: 1 })} />}
            </div>
          )}
        </div>

        {/* Grid */}
        {courses.length === 0 ? (
          <div className="card mx-auto mt-8 max-w-lg py-12 text-center">
            <p className="text-4xl">🔎</p>
            <p className="mt-3 text-lg font-medium text-foreground">{t('no_courses')}</p>
            <p className="mt-2 text-sm text-gray-500">{t('try_adjusting')}</p>
            {hasFilters && (
              <button onClick={clearAll} className="btn-secondary mt-5">
                <RotateCcw className="h-4 w-4" /> {t('clear_filters')}
              </button>
            )}
          </div>
        ) : (
          <motion.div
            key={`${filters.q ?? ''}|${activeCategory ?? ''}|${activePricing ?? ''}|${page}|${limit}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            aria-busy={isPending}
            className={`mt-6 grid grid-cols-1 gap-6 transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-3 ${
              isPending ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            {courses.map((c) => (
              <CourseCard key={c.id} course={c} />
            ))}
          </motion.div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <nav aria-label="Pagination" className="mt-12 flex flex-wrap items-center justify-center gap-2">
            <button
              disabled={page <= 1 || isPending}
              onClick={() => navigate({ page: page - 1 }, { scroll: true })}
              className="pill disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> {t('prev')}
            </button>
            {pageItems(page, totalPages).map((it, i) =>
              it === 'gap' ? (
                <span key={`gap-${i}`} className="px-1 text-gray-400">
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
