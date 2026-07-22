import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '@/lib/server-api';
import { BackButton } from '@/components/BackButton';

export const metadata: Metadata = {
  title: 'Top educators',
  description: 'The highest-rated educators on EthiopiaLearn, ranked by the total ratings their courses have earned from learners.',
  alternates: { canonical: '/educators' },
};

interface TopEducator {
  educator_id: string;
  name: string;
  course_count: number;
  total_rating_points: number;
  rating_count: number;
  average_rating: number | null;
  learner_count: number;
}

export const revalidate = 120;

export default async function EducatorsPage() {
  const educators = (await serverApi<TopEducator[]>('/educators/top?limit=24', 120)) ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <BackButton fallback="/" label="Browse courses" />
      <h1 className="text-3xl font-bold">🏆 Top educators</h1>
      <p className="mt-2 text-gray-600">
        Ranked by total rating points — every star a learner gives any of their courses counts, so consistent quality
        across many happy learners rises to the top.
      </p>

      <ol className="mt-6 space-y-3">
        {educators.map((e, i) => (
          <li key={e.educator_id}>
            <Link
              href={`/educators/${e.educator_id}`}
              className="card flex items-center gap-4 transition hover:shadow-md"
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-bold ${
                  i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-gray-200 text-gray-600' : i === 2 ? 'bg-orange-100 text-orange-700' : 'bg-gray-50 text-gray-400'
                }`}
              >
                {i + 1}
              </span>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold text-brand-800">
                {e.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{e.name}</p>
                <p className="text-sm text-gray-500">
                  {e.course_count} course{e.course_count !== 1 ? 's' : ''}
                  {e.learner_count > 0 ? ` · ${e.learner_count} learner${e.learner_count !== 1 ? 's' : ''}` : ''}
                </p>
              </div>
              <div className="shrink-0 text-right">
                {e.average_rating != null ? (
                  <>
                    <p className="font-semibold text-amber-600">★ {e.average_rating}</p>
                    <p className="text-xs text-gray-400">{e.total_rating_points} pts · {e.rating_count} rating{e.rating_count !== 1 ? 's' : ''}</p>
                  </>
                ) : (
                  <p className="text-xs text-gray-300">not yet rated</p>
                )}
              </div>
            </Link>
          </li>
        ))}
        {educators.length === 0 && (
          <li className="card text-center text-gray-500">No published educators yet.</li>
        )}
      </ol>
    </div>
  );
}
