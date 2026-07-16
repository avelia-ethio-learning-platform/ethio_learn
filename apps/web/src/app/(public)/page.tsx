import type { Metadata } from 'next';
import { serverApi } from '@/lib/server-api';
import { CourseSummary } from '@/components/CourseCard';
import { HomeClient } from './home-client';

export const metadata: Metadata = {
  title: 'Online courses from Ethiopian educators',
  description:
    'Browse tech, business, freelancing and healthcare courses from verified Ethiopian educators. Pay in ETB with Telebirr, CBE Birr and 18+ banks via Chapa.',
  alternates: { canonical: '/' },
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: { q?: string; category?: string; pricing_type?: string; sort?: string; page?: string };
}) {
  const params = new URLSearchParams();
  if (searchParams.q) params.set('q', searchParams.q);
  if (searchParams.category) params.set('category', searchParams.category);
  if (searchParams.pricing_type) params.set('pricing_type', searchParams.pricing_type);
  if (searchParams.sort) params.set('sort', searchParams.sort);
  params.set('page', searchParams.page ?? '1');
  params.set('limit', '12');

  const result = await serverApi<{ total: number; items: CourseSummary[] }>(`/search?${params.toString()}`, 60);
  return <HomeClient courses={result?.items ?? []} searchParams={searchParams} />;
}
