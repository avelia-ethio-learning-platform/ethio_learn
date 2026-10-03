import { afterEach, describe, expect, it, vi } from 'vitest';
import { buyBullets, findPrimaryAction, hasPlayablePreview, scrollBehavior, sectionHasPreview } from './course-page';

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

describe('findPrimaryAction (bottom bar target)', () => {
  const box = (html: string) => {
    const el = document.createElement('aside');
    el.innerHTML = html;
    return el;
  };

  it('returns the marked action with its own label and kind', () => {
    const found = findPrimaryAction(box('<button data-primary-action="enroll"><svg></svg> Buy with Chapa</button>'));
    expect(found?.label).toBe('Buy with Chapa');
    expect(found?.kind).toBe('enroll');
  });

  it('reports "continue" for an enrolled viewer', () => {
    expect(findPrimaryAction(box('<button data-primary-action="continue">Continue learning</button>'))?.kind).toBe('continue');
  });

  it('ignores unmarked buttons such as the gift submit, so a non-learner has no target', () => {
    expect(findPrimaryAction(box('<button class="btn" disabled>Pay 300 ETB with Chapa</button>'))).toBeNull();
  });

  it('is hidden when the marked action is disabled (payment in progress)', () => {
    expect(findPrimaryAction(box('<button data-primary-action="enroll" disabled>Please wait…</button>'))).toBeNull();
  });

  it('is null without a box', () => {
    expect(findPrimaryAction(null)).toBeNull();
  });
});

describe('scrollBehavior', () => {
  const stub = (matches: boolean) => vi.stubGlobal('matchMedia', () => ({ matches }));
  afterEach(() => vi.unstubAllGlobals());

  it('is smooth by default and auto under reduced motion', () => {
    stub(false);
    expect(scrollBehavior()).toBe('smooth');
    stub(true);
    expect(scrollBehavior()).toBe('auto');
  });
});
