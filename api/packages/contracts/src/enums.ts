/** The exactly-5 platform roles. No others exist in MVP (spec §0). */
export enum Role {
  LEARNER = 'learner',
  EDUCATOR = 'educator',
  INSTITUTION_ADMIN = 'institution_admin',
  QUALITY_OFFICER = 'quality_officer',
  PLATFORM_ADMIN = 'platform_admin',
}

/** Account moderation status (platform-admin controlled). */
export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended', // temporary lockout, reversible
  BANNED = 'banned', // permanent lockout
}

/** Course lifecycle state machine (spec §8; institution_review is the extra
 *  internal step for institution-owned courses before platform QO review). */
export enum CourseStatus {
  DRAFT = 'draft',
  INSTITUTION_REVIEW = 'institution_review',
  SUBMITTED = 'submitted',
  UNDER_REVIEW = 'under_review',
  PUBLISHED = 'published',
  FLAGGED = 'flagged',
  UNLISTED = 'unlisted',
  ARCHIVED = 'archived',
}

export enum PricingType {
  FREE = 'free',
  FREEMIUM = 'freemium',
  PAID = 'paid',
}

/**
 * Course categories. Stored as a plain string column (not a Postgres enum) so
 * new categories can be added here without a database migration. This enum is
 * the single source of truth for validation; `COURSE_CATEGORIES` /
 * `COURSE_CATEGORY_LABELS` drive the pickers, filters and display labels.
 */
export enum CourseCategory {
  PROGRAMMING = 'programming',
  WEB_DEVELOPMENT = 'web_development',
  DESIGN = 'design',
  VIDEO_EDITING = 'video_editing',
  DATA_SCIENCE = 'data_science',
  TECH = 'tech',
  BUSINESS = 'business',
  MARKETING = 'marketing',
  FREELANCING = 'freelancing',
  FINANCE = 'finance',
  LANGUAGE = 'language',
  HEALTHCARE = 'healthcare',
  AGRICULTURE = 'agriculture',
  ARTS = 'arts',
  EDUCATION = 'education',
  OTHER = 'other',
}

/** Display order for pickers and catalog filters (most in-demand first). */
export const COURSE_CATEGORIES: CourseCategory[] = [
  CourseCategory.PROGRAMMING,
  CourseCategory.WEB_DEVELOPMENT,
  CourseCategory.DESIGN,
  CourseCategory.VIDEO_EDITING,
  CourseCategory.DATA_SCIENCE,
  CourseCategory.TECH,
  CourseCategory.BUSINESS,
  CourseCategory.MARKETING,
  CourseCategory.FREELANCING,
  CourseCategory.FINANCE,
  CourseCategory.LANGUAGE,
  CourseCategory.HEALTHCARE,
  CourseCategory.AGRICULTURE,
  CourseCategory.ARTS,
  CourseCategory.EDUCATION,
  CourseCategory.OTHER,
];

/** Human-readable label for each category (English base; UI may localise). */
export const COURSE_CATEGORY_LABELS: Record<CourseCategory, string> = {
  [CourseCategory.PROGRAMMING]: 'Programming',
  [CourseCategory.WEB_DEVELOPMENT]: 'Web Development',
  [CourseCategory.DESIGN]: 'Graphic Design',
  [CourseCategory.VIDEO_EDITING]: 'Video Editing',
  [CourseCategory.DATA_SCIENCE]: 'Data Science',
  [CourseCategory.TECH]: 'Technology',
  [CourseCategory.BUSINESS]: 'Business',
  [CourseCategory.MARKETING]: 'Marketing',
  [CourseCategory.FREELANCING]: 'Freelancing',
  [CourseCategory.FINANCE]: 'Finance',
  [CourseCategory.LANGUAGE]: 'Language',
  [CourseCategory.HEALTHCARE]: 'Healthcare',
  [CourseCategory.AGRICULTURE]: 'Agriculture',
  [CourseCategory.ARTS]: 'Arts & Music',
  [CourseCategory.EDUCATION]: 'Education',
  [CourseCategory.OTHER]: 'Other',
};

/** Safe label lookup for any stored value (handles legacy/unknown gracefully). */
export function courseCategoryLabel(value: string): string {
  return COURSE_CATEGORY_LABELS[value as CourseCategory] ?? 'Other';
}

export enum OwnerType {
  EDUCATOR = 'educator',
  INSTITUTION = 'institution',
}

export enum EntitlementStatus {
  NONE = 'none',
  ACTIVE = 'active',
  REFUNDED = 'refunded',
}

export enum PaymentMethod {
  CHAPA = 'chapa',
  BANK_TRANSFER = 'bank_transfer',
}

export enum PaymentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

export enum PayoutStatus {
  PENDING = 'pending',
  SCHEDULED = 'scheduled',
  PAID = 'paid',
  HELD = 'held',
}

export enum RefundStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DENIED = 'denied',
}

export enum TrustTier {
  NEW = 'new',
  PROVEN = 'proven',
  TRUSTED = 'trusted',
}

export enum AssessmentType {
  QUIZ = 'quiz',
  AI_VIVA = 'ai_viva',
  PROJECT = 'project',
}

export enum QaDecisionAction {
  APPROVE = 'approve',
  COACH = 'coach',
  FLAG = 'flag',
}

export enum QaReviewStatus {
  PENDING = 'pending',
  IN_REVIEW = 'in_review',
  APPROVED = 'approved',
  COACHED = 'coached',
  FLAGGED = 'flagged',
}

export enum FraudSubjectType {
  USER = 'user',
  COURSE = 'course',
  PAYMENT = 'payment',
}

export enum FraudSignalStatus {
  OPEN = 'open',
  RESOLVED = 'resolved',
}
