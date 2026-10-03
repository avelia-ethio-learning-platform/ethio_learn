'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, Download, ExternalLink, Trophy } from 'lucide-react';
import { api } from '@/lib/api';

interface AssessmentSummary {
  id: string;
  is_required: boolean;
}

interface Certificate {
  id: string;
  course_id: string;
  verify_url: string;
}

// Certificates are issued asynchronously after completion: poll every 5 s for about 2 minutes.
const POLL_MS = 5000;
const MAX_POLLS = 24;

/**
 * Shown once the course is completed: the certificate when there is one,
 * otherwise what is still missing. Says nothing until `/me/certificates` has
 * answered, so a slow or failed request never reads as "no certificate yet".
 */
export function CompletionCard({ courseId }: { courseId: string }) {
  const { data: certificates } = useQuery({
    queryKey: ['certificates'],
    queryFn: () => api<Certificate[]>('/me/certificates'),
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.course_id === courseId) || query.state.dataUpdateCount >= MAX_POLLS ? false : POLL_MS,
  });
  // Same keys as the assessments panel, so these share its requests.
  const { data: assessments } = useQuery({ queryKey: ['assessments', courseId], queryFn: () => api<AssessmentSummary[]>(`/assessments?course_id=${courseId}`) });
  const { data: attempts } = useQuery({ queryKey: ['attempts', courseId], queryFn: () => api<any[]>(`/attempts/mine?course_id=${courseId}`) });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  if (!certificates) return null;
  const certificate = certificates.find((c) => c.course_id === courseId);
  // Both lists must be loaded: with attempts still loading, every assessment would look unpassed.
  const assessmentsLeft = !!attempts && !!assessments?.some((a) => a.is_required && !attempts.some((t) => t.assessment_id === a.id && t.passed));

  return (
    <div className="card mt-4 !p-4 text-sm">
      {certificate ? (
        <>
          <p className="flex items-center gap-2 font-semibold text-foreground">
            <Award className="h-4 w-4 text-brand-600" aria-hidden /> You&apos;ve completed this course
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <a className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline" href={certificate.verify_url}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> View certificate
            </a>
            <button
              type="button"
              className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
              onClick={async () => {
                setDownloadError(null);
                try {
                  const res = await api<{ url: string }>(`/me/certificates/${certificate.id}/download`);
                  window.open(res.url, '_blank');
                } catch {
                  setDownloadError('Could not start the download. Please try again.');
                }
              }}
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Download
            </button>
          </div>
          {downloadError && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {downloadError}
            </p>
          )}
        </>
      ) : (
        <p className="flex items-start gap-2 text-gray-600">
          <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
          {assessmentsLeft ? (
            <span>
              You&apos;ve finished the lessons. Pass the remaining assessments to get your certificate.{' '}
              <a href="#assessments" className="font-semibold text-brand-600 hover:underline">
                Go to assessments
              </a>
            </span>
          ) : (
            <span>Your certificate is being prepared…</span>
          )}
        </p>
      )}
    </div>
  );
}
