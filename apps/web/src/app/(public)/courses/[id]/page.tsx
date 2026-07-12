import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverApi, SITE_URL } from '@/lib/server-api';
import { priceLabel } from '@/components/CourseCard';
import { CoursePreviewPlayer } from '@/components/CoursePreviewPlayer';
import { BackButton } from '@/components/BackButton';
import { EnrollPanel } from './enroll-panel';

interface CourseDetail {
  id: string;
  title: string;
  description: string;
  category: string;
  thumbnail_url: string | null;
  pricing_type: 'free' | 'freemium' | 'paid';
  price_etb: number | null;
  published_at: string | null;
  sections: {
    id: string;
    title: string;
    is_free_preview: boolean;
    lessons: { id: string; title: string; duration_seconds: number; has_video: boolean }[];
  }[];
}

interface Reviews {
  average_rating: number | null;
  review_count: number;
  reviews: { id: string; rating: number; comment: string | null; created_at: string }[];
}

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const course = await serverApi<CourseDetail>(`/courses/${params.id}`, 300);
  if (!course) return { title: 'Course not found' };
  return {
    title: course.title,
    description: course.description.slice(0, 160),
    alternates: { canonical: `/courses/${course.id}` },
    openGraph: {
      title: course.title,
      description: course.description.slice(0, 200),
      type: 'website',
      ...(course.thumbnail_url ? { images: [course.thumbnail_url] } : {}),
    },
  };
}

export default async function CoursePage({ params }: { params: { id: string } }) {
  const course = await serverApi<CourseDetail>(`/courses/${params.id}`, 60);
  if (!course) notFound();
  const reviews = await serverApi<Reviews>(`/courses/${params.id}/reviews`, 60);

  const totalLessons = course.sections.reduce((n, s) => n + s.lessons.length, 0);
  const totalMinutes = Math.round(
    course.sections.reduce((n, s) => n + s.lessons.reduce((m, l) => m + l.duration_seconds, 0), 0) / 60,
  );

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: course.title,
    description: course.description,
    url: `${SITE_URL}/courses/${course.id}`,
    provider: { '@type': 'Organization', name: 'EthiopiaLearn', url: SITE_URL },
    ...(reviews?.average_rating
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: reviews.average_rating, reviewCount: reviews.review_count } }
      : {}),
    offers: {
      '@type': 'Offer',
      price: course.pricing_type === 'free' ? 0 : (course.price_etb ?? 0),
      priceCurrency: 'ETB',
      availability: 'https://schema.org/InStock',
    },
  };

  return (
    <div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <BackButton fallback="/" label="Browse courses" />
      <div className="grid gap-8 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <p className="text-sm uppercase tracking-wide text-brand-700">{course.category}</p>
        <h1 className="mt-1 text-3xl font-bold">{course.title}</h1>
        <p className="mt-3 text-gray-700">{course.description}</p>
        <p className="mt-3 text-sm text-gray-500">
          {course.sections.length} sections · {totalLessons} lessons · ~{totalMinutes} min
          {reviews?.average_rating ? ` · ★ ${reviews.average_rating} (${reviews.review_count})` : ''}
        </p>

        {(course.pricing_type === 'freemium' || course.pricing_type === 'free') && <CoursePreviewPlayer sections={course.sections} />}

        <h2 className="mt-8 text-xl font-semibold">Course content</h2>
        <div className="mt-3 space-y-3">
          {course.sections.map((section) => (
            <div key={section.id} className="card">
              <h3 className="font-medium">
                {section.title}
                {section.is_free_preview && (
                  <span className="ml-2 rounded bg-brand-100 px-2 py-0.5 text-xs text-brand-800">Free preview</span>
                )}
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-gray-600">
                {section.lessons.map((lesson) => (
                  <li key={lesson.id} className="flex justify-between">
                    <span>▶ {lesson.title}</span>
                    <span>{Math.max(1, Math.round(lesson.duration_seconds / 60))} min</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {reviews && reviews.reviews.length > 0 && (
          <>
            <h2 className="mt-8 text-xl font-semibold">Learner reviews</h2>
            <div className="mt-3 space-y-3">
              {reviews.reviews.slice(0, 5).map((r) => (
                <div key={r.id} className="card">
                  <p className="text-amber-500">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</p>
                  {r.comment && <p className="mt-1 text-sm text-gray-700">{r.comment}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <aside>
        <div className="card sticky top-6">
          <p className="text-2xl font-bold">{priceLabel(course)}</p>
          <EnrollPanel courseId={course.id} pricingType={course.pricing_type} />
          <ul className="mt-4 space-y-1 text-sm text-gray-600">
            <li>✓ Adaptive HLS video streaming</li>
            <li>✓ Verifiable certificate on completion</li>
            <li>✓ Pay with Telebirr, CBE Birr &amp; 18+ banks</li>
            <li>✓ 7-day refund window</li>
          </ul>
        </div>
      </aside>
      </div>
    </div>
  );
}
