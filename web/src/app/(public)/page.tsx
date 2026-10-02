import type { Metadata } from 'next';
import { serverApi, staticFallback } from '@/lib/server-api';
import { CourseSummary } from '@/components/CourseCard';
import { HomeClient } from './home-client';

export const metadata: Metadata = {
  title: 'Online courses from Ethiopian educators',
  description:
    'Browse tech, business, freelancing and healthcare courses from verified Ethiopian educators. Pay in ETB with Telebirr, CBE Birr and 18+ banks via Chapa.',
  alternates: { canonical: '/' },
};

// Static and revalidated (ISR), so the landing page never waits on a sleeping
// API. Legacy `/?q=…` filter URLs are forwarded to /courses in next.config.mjs.
export const revalidate = 60;

export default async function HomePage() {
  const { data, unavailable } = staticFallback(
    await serverApi<{ total: number; items: CourseSummary[] }>('/search?page=1&limit=6', 60),
    { total: 0, items: [] },
  );
  return <HomeClient courses={data.items} total={data.total} coursesUnavailable={unavailable} />;
}
