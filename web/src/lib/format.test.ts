import { describe, expect, it } from 'vitest';
import { formatDate, formatETB } from './format';

const D = '2026-03-05T14:30:00Z';

describe('formatDate', () => {
  it('uses day-month order in en', () => {
    const s = formatDate(D, 'en');
    expect(s).toMatch(/^5 Mar 2026$/);
  });

  it('includes the time for datetime', () => {
    expect(formatDate(D, 'en', 'datetime')).toMatch(/5 Mar 2026.*\d{2}:\d{2}/);
  });

  it('formats am through am-ET', () => {
    const expected = new Intl.DateTimeFormat('am-ET', { day: 'numeric', month: 'short', year: 'numeric' }).format(
      new Date(D),
    );
    expect(formatDate(D, 'am')).toBe(expected);
    expect(formatDate(D, 'am')).not.toBe(formatDate(D, 'en'));
  });

  it('accepts Date and returns an empty string for an invalid date', () => {
    expect(formatDate(new Date(D), 'en')).toBe(formatDate(D, 'en'));
    expect(formatDate('nope', 'en')).toBe('');
  });
});

describe('formatETB', () => {
  it('groups digits and adds the ETB suffix in en', () => {
    expect(formatETB(1234567, 'en')).toBe('1,234,567 ETB');
    expect(formatETB(0, 'en')).toBe('0 ETB');
    expect(formatETB(99.5, 'en')).toBe('99.5 ETB');
  });

  it('keeps the suffix in am', () => {
    expect(formatETB(1500, 'am')).toMatch(/1.?500 ETB$/);
  });
});
