import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BadgeCheck, Clock, Layers, PlayCircle, Star, Wallet } from 'lucide-react';
import { serverApi, SITE_URL } from '@/lib/server-api';
import { categoryIcon, categoryLabel } from '@/lib/categories';
import { priceLabel } from '@/components/CourseCard';
import { CoursePreviewPlayer } from '@/components/CoursePreviewPlayer';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';
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

  const metaChips = [
    { icon: Layers, label: `${course.sections.length} sections` },
    { icon: PlayCircle, label: `${totalLessons} lessons` },
    { icon: Clock, label: `~${totalMinutes} min` },
    ...(reviews?.average_rating ? [{ icon: Star, label: `${reviews.average_rating} (${reviews.review_count})` }] : []),
  ];

  return (
    <PageShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <BackButton fallback="/courses" label="Browse courses" />

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="animate-fade-in-up lg:col-span-2">
          <span className="badge-info uppercase tracking-wider">{course.category}</span>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">{course.title}</h1>
          <p className="mt-4 leading-relaxed text-gray-600">{course.description}</p>

          <div className="mt-5 flex flex-wrap gap-2">
            {metaChips.map((chip) => (
              <span key={chip.label} className="section-badge !px-3 !py-1.5 !text-xs">
                <chip.icon className="h-3.5 w-3.5 text-brand-500" />
                {chip.label}
              </span>
            ))}
          </div>

          {(course.pricing_type === 'freemium' || course.pricing_type === 'free') && <CoursePreviewPlayer sections={course.sections} />}

          <h2 className="mt-10 text-xl font-bold text-foreground">Course content</h2>
          <div className="mt-4 space-y-3">
            {course.sections.map((section, idx) => (
              <div key={section.id} className="card !p-0 overflow-hidden">
                <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="glass-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-brand-600">
                    {idx + 1}
                  </span>
                  <h3 className="min-w-0 flex-1 font-semibold text-foreground">{section.title}</h3>
                  {section.is_free_preview && <span className="badge-success shrink-0">Free preview</span>}
                </div>
                <ul className="px-5 py-3">
                  {section.lessons.map((lesson) => (
                    <li key={lesson.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                      <span className="inline-flex min-w-0 items-center gap-2 text-gray-600">
                        <PlayCircle className="h-4 w-4 shrink-0 text-brand-400" />
                        <span className="truncate">{lesson.title}</span>
                      </span>
                      <span className="shrink-0 text-xs text-gray-400">{Math.max(1, Math.round(lesson.duration_seconds / 60))} min</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {reviews && reviews.reviews.length > 0 && (
            <>
              <h2 className="mt-10 text-xl font-bold text-foreground">Learner reviews</h2>
              <div className="mt-4 space-y-3">
                {reviews.reviews.slice(0, 5).map((r) => (
                  <div key={r.id} className="card">
                    <p className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star key={n} className={`h-4 w-4 ${n <= r.rating ? 'fill-amber-400 text-amber-400' : 'text-gray-300'}`} />
                      ))}
                    </p>
                    {r.comment && <p className="mt-2 text-sm leading-relaxed text-gray-600">{r.comment}</p>}
                    <p className="mt-2 text-xs text-gray-400">{new Date(r.created_at).toDateString()}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <aside className="animate-fade-in-up">
          <div className="card sticky top-28 !rounded-3xl !p-6 shadow-elevated">
            <p className="gradient-text-blue text-3xl font-extrabold">{priceLabel(course)}</p>
            <EnrollPanel courseId={course.id} pricingType={course.pricing_type} />
            <ul className="mt-5 space-y-2.5 text-sm text-gray-600">
              <li className="flex items-center gap-2.5">
                <PlayCircle className="h-4 w-4 shrink-0 text-brand-500" /> Adaptive HLS video streaming
              </li>
              <li className="flex items-center gap-2.5">
                <BadgeCheck className="h-4 w-4 shrink-0 text-brand-500" /> Verifiable certificate on completion
              </li>
              <li className="flex items-center gap-2.5">
                <Wallet className="h-4 w-4 shrink-0 text-brand-500" /> Pay with Telebirr, CBE Birr &amp; 18+ banks
              </li>
              <li className="flex items-center gap-2.5">
                <Clock className="h-4 w-4 shrink-0 text-brand-500" /> 7-day refund window
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
