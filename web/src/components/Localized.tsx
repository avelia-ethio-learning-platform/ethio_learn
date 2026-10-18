'use client';

import { categoryMeta } from '@/lib/categories';
import { formatDate, formatETB } from '@/lib/format';
import { useT, type TKey, type Vars } from '@/lib/i18n';
import { en } from '@/lib/i18n-en';
import { sentenceCase } from '@/lib/labels';

// Values a server component renders in the reader's language: English in the
// server HTML, switched after hydration like <T> (lib/i18n.tsx).

/** A course's price: "Free", "Freemium · 300 ETB" or "300 ETB". */
export function PriceLabel({ pricingType, priceEtb }: { pricingType: string; priceEtb: number | null | undefined }) {
  const { t, locale } = useT();
  if (pricingType === 'free') return <>{t('free')}</>;
  const price = priceEtb == null ? '— ETB' : formatETB(priceEtb, locale);
  return <>{pricingType === 'freemium' ? `${t('freemium')} · ${price}` : price}</>;
}

/** A category's name (its Amharic name from lib/categories in Amharic mode). */
export function CategoryName({ value }: { value: string | null | undefined }) {
  const { locale } = useT();
  const meta = categoryMeta(value);
  return <>{locale === 'am' ? meta.am : meta.label}</>;
}

/** `t(prefix + value)` when the dictionaries have that key, else `fallback` (an API value without a curated word). */
export function keyed(t: (k: TKey, vars?: Vars) => string, prefix: string, value: string, fallback: string): string {
  const key = prefix + value;
  return key in en ? t(key as TKey) : fallback;
}

/** A lifecycle status in words (StatusBadge). */
export function StatusName({ status }: { status: string }) {
  const { t } = useT();
  return <>{keyed(t, 'status_', status, sentenceCase(status))}</>;
}

/** A date. */
export function LocalDate({ iso }: { iso: string }) {
  const { locale } = useT();
  return <>{formatDate(iso, locale)}</>;
}
