import { describe, expect, it } from 'vitest';
import { BAND_COLORS, COURSE_CATEGORIES, GROUP_COLORS, categoryLabel, categoryMeta, hasRealThumbnail } from './categories';
import { dictionaries } from './i18n';

describe('hasRealThumbnail', () => {
  it('is false for no thumbnail', () => {
    expect(hasRealThumbnail(null)).toBe(false);
    expect(hasRealThumbnail(undefined)).toBe(false);
    expect(hasRealThumbnail('')).toBe(false);
  });
  it('is false for the placehold.co placeholder the demo seed writes', () => {
    expect(hasRealThumbnail('https://placehold.co/640x360/2563eb/white?text=Intro')).toBe(false);
  });
  it('is true for a real upload', () => {
    expect(hasRealThumbnail('https://cdn.example.com/thumbs/a.jpg')).toBe(true);
  });
});

describe('category data', () => {
  it('gives every category a group with a colour and an Amharic label', () => {
    for (const c of COURSE_CATEGORIES) {
      expect(GROUP_COLORS[c.group], c.value).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.am.trim(), c.value).not.toBe('');
    }
    expect(BAND_COLORS.length).toBeGreaterThan(1);
  });
  it('falls back to the other entry for an unknown or missing value', () => {
    const other = COURSE_CATEGORIES.find((c) => c.value === 'other');
    expect(categoryMeta('not_a_category')).toBe(other);
    expect(categoryMeta(null)).toBe(other);
    expect(categoryLabel('not_a_category')).toBe('Other');
  });
  it('matches the i18n pill strings for the five cat_* values', () => {
    for (const v of ['tech', 'business', 'freelancing', 'healthcare', 'other']) {
      expect(categoryMeta(v).am).toBe((dictionaries.am as Record<string, string>)[`cat_${v}`]);
    }
  });
});
