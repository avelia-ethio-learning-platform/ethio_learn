'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { EmptyRows } from '@/components/EmptyRows';
import { PanelError } from '@/components/PanelError';
import { assessmentTypeLabel } from '@/lib/labels';
import { formatDate } from '@/lib/format';
import { useT } from '@/lib/i18n';

const LIMIT = 50;

interface AttemptRow {
  attempt_id: string;
  assessment_type?: string;
  proctored?: boolean;
  learner_name?: string | null;
  score: number | null;
  passed: boolean | null;
  flagged: boolean;
  terminated: boolean;
  violation_count: number;
  submitted_at: string | null;
}

interface ProctorReport {
  termination_reason: string | null;
  events: Array<{ type: string; description: string; at: string; screenshot_url: string | null }>;
}

/** Educator: every submitted or flagged attempt on the course, with the proctor report for proctored ones. */
export function ExamResults({ courseId }: { courseId: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const { data, isError, refetch } = useQuery({
    queryKey: ['course-attempts', courseId, page],
    queryFn: () => api<AttemptRow[] | { items: AttemptRow[] }>(`/courses/${courseId}/attempts?page=${page}&limit=${LIMIT}`),
    enabled: open,
  });

  // The endpoint answers an array (the whole list, or one page once it is paged) or { items }.
  const all = Array.isArray(data) ? data : (data?.items ?? []);
  const whole = all.length > LIMIT;
  const rows = whole ? all.slice((page - 1) * LIMIT, page * LIMIT) : all;
  const hasMore = whole ? page * LIMIT < all.length : all.length === LIMIT;

  return (
    <div className="card">
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ClipboardList className="h-5 w-5 text-brand-600" /> Exam results
        </h2>
        <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-3">
          {isError ? (
            <PanelError panel="exam results" onRetry={() => refetch()} />
          ) : !data ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : !rows.length ? (
            <EmptyRows label="No submitted attempts yet." />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-gray-500">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Learner</th>
                      <th className="py-1.5 pr-3 font-medium">Type</th>
                      <th className="py-1.5 pr-3 font-medium">Score</th>
                      <th className="py-1.5 pr-3 font-medium">Result</th>
                      <th className="py-1.5 pr-3 font-medium">Flags</th>
                      <th className="py-1.5 font-medium">Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <ResultRow key={r.attempt_id} row={r} />
                    ))}
                  </tbody>
                </table>
              </div>
              {(page > 1 || hasMore) && (
                <div className="mt-3 flex items-center justify-between gap-2 text-sm text-gray-500">
                  <p role="status">Page {page}</p>
                  <div className="flex gap-2">
                    <button type="button" className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      Previous
                    </button>
                    <button type="button" className="btn-secondary btn-sm" disabled={!hasMore} onClick={() => setPage(page + 1)}>
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ResultRow({ row: r }: { row: AttemptRow }) {
  const { locale } = useT();
  const [showReport, setShowReport] = useState(false);
  const report = useQuery({
    queryKey: ['proctor-report', r.attempt_id],
    queryFn: () => api<ProctorReport>(`/attempts/${r.attempt_id}/proctor-report`),
    enabled: showReport,
  });
  const flags = [r.flagged && 'Flagged', r.terminated && 'Terminated', r.violation_count > 0 && `${r.violation_count} violation${r.violation_count === 1 ? '' : 's'}`].filter(Boolean);
  return (
    <>
      <tr className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
        <td className="py-2 pr-3">{r.learner_name || 'Learner'}</td>
        <td className="py-2 pr-3">{r.assessment_type ? assessmentTypeLabel(r.assessment_type) : '—'}</td>
        <td className="py-2 pr-3">{r.score ?? '—'}</td>
        <td className="py-2 pr-3">{r.passed == null ? '—' : r.passed ? <span className="badge-success">Passed</span> : <span className="badge-warn">Not passed</span>}</td>
        <td className="py-2 pr-3">
          {flags.length ? <span className="badge-danger">{flags.join(' · ')}</span> : '—'}
          {r.proctored && (
            <button type="button" className="mt-1 block text-xs font-medium text-brand-600 hover:underline" aria-expanded={showReport} onClick={() => setShowReport((s) => !s)}>
              Proctor report
            </button>
          )}
        </td>
        <td className="py-2">{r.submitted_at ? formatDate(r.submitted_at, locale, 'datetime') : '—'}</td>
      </tr>
      {showReport && (
        <tr>
          <td colSpan={6} className="pb-3">
            {report.isError ? (
              <PanelError panel="proctor report" onRetry={() => report.refetch()} />
            ) : !report.data ? (
              <p className="text-xs text-gray-500">Loading…</p>
            ) : (
              <div className="glass-secondary rounded-xl px-4 py-3 text-xs">
                {report.data.termination_reason && <p className="font-medium text-danger">Terminated: {report.data.termination_reason}</p>}
                {!report.data.events.length ? (
                  <p className="text-gray-500">No events recorded.</p>
                ) : (
                  <ul className="space-y-1">
                    {report.data.events.map((e, i) => (
                      <li key={i} className="flex flex-wrap gap-x-2">
                        <span className="text-gray-500">{formatDate(e.at, locale, 'datetime')}</span>
                        <span>{e.description || e.type}</span>
                        {e.screenshot_url && (
                          <a className="font-medium text-brand-600 hover:underline" href={e.screenshot_url} target="_blank" rel="noreferrer">
                            Snapshot
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
