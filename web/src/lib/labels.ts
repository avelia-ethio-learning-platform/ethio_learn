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

const WALLET_KINDS: Record<string, string> = {
  topup: 'Top-up',
  purchase: 'Course purchase',
  referral_reward: 'Referral reward',
  cashback: 'Cashback',
  gift_sent: 'Gift sent',
  admin_adjust: 'Adjustment',
};

/** A wallet entry's kind in words; sentence case for a kind without a curated label. */
export function walletKindLabel(kind: string): string {
  return WALLET_KINDS[kind] ?? sentenceCase(kind);
}

const PAYMENT_METHODS: Record<string, string> = {
  chapa: 'Online payment',
  bank_transfer: 'Bank transfer',
  wallet: 'Wallet',
  coupon: 'Coupon',
};

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHODS[method] ?? sentenceCase(method);
}

const OWNER_TYPES: Record<string, string> = {
  educator: 'Educator',
  institution: 'Institution',
};

export function ownerTypeLabel(type: string): string {
  return OWNER_TYPES[type] ?? sentenceCase(type);
}

/** Who a payment is paid out to. */
export function payeeLabel(payeeType: string): string {
  return ownerTypeLabel(payeeType);
}

const FRAUD_SIGNALS: Record<string, string> = {
  refund_abuse: 'Repeated refunds',
};

export function fraudSignalLabel(signal: string): string {
  return FRAUD_SIGNALS[signal] ?? sentenceCase(signal);
}

const HOLD_REASONS: Record<string, string> = {
  kyc_required: 'KYC required',
  fraud_flag_open: 'Open fraud flag',
};

/** Why a payout is held. A fraud hold may carry its signal (`fraud:refund_abuse`). */
export function holdReasonLabel(reason: string): string {
  if (reason.startsWith('fraud:')) return `Fraud flag: ${fraudSignalLabel(reason.slice('fraud:'.length))}`;
  return HOLD_REASONS[reason] ?? sentenceCase(reason);
}

const FRAUD_SUBJECTS: Record<string, string> = {
  user: 'User',
  course: 'Course',
  payment: 'Payment',
};

export function fraudSubjectLabel(subject: string): string {
  return FRAUD_SUBJECTS[subject] ?? sentenceCase(subject);
}

const PURPOSES: Record<string, string> = {
  course: 'Course purchase',
  wallet_topup: 'Wallet top-up',
  gift: 'Gift',
  pay_request: 'Pay request',
  bulk: 'Bulk seats',
};

export function purposeLabel(purpose: string): string {
  return PURPOSES[purpose] ?? sentenceCase(purpose);
}

const KNOWLEDGE_SOURCES: Record<string, string> = {
  notes: 'Tutor notes',
  description: 'Course description',
  lessons: 'Lessons',
};

export function knowledgeSourceLabel(source: string): string {
  return KNOWLEDGE_SOURCES[source] ?? sentenceCase(source);
}

const QA_TRIGGERS: Record<string, string> = {
  submission: 'First submission',
  revision: 'Revision',
};

export function qaTriggerLabel(trigger: string): string {
  return QA_TRIGGERS[trigger] ?? sentenceCase(trigger);
}

const ASSESSMENT_TYPES: Record<string, string> = {
  quiz: 'Quiz',
  ai_viva: 'AI viva',
  project: 'Project',
};

export function assessmentTypeLabel(type: string): string {
  return ASSESSMENT_TYPES[type] ?? sentenceCase(type);
}

/** Why a refund request got its decision, as the refund rule engine names it. */
const REFUND_RULES: Record<string, string> = {
  auto_approve_under_20pct_within_7d: 'under 20% watched, within 7 days',
  manual_review_20_to_50pct: '20–50% watched, so our team reviews it',
  over_50pct_consumed: 'more than half of the course watched',
  outside_7_day_window: 'more than 7 days since you enrolled',
  certificate_already_issued: 'a certificate was already issued',
  assessment_already_passed: 'an assessment was already passed',
};

/** A human reason for a refund rule, or '' for a rule without one (never the raw value). */
export function refundRuleLabel(rule: string): string {
  return REFUND_RULES[rule] ?? '';
}

/** The one category label: the curated name, else sentence case; a missing category is "other". */
export function categoryLabel(category: string | null | undefined): string {
  const value = category || 'other';
  return COURSE_CATEGORIES.find((c) => c.value === value)?.label ?? sentenceCase(value);
}
