/** Pure rules for the public course page, kept out of the components so they can be tested. */

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

export const BUY_BULLET_TEXT: Record<BuyBullet, string> = {
  certificate: 'Verifiable certificate on completion',
  payment: 'Pay with Telebirr, CBE Birr & 18+ banks',
  refund: '7-day refund window',
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
