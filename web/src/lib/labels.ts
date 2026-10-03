import { COURSE_CATEGORIES } from './categories';

/** `under_review` -> `Under review`. The fallback for any value without a curated label. */
export function sentenceCase(value: string): string {
  const s = value.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

const ROLES: Record<string, string> = {
  learner: 'Learner',
  educator: 'Educator',
  institution_admin: 'Institution admin',
  quality_officer: 'Quality officer',
  platform_admin: 'Platform admin',
};

export function roleLabel(role: string): string {
  return ROLES[role] ?? sentenceCase(role);
}

/** Badge class per lifecycle status (replaces StatusBadge's STATUS_STYLE). */
const STATUS_TONE: Record<string, string> = {
  draft: 'badge-neutral',
  institution_review: 'badge-info',
  submitted: 'badge-warn',
  under_review: 'badge-warn',
  published: 'badge-success',
  flagged: 'badge-danger',
  unlisted: 'badge-neutral',
  archived: 'badge-neutral',
  active: 'badge-success',
  invited: 'badge-info',
  suspended: 'badge-warn',
  banned: 'badge-danger',
  confirmed: 'badge-success',
  pending: 'badge-warn',
  initiated: 'badge-warn',
  failed: 'badge-danger',
  refunded: 'badge-neutral',
  paid: 'badge-success',
  held: 'badge-warn',
  approved: 'badge-success',
  denied: 'badge-danger',
};

export function statusLabel(status: string): { label: string; tone: string } {
  return { label: sentenceCase(status), tone: STATUS_TONE[status] ?? 'badge-neutral' };
}

const PRICING: Record<string, string> = {
  free: 'Free',
  freemium: 'Free preview',
  paid: 'Paid',
};

export function pricingLabel(pricing: string): string {
  return PRICING[pricing] ?? sentenceCase(pricing);
}

/** The one category label: the curated name, else sentence case; a missing category is "other". */
export function categoryLabel(category: string | null | undefined): string {
  const value = category || 'other';
  return COURSE_CATEGORIES.find((c) => c.value === value)?.label ?? sentenceCase(value);
}
