'use client';

import { formatDate } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { EmptyRows } from './EmptyRows';

/** "1.2K": the drawn value must not force the column wider; the screen-reader text keeps the full figure. */
const compact = (v: number, locale: string) => new Intl.NumberFormat(locale === 'am' ? 'am-ET' : 'en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

/**
 * Tiny dependency-free bar chart (CSS only). Each `label` is a "YYYY-MM" month.
 * Months and values are drawn; a screen reader gets "October 2026: 1,200 ETB" per month.
 */
export function Bars({
  data,
  format = (v: number) => String(v),
  title = 'Chart',
  empty = 'Nothing to show yet',
}: {
  data: { label: string; value: number }[];
  format?: (v: number) => string;
  /** The chart's accessible name. */
  title?: string;
  /** Shown instead of bars when every value is zero. */
  empty?: string;
}) {
  const { locale } = useT();
  if (data.every((d) => d.value <= 0)) return <EmptyRows label={empty} />;
  const max = Math.max(...data.map((d) => d.value));
  return (
    <ul aria-label={title} className="flex h-36 items-stretch gap-1.5">
      {data.map((d) => {
        const first = new Date(`${d.label}-01T00:00:00Z`);
        const month = formatDate(first, locale, 'month');
        return (
          <li key={d.label} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.label}: ${format(d.value)}`}>
            <span className="sr-only">
              {formatDate(first, locale, 'month-year')}: {format(d.value)}
            </span>
            <span aria-hidden="true" className="h-4 whitespace-nowrap text-xs font-semibold text-gray-600 dark:text-gray-400">
              {d.value > 0 ? compact(d.value, locale) : ''}
            </span>
            <div aria-hidden="true" className="flex w-full flex-1 items-end">
              {d.value > 0 && <div className="w-full rounded-t-md bg-brand-500/80" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />}
            </div>
            <span aria-hidden="true" className="text-xs leading-tight text-gray-500">
              {month}
              {d.label.endsWith('-01') && <span className="block text-center">{d.label.slice(0, 4)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
