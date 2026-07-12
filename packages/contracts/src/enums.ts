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

export enum CourseCategory {
  TECH = 'tech',
  BUSINESS = 'business',
  FREELANCING = 'freelancing',
  HEALTHCARE = 'healthcare',
  OTHER = 'other',
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
