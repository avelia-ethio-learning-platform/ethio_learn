import type { Metadata } from 'next';
import { serverApi } from '@/lib/server-api';

interface Verification {
  valid: boolean;
  course_title?: string;
  learner_name?: string;
  educator_name?: string;
  issued_at?: string;
  trust_tier?: string;
  assessment_badges?: string[];
}

export const metadata: Metadata = {
  title: 'Certificate verification',
  description: 'Verify the authenticity of an EthiopiaLearn certificate.',
  robots: { index: false },
};

/** Public, unauthenticated verification page (spec §11.7) — QR codes land here. */
export default async function VerifyPage({ params }: { params: { uid: string } }) {
  const result = (await serverApi<Verification>(`/verify/${params.uid}`, 0)) ?? { valid: false };

  return (
    <div className="card mx-auto max-w-lg text-center">
      {result.valid ? (
        <>
          <p className="text-4xl">✅</p>
          <h1 className="mt-2 text-2xl font-bold text-green-700">Valid certificate</h1>
          <dl className="mt-6 space-y-3 text-left">
            <div>
              <dt className="text-xs uppercase text-gray-500">Learner</dt>
              <dd className="text-lg font-semibold">{result.learner_name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Course</dt>
              <dd className="text-lg">{result.course_title}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Educator / Institution</dt>
              <dd>
                {result.educator_name || '—'}{' '}
                <span className="ml-1 rounded bg-brand-100 px-2 py-0.5 text-xs capitalize text-brand-800">
                  {result.trust_tier} tier
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Issued</dt>
              <dd>{result.issued_at ? new Date(result.issued_at).toDateString() : '—'}</dd>
            </div>
            {result.assessment_badges && result.assessment_badges.length > 0 && (
              <div>
                <dt className="text-xs uppercase text-gray-500">Assessments passed</dt>
                <dd className="capitalize">{result.assessment_badges.join(', ').replace(/_/g, ' ')}</dd>
              </div>
            )}
          </dl>
          <p className="mt-6 text-xs text-gray-400">Certificate ID: {params.uid}</p>
        </>
      ) : (
        <>
          <p className="text-4xl">❌</p>
          <h1 className="mt-2 text-2xl font-bold text-red-700">Not a valid certificate</h1>
          <p className="mt-2 text-sm text-gray-600">
            This certificate ID does not exist, has been invalidated, or failed the tamper check.
          </p>
        </>
      )}
    </div>
  );
}
