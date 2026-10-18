import { describe, expect, it } from 'vitest';
import { BAND_COLORS, COURSE_CATEGORIES, GROUP_COLORS, categoryLabel, categoryMeta, hasRealThumbnail } from './categories';
import { am } from './i18n-am';

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
      expect(categoryMeta(v).am).toBe((am as Record<string, string>)[`cat_${v}`]);
    }
  });
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('cover contrast', () => {
  it('keeps white text at or above 4.5:1 on every group colour', () => {
    for (const [group, color] of Object.entries(GROUP_COLORS)) {
      const ratio = 1.05 / (luminance(color) + 0.05);
      expect(ratio, group).toBeGreaterThanOrEqual(4.5);
    }
  });
});
