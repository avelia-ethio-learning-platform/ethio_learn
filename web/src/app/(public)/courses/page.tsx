import type { Metadata } from 'next';
import { serverApi } from '@/lib/server-api';
import { CourseSummary } from '@/components/CourseCard';
import { WakingUp } from '@/components/WakingUp';
import { ExploreClient } from './explore-client';

export const metadata: Metadata = {
  title: 'Browse courses',
  description:
    'Search and filter published courses from verified Ethiopian educators — tech, business, freelancing, healthcare and more. Pay in ETB with Telebirr, CBE Birr and 18+ banks via Chapa.',
  alternates: { canonical: '/courses' },
};

const PAGE_SIZES = [12, 24, 48];
const SORTS = ['top', 'new', 'popular', 'price_asc', 'price_desc'];

export default async function CoursesPage(props: {
  searchParams: Promise<{ q?: string; category?: string; pricing_type?: string; language?: string; page?: string; limit?: string; sort?: string }>;
}) {
  const searchParams = await props.searchParams;
  // The API accepts pages 1–10000 (a hand-typed larger page would 400); past the end is an empty page either way.
  const page = Math.min(Math.max(parseInt(searchParams.page ?? '1', 10) || 1, 1), 10000);
  const limitRaw = parseInt(searchParams.limit ?? '12', 10);
  const limit = PAGE_SIZES.includes(limitRaw) ? limitRaw : 12;

  const sort = SORTS.includes(searchParams.sort ?? '') ? (searchParams.sort as string) : 'top';

  const params = new URLSearchParams();
  if (searchParams.q) params.set('q', searchParams.q);
  if (searchParams.category) params.set('category', searchParams.category);
  if (searchParams.pricing_type) params.set('pricing_type', searchParams.pricing_type);
  if (searchParams.language) params.set('language', searchParams.language);
  params.set('sort', sort);
  params.set('page', String(page));
  params.set('limit', String(limit));

  const result = await serverApi<{ total: number; items: CourseSummary[] }>(`/search?${params.toString()}`, 30);
  if (!result.ok && result.status === 'unavailable') return <WakingUp />;
  const data = result.ok ? result.data : { total: 0, items: [] };

  return (
    <ExploreClient
      courses={data.items}
      total={data.total}
      page={page}
      limit={limit}
      filters={{ q: searchParams.q, category: searchParams.category, pricing_type: searchParams.pricing_type, language: searchParams.language, sort }}
    />
  );
}
