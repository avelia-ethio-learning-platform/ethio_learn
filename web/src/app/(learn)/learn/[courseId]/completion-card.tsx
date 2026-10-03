'use client';

import { useQuery } from '@tanstack/react-query';
import { Award, Download, ExternalLink, Trophy } from 'lucide-react';
import { api } from '@/lib/api';

interface Certificate {
  id: string;
  course_id: string;
  verify_url: string;
}

/**
 * Shown once the course is completed: the certificate when there is one,
 * otherwise what is still missing. Says nothing until `/me/certificates` has
 * answered, so a slow or failed request never reads as "no certificate yet".
 */
export function CompletionCard({ courseId }: { courseId: string }) {
  const { data: certificates } = useQuery({ queryKey: ['certificates'], queryFn: () => api<Certificate[]>('/me/certificates') });
  if (!certificates) return null;
  const certificate = certificates.find((c) => c.course_id === courseId);

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
                const res = await api<{ url: string }>(`/me/certificates/${certificate.id}/download`);
                window.open(res.url, '_blank');
              }}
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Download
            </button>
          </div>
        </>
      ) : (
        <p className="flex items-start gap-2 text-gray-600">
          <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
          <span>
            You&apos;ve finished the lessons. Pass the remaining assessments to get your certificate.{' '}
            <a href="#assessments" className="font-semibold text-brand-600 hover:underline">
              Go to assessments
            </a>
          </span>
        </p>
      )}
    </div>
  );
}
