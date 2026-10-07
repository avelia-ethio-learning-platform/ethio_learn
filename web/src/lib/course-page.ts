/** Pure rules for the public course page, kept out of the components so they can be tested. */

import type { TKey } from './i18n-en';

export type BuyBullet = 'certificate' | 'payment' | 'refund';

interface PreviewSection {
  is_free_preview: boolean;
  lessons: { has_video: boolean }[];
}

/**
 * What the buy box promises, by pricing type. A free course has no payment or
 * refund lines; paid and freemium courses add the payment methods and the refund window.
 */
export function buyBullets(pricingType: string): BuyBullet[] {
  return pricingType === 'free' ? ['certificate'] : ['certificate', 'payment', 'refund'];
}

/** Each promise's text, in lib/i18n-en.ts and lib/i18n-am.ts. */
export const BUY_BULLET_KEY: Record<BuyBullet, TKey> = {
  certificate: 'buy_bullet_certificate',
  payment: 'buy_bullet_payment',
  refund: 'buy_bullet_refund',
};

/** A section is previewable when it is marked free and has at least one lesson with a video. */
export function sectionHasPreview(section: PreviewSection): boolean {
  return section.is_free_preview && section.lessons.some((l) => l.has_video);
}

/**
 * Whether a preview can actually play. It does not depend on the pricing type:
 * the API streams free-preview lessons for any course, to a signed-in user.
 */
export function hasPlayablePreview(sections: PreviewSection[]): boolean {
  return sections.some(sectionHasPreview);
}

export type PrimaryActionKind = 'login' | 'enroll' | 'continue';

/**
 * The buy box's real primary action: the control the enroll panel marks with
 * `data-primary-action`, if it is enabled. Gift and ask-to-pay forms are never
 * marked, so they are never the target.
 */
export function findPrimaryAction(box: ParentNode | null): { el: HTMLElement; label: string; kind: PrimaryActionKind } | null {
  const el = box?.querySelector<HTMLElement>('[data-primary-action]');
  if (!el || (el as HTMLButtonElement).disabled) return null;
  const label = el.textContent?.trim() ?? '';
  if (!label) return null;
  return { el, label, kind: el.dataset.primaryAction as PrimaryActionKind };
}

/** Smooth scrolling unless the viewer asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
