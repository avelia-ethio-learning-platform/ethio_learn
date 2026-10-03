import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { BadgeCheck, Clock, Globe, Layers, PlayCircle, Star, UserRound, Wallet } from 'lucide-react';
import { serverApi, SITE_URL } from '@/lib/server-api';
import { categoryLabel, hasRealThumbnail } from '@/lib/categories';
import { BUY_BULLET_TEXT, buyBullets, hasPlayablePreview, sectionHasPreview, type BuyBullet } from '@/lib/course-page';
import { priceLabel } from '@/components/CourseCard';
import { CourseCover } from '@/components/CourseCover';
import { ExpandableSummary } from '@/components/ExpandableSummary';
import { MobileBuyBar } from '@/components/MobileBuyBar';
import { CoursePreviewPlayer } from '@/components/CoursePreviewPlayer';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';
import { WakingUp } from '@/components/WakingUp';
import { EnrollPanel } from './enroll-panel';
import { jsonLdScript } from '@/lib/json-ld';
import { formatDate } from '@/lib/format';

const LANGUAGES: Record<string, string> = { en: 'English', am: 'Amharic' };

interface CourseDetail {
  last_major_update_at?: string | null;
  id: string;
  title: string;
  description: string;
  category: string;
  language?: string | null;
  instructor_id?: string | null;
  instructor_name?: string | null;
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
  const result = await serverApi<CourseDetail>(`/courses/${params.id}`, 300);
  if (!result.ok) {
    return result.status === 404 ? { title: 'Course not found' } : { title: 'Waking up the server', robots: { index: false } };
  }
  const course = result.data;
  return {
    title: course.title,
    description: course.description.slice(0, 160),
    alternates: { canonical: `/courses/${course.id}` },
    // No `images`: opengraph-image.tsx (the file convention) supplies the card.
    openGraph: { title: course.title, description: course.description.slice(0, 200), type: 'website' },
    twitter: { card: 'summary_large_image', title: course.title, description: course.description.slice(0, 200) },
  };
}

export default async function CoursePage({ params }: { params: { id: string } }) {
  const result = await serverApi<CourseDetail>(`/courses/${params.id}`, 60);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <WakingUp />;
  }
  const course = result.data;
  // Reviews are optional: without them the page still renders.
  const reviewsResult = await serverApi<Reviews>(`/courses/${params.id}/reviews`, 60);
  const reviews = reviewsResult.ok ? reviewsResult.data : null;

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

  const facts = [
    { icon: Layers, label: `${course.sections.length} sections` },
    { icon: PlayCircle, label: `${totalLessons} lessons` },
    { icon: Clock, label: `~${totalMinutes} min` },
    ...(course.language ? [{ icon: Globe, label: LANGUAGES[course.language] ?? course.language.toUpperCase() }] : []),
    { icon: BadgeCheck, label: 'Certificate' },
    ...(reviews?.average_rating ? [{ icon: Star, label: `${reviews.average_rating} (${reviews.review_count})` }] : []),
  ];
  const price = priceLabel(course);
  const educatorName = course.instructor_name?.trim();
  const bulletIcons: Record<BuyBullet, typeof BadgeCheck> = { certificate: BadgeCheck, payment: Wallet, refund: Clock };

  return (
    <PageShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <BackButton fallback="/courses" label="Browse courses" />

      {/* One buy box, placed by grid order: right after the header below lg, the sticky right column from lg. */}
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-3">
        <header className="animate-fade-in-up min-w-0 lg:col-span-2 lg:row-start-1">
          <div className="overflow-hidden rounded-2xl">
            {hasRealThumbnail(course.thumbnail_url) ? (
              // eslint-disable-next-line @next/next/no-img-element -- next/image is Phase 10
              <img src={course.thumbnail_url} alt="" className="h-28 w-full object-cover sm:h-32" />
            ) : (
              <CourseCover title={course.title} category={course.category} size="strip" decorative />
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="badge-info uppercase tracking-wider">{categoryLabel(course.category)}</span>
            {course.last_major_update_at && Date.now() - new Date(course.last_major_update_at).getTime() < 30 * 86_400_000 && (
              <span className="badge-success">Recently updated</span>
            )}
          </div>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">{course.title}</h1>
          <ExpandableSummary text={course.description} />
          {educatorName && course.instructor_id && (
            <p className="mt-4 flex items-center gap-2 text-sm text-gray-600">
              <UserRound className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
              <span>
                By{' '}
                <Link href={`/educators/${course.instructor_id}`} className="font-semibold text-brand-600 hover:underline">
                  {educatorName}
                </Link>
              </span>
            </p>
          )}
          <ul className="mt-5 flex flex-wrap gap-2">
            {facts.map((fact) => (
              <li key={fact.label} className="section-badge !px-3 !py-1.5 !text-xs">
                <fact.icon className="h-3.5 w-3.5 text-brand-500" aria-hidden />
                {fact.label}
              </li>
            ))}
          </ul>
        </header>

        <aside id="buy-box" tabIndex={-1} className="animate-fade-in-up min-w-0 lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <div className="card sticky top-28 !rounded-3xl !p-6 shadow-elevated">
            <p className="gradient-text-blue text-3xl font-extrabold">{price}</p>
            <EnrollPanel courseId={course.id} pricingType={course.pricing_type} price={course.price_etb} />
            <ul className="mt-5 space-y-2.5 text-sm text-gray-600">
              {buyBullets(course.pricing_type).map((b) => {
                const Icon = bulletIcons[b];
                return (
                  <li key={b} className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0 text-brand-500" aria-hidden /> {BUY_BULLET_TEXT[b]}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        <div className="animate-fade-in-up min-w-0 lg:col-span-2 lg:row-start-2">
          {hasPlayablePreview(course.sections) && <CoursePreviewPlayer sections={course.sections} />}

          <h2 className="mt-10 text-xl font-bold text-foreground">Course content</h2>
          <div className="mt-4 space-y-3">
            {course.sections.map((section, idx) => (
              <div key={section.id} className="card !p-0 overflow-hidden">
                <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="glass-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-brand-600">
                    {idx + 1}
                  </span>
                  <h3 className="min-w-0 flex-1 font-semibold text-foreground">{section.title}</h3>
                  {sectionHasPreview(section) && <span className="badge-success shrink-0">Free preview</span>}
                </div>
                <ul className="px-5 py-3">
                  {section.lessons.map((lesson) => (
                    <li key={lesson.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                      <span className="inline-flex min-w-0 items-center gap-2 text-gray-600">
                        <PlayCircle className="h-4 w-4 shrink-0 text-brand-400" />
                        <span className="truncate">{lesson.title}</span>
                      </span>
                      <span className="shrink-0 text-xs text-gray-500">{Math.max(1, Math.round(lesson.duration_seconds / 60))} min</span>
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
                        <Star key={n} className={`h-4 w-4 ${n <= r.rating ? 'fill-amber-400 text-amber-400' : 'text-gray-500'}`} />
                      ))}
                    </p>
                    {r.comment && <p className="mt-2 text-sm leading-relaxed text-gray-600">{r.comment}</p>}
                    <p className="mt-2 text-xs text-gray-500">{formatDate(r.created_at, 'en')}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

      </div>

      <MobileBuyBar targetId="buy-box" price={price} />
    </PageShell>
  );
}
