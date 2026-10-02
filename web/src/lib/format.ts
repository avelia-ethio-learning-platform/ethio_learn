export type FormatLocale = 'en' | 'am';

const INTL_LOCALE: Record<FormatLocale, string> = { en: 'en-GB', am: 'am-ET' };

/** Takes the locale as a parameter so it works outside React (server and tests). */
export function formatDate(
  d: string | number | Date,
  locale: FormatLocale,
  style: 'date' | 'datetime' = 'date',
): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions =
    style === 'datetime'
      ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], opts).format(date);
}

/** Digit grouping plus an "ETB" suffix (not `currency: 'ETB'`, which browsers render as ETB or Br inconsistently). */
export function formatETB(amount: number, locale: FormatLocale): string {
  const n = new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 2 }).format(amount);
  return `${n} ETB`;
}
