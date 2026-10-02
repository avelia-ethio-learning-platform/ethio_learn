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

export default async function CoursesPage({
  searchParams,
}: {
  searchParams: { q?: string; category?: string; pricing_type?: string; page?: string; limit?: string };
}) {
  const page = Math.max(parseInt(searchParams.page ?? '1', 10) || 1, 1);
  const limitRaw = parseInt(searchParams.limit ?? '12', 10);
  const limit = PAGE_SIZES.includes(limitRaw) ? limitRaw : 12;

  const params = new URLSearchParams();
  if (searchParams.q) params.set('q', searchParams.q);
  if (searchParams.category) params.set('category', searchParams.category);
  if (searchParams.pricing_type) params.set('pricing_type', searchParams.pricing_type);
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
      filters={{ q: searchParams.q, category: searchParams.category, pricing_type: searchParams.pricing_type }}
    />
  );
}
