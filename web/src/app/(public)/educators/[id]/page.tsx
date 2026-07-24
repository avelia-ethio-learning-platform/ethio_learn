import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import { CourseCard, CourseSummary } from '@/components/CourseCard';
import { BackButton } from '@/components/BackButton';
import { MessageEducatorButton } from './message-button';
import { FollowInstructorButton } from './follow-button';

interface EducatorProfile {
  educator_id: string;
  name: string;
  bio: string | null;
  expertise_area: string | null;
  course_count: number;
  total_rating_points: number;
  rating_count: number;
  average_rating: number | null;
  learner_count: number;
  courses: CourseSummary[];
}

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const profile = await serverApi<EducatorProfile>(`/educators/${params.id}/profile`, 120);
  if (!profile) return { title: 'Educator not found' };
  return {
    title: `${profile.name} — educator profile`,
    description: `${profile.course_count} courses on EthiopiaLearn${profile.average_rating ? ` · rated ★ ${profile.average_rating}` : ''}`,
    alternates: { canonical: `/educators/${params.id}` },
  };
}

export const revalidate = 120;

export default async function EducatorProfilePage({ params }: { params: { id: string } }) {
  const profile = await serverApi<EducatorProfile>(`/educators/${params.id}/profile`, 120);
  if (!profile) notFound();

  return (
    <div>
      <BackButton fallback="/educators" label="Top educators" />
      <div className="card flex flex-wrap items-center gap-5">
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-100 text-3xl font-bold text-brand-800">
          {profile.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{profile.name}</h1>
          {profile.expertise_area && <p className="text-sm text-brand-700">{profile.expertise_area}</p>}
          {profile.bio && <p className="mt-1 max-w-2xl text-sm text-gray-600">{profile.bio}</p>}
          <p className="mt-2 text-sm text-gray-500">
            {profile.course_count} course{profile.course_count !== 1 ? 's' : ''}
            {profile.learner_count > 0 ? ` · ${profile.learner_count} learners` : ''}
            {profile.average_rating != null ? (
              <span className="text-amber-600"> · ★ {profile.average_rating} ({profile.rating_count} ratings · {profile.total_rating_points} pts)</span>
            ) : (
              ' · not yet rated'
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <FollowInstructorButton instructorId={profile.educator_id} />
          <MessageEducatorButton educatorId={profile.educator_id} />
        </div>
      </div>

      <h2 className="mt-8 text-xl font-semibold">Courses by {profile.name}</h2>
      <div className="mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {profile.courses.map((c) => (
          <CourseCard key={c.id} course={c} />
        ))}
      </div>
    </div>
  );
}
