import type { Metadata } from 'next';
import { BadgeCheck, ShieldX } from 'lucide-react';
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
    <div className="page-shell flex min-h-[70vh] items-center justify-center">
      <div className="card w-full max-w-lg animate-fade-in-up overflow-hidden !rounded-3xl !p-0 text-center shadow-elevated">
        <span className={`block h-1.5 w-full ${result.valid ? 'gradient-ethiopia' : 'bg-red-500/60'}`} />
        <div className="p-8 sm:p-10">
          {result.valid ? (
            <>
              <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-500">
                <BadgeCheck className="h-8 w-8" />
              </span>
              <h1 className="text-2xl font-extrabold tracking-tight text-emerald-600 dark:text-emerald-400">Valid certificate</h1>
              <dl className="mt-8 space-y-4 text-left">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500">Learner</dt>
                  <dd className="mt-0.5 text-lg font-bold text-foreground">{result.learner_name}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500">Course</dt>
                  <dd className="mt-0.5 text-lg text-foreground">{result.course_title}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500">Educator / Institution</dt>
                  <dd className="mt-0.5 flex flex-wrap items-center gap-2 text-foreground">
                    {result.educator_name || '—'}
                    <span className="badge-info capitalize">{result.trust_tier} tier</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500">Issued</dt>
                  <dd className="mt-0.5 text-foreground">{result.issued_at ? new Date(result.issued_at).toDateString() : '—'}</dd>
                </div>
                {result.assessment_badges && result.assessment_badges.length > 0 && (
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-gray-500">Assessments passed</dt>
                    <dd className="mt-0.5 capitalize text-foreground">{result.assessment_badges.join(', ').replace(/_/g, ' ')}</dd>
                  </div>
                )}
              </dl>
              <p className="mt-8 break-all text-xs text-gray-400">Certificate ID: {params.uid}</p>
            </>
          ) : (
            <>
              <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/15 text-red-500">
                <ShieldX className="h-8 w-8" />
              </span>
              <h1 className="text-2xl font-extrabold tracking-tight text-red-500">Not a valid certificate</h1>
              <p className="mt-3 text-sm leading-relaxed text-gray-500">
                This certificate ID does not exist, has been invalidated, or failed the tamper check.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
