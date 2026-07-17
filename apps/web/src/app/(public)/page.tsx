import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
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
  searchParams: { q?: string; category?: string; pricing_type?: string; page?: string };
}) {
  // The catalog moved to /courses — forward legacy landing-page filter URLs there.
  if (searchParams.q || searchParams.category || searchParams.pricing_type) {
    const params = new URLSearchParams();
    if (searchParams.q) params.set('q', searchParams.q);
    if (searchParams.category) params.set('category', searchParams.category);
    if (searchParams.pricing_type) params.set('pricing_type', searchParams.pricing_type);
    redirect(`/courses?${params.toString()}`);
  }

  const result = await serverApi<{ total: number; items: CourseSummary[] }>('/search?page=1&limit=6', 60);
  return <HomeClient courses={result?.items ?? []} total={result?.total ?? 0} />;
}
