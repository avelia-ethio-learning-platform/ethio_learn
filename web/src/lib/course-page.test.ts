import { describe, expect, it } from 'vitest';
import { buyBullets, hasPlayablePreview, sectionHasPreview } from './course-page';

const section = (is_free_preview: boolean, ...videos: boolean[]) => ({
  is_free_preview,
  lessons: videos.map((has_video) => ({ has_video })),
});

describe('buyBullets', () => {
  it('free courses promise only the certificate: no payment or refund lines', () => {
    expect(buyBullets('free')).toEqual(['certificate']);
  });

  it.each(['paid', 'freemium'])('%s courses add the payment methods and the refund window', (type) => {
    expect(buyBullets(type)).toEqual(['certificate', 'payment', 'refund']);
  });
});

describe('free preview rule', () => {
  it('needs a free-preview section with a lesson that has a video', () => {
    expect(hasPlayablePreview([section(false, true), section(true, false, true)])).toBe(true);
  });

  it('is off when the free section has no video, or no section is free', () => {
    expect(hasPlayablePreview([section(true, false), section(true)])).toBe(false);
    expect(hasPlayablePreview([section(false, true)])).toBe(false);
    expect(hasPlayablePreview([])).toBe(false);
  });

  it('marks only sections that can play', () => {
    expect(sectionHasPreview(section(true, true))).toBe(true);
    expect(sectionHasPreview(section(true, false))).toBe(false);
    expect(sectionHasPreview(section(false, true))).toBe(false);
  });
});
