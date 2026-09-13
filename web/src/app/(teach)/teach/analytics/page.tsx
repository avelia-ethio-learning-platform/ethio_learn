'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Star, TrendingUp, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageHeader, PageShell } from '@/components/PageChrome';
import { Bars } from '@/components/Bars';


function AnalyticsPage() {
  const { data: courses } = useQuery({ queryKey: ['own-courses'], queryFn: () => api<any[]>('/courses') });
  const ids = useMemo(() => (courses ?? []).map((c) => c.id), [courses]);
  const { data: revenue } = useQuery({ queryKey: ['payee-analytics'], queryFn: () => api<any>('/payouts/analytics') });
  const { data: funnel } = useQuery({
    queryKey: ['enrollment-analytics', ids.join(',')],
    queryFn: () => api<any[]>(`/enrollments/analytics?course_ids=${ids.join(',')}`),
    enabled: ids.length > 0,
  });

  const totals = useMemo(() => {
    const f = funnel ?? [];
    return {
      enrolled: f.reduce((s, c) => s + c.enrolled, 0),
      completed: f.reduce((s, c) => s + c.completed, 0),
      active7: f.reduce((s, c) => s + c.active_last_7d, 0),
    };
  }, [funnel]);

  const stats = [
    { icon: TrendingUp, label: 'Revenue (gross)', value: `${revenue?.total_gross_etb ?? 0} ETB`, hint: `net ${revenue?.total_net_etb ?? 0} ETB after the 20% platform fee` },
    { icon: Users, label: 'Learners enrolled', value: totals.enrolled, hint: `${totals.active7} active in the last 7 days` },
    { icon: Star, label: 'Completion rate', value: totals.enrolled ? `${Math.round((totals.completed / totals.enrolled) * 100)}%` : '—', hint: `${totals.completed} finished` },
  ];

  return (
    <PageShell>
      <BackButton fallback="/teach" label="Educator dashboard" />
      <PageHeader
        badge={
          <span className="section-badge">
            <BarChart3 className="h-4 w-4 text-brand-500" /> Analytics
          </span>
        }
        title="How your courses are doing"
        subtitle="Revenue, enrollments, completion and engagement — per course and over the last 12 months."
      />
      <div className="space-y-8">
        <section className="grid gap-4 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label} className="card">
              <div className="flex items-start justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{s.label}</p>
                <span className="glass-secondary flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
                  <s.icon className="h-4 w-4 text-brand-600" />
                </span>
              </div>
              <p className="gradient-text-blue mt-2 text-3xl font-extrabold">{s.value}</p>
              <p className="mt-1 text-xs text-gray-400">{s.hint}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="card">
            <p className="text-sm font-bold text-foreground">Revenue by month (ETB)</p>
            {revenue ? <Bars data={revenue.by_month.map((m: any) => ({ label: m.month, value: m.gross_etb }))} /> : <div className="skeleton mt-3 h-36" />}
          </div>
          <div className="card">
            <p className="text-sm font-bold text-foreground">New enrollments by month</p>
            {funnel ? (
              <Bars
                data={(funnel[0]?.enrollments_by_month ?? []).map((m: any, i: number) => ({
                  label: m.month,
                  value: funnel.reduce((s, c) => s + (c.enrollments_by_month[i]?.count ?? 0), 0),
                }))}
              />
            ) : (
              <div className="skeleton mt-3 h-36" />
            )}
          </div>
        </section>

        <section className="card !p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th className="px-5 py-3">Course</th>
                <th className="px-3 py-3 text-right">Enrolled</th>
                <th className="px-3 py-3 text-right">Completed</th>
                <th className="px-3 py-3 text-right">Avg progress</th>
                <th className="px-3 py-3 text-right">Active 30d</th>
                <th className="px-3 py-3 text-right">Never started</th>
                <th className="px-3 py-3 text-right">Rating</th>
                <th className="px-5 py-3 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {(funnel ?? []).map((c) => {
                const course = courses?.find((x) => x.id === c.course_id);
                const rev = revenue?.by_course?.find((r: any) => r.course_id === c.course_id);
                return (
                  <tr key={c.course_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="px-5 py-3 font-medium text-foreground">{c.course_title}</td>
                    <td className="px-3 py-3 text-right">{c.enrolled}</td>
                    <td className="px-3 py-3 text-right">
                      {c.completed} <span className="text-xs text-gray-400">({c.completion_rate}%)</span>
                    </td>
                    <td className="px-3 py-3 text-right">{c.avg_progress_percent}%</td>
                    <td className="px-3 py-3 text-right">{c.active_last_30d}</td>
                    <td className="px-3 py-3 text-right">{c.never_started}</td>
                    <td className="px-3 py-3 text-right">{course?.rating_avg ? `★ ${Number(course.rating_avg).toFixed(1)} (${course.rating_count})` : '—'}</td>
                    <td className="px-5 py-3 text-right">{rev ? `${rev.gross_etb} ETB` : '0 ETB'}</td>
                  </tr>
                );
              })}
              {!funnel?.length && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-gray-400">
                    Publish a course to see analytics here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </PageShell>
  );
}

export default function TeachAnalyticsPage() {
  return (
    <RequireRole roles={['educator', 'institution_admin']}>
      <AnalyticsPage />
    </RequireRole>
  );
}
