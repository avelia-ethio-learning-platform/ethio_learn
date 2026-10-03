export type FormatLocale = 'en' | 'am';

/** Fixed zone: the server renders in UTC and the browser in the user's zone, which would mismatch hydration and shift dates. */
const TIME_ZONE = 'Africa/Addis_Ababa';

const INTL_LOCALE: Record<FormatLocale, string> = { en: 'en-GB', am: 'am-ET' };

type DateStyle = 'date' | 'datetime' | 'month' | 'month-year';

const STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  datetime: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE },
  date: { day: 'numeric', month: 'short', year: 'numeric', timeZone: TIME_ZONE },
  month: { month: 'short', timeZone: TIME_ZONE },
  'month-year': { month: 'long', year: 'numeric', timeZone: TIME_ZONE },
};

/** Takes the locale as a parameter so it works outside React (server and tests). */
export function formatDate(
  d: string | number | Date,
  locale: FormatLocale,
  style: DateStyle = 'date',
): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const opts = STYLES[style];
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], opts).format(date);
}

/** Digit grouping plus an "ETB" suffix (not `currency: 'ETB'`, which browsers render as ETB or Br inconsistently). */
export function formatETB(amount: number, locale: FormatLocale): string {
  const n = new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 2 }).format(amount);
  return `${n} ETB`;
}
