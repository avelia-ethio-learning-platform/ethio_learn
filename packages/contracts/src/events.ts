import { OwnerType, PricingType, QaDecisionAction, TrustTier } from './enums';

/**
 * Full domain event registry (spec §5). No other events exist in MVP.
 * Services subscribe to exactly what is listed in the spec.
 */
export const EVENT_TYPES = [
  'UserRegistered',
  'ProfileCreated',
  'ProfileUpdated',
  'CourseSubmitted',
  'CoursePublished',
  'CourseUnlisted',
  'CourseArchived',
  'CourseReviewed',
  'PaymentConfirmed',
  'PaymentFailed',
  'EnrollmentCreated',
  'CourseCompleted',
  'AssessmentPassed',
  'AssessmentFailed',
  'CertificateIssued',
  'PayoutScheduled',
  'PayoutCompleted',
  'RefundApproved',
  'RefundDenied',
  'FraudFlagRaised',
  'FraudFlagResolved',
  'TrustTierChanged',
  'NotificationSent',
  // TODO(spec-open-question): not in the spec §5 registry, but password reset
  // requires an email and spec rule §0.4 says ONLY the Notification service
  // sends email. This event resolves that conflict; remove if the spec adds an
  // alternative channel.
  'PasswordResetRequested',
  // Post-MVP additions for the requested features:
  'CourseAppealSubmitted', // educator/instructor appeals a flagged course → re-review
  'StaffInvited', // admin provisioned a staff account → email a one-time password
  'CourseSubmittedToInstitution', // instructor submitted → institution internal review
  'CourseInstitutionReviewed', // institution approved/rejected an instructor's course
  'RefundRequested', // a refund needs a platform admin decision (manual-review band)
  'InstructorLinked', // an existing account was added as an institution instructor
  'CourseRated', // learner review saved → course service caches rating aggregates for ranking
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Standard message envelope for every event on the bus (spec §5). */
export interface EventEnvelope<P = unknown> {
  event_type: EventType;
  payload: P;
  metadata: {
    event_id: string;
    timestamp: string;
    producer_service: string;
    correlation_id: string;
  };
}

// ---- Event payloads (event-carried state: enough data that consumers never
// need cross-schema joins) ----

export interface UserRegisteredPayload {
  user_id: string;
  email: string;
  name: string;
  role: string;
  verification_url: string;
}

export interface ProfilePayload {
  user_id: string;
  role: string;
}

export interface PasswordResetRequestedPayload {
  user_id: string;
  email: string;
  name: string;
  reset_url: string;
}

export interface CourseSubmittedPayload {
  course_id: string;
  title: string;
  description: string;
  owner_id: string;
  owner_type: OwnerType;
  /** The account (user) that authored the course — target for in-app notifications. */
  owner_user_id: string;
  owner_email: string;
  owner_name: string;
  pricing_type: PricingType;
}

export interface CoursePublishedPayload {
  course_id: string;
  title: string;
  owner_id: string;
  owner_type: OwnerType;
  owner_user_id: string;
  owner_email: string;
  pricing_type: PricingType;
  price_etb: number | null;
}

export interface CourseStatusPayload {
  course_id: string;
  title: string;
  owner_id: string;
  owner_user_id: string;
  owner_email: string;
}

/** Aggregates recomputed by the quality service after each review write. */
export interface CourseRatedPayload {
  course_id: string;
  average_rating: number;
  rating_count: number;
  /** Sum of all star values — the educator-ranking "total rating" input. */
  total_points: number;
}

export interface CourseReviewedPayload {
  course_id: string;
  action: QaDecisionAction;
  notes: string | null;
  qo_id: string;
  owner_user_id: string;
  owner_email: string;
  course_title: string;
}

export interface CourseAppealSubmittedPayload {
  course_id: string;
  course_title: string;
  owner_user_id: string;
  owner_email: string;
  appeal_note: string;
}

export interface StaffInvitedPayload {
  user_id: string;
  email: string;
  name: string;
  role: string;
  /** One-time link where the invitee sets their own password (no password is ever emailed). */
  invite_url: string;
}

export interface CourseSubmittedToInstitutionPayload {
  course_id: string;
  course_title: string;
  institution_admin_user_id: string;
  instructor_name: string;
}

export interface CourseInstitutionReviewedPayload {
  course_id: string;
  course_title: string;
  owner_user_id: string; // the instructor
  action: 'approve' | 'reject';
  notes: string | null;
}

export interface PaymentConfirmedPayload {
  payment_id: string;
  tx_ref: string;
  learner_id: string;
  learner_email: string;
  learner_name: string;
  course_id: string;
  course_title: string;
  amount_etb: number;
  payee_id: string;
  payee_type: OwnerType;
}

export interface PaymentFailedPayload {
  payment_id: string;
  tx_ref: string;
  learner_id: string;
  learner_email: string;
  course_id: string;
  course_title: string;
  amount_etb: number;
  reason: string;
}

export interface EnrollmentCreatedPayload {
  enrollment_id: string;
  learner_id: string;
  learner_email: string;
  learner_name: string;
  course_id: string;
  course_title: string;
  educator_name: string;
  pricing_type: PricingType;
}

export interface CourseCompletedPayload {
  enrollment_id: string;
  learner_id: string;
  learner_email: string;
  learner_name: string;
  course_id: string;
  course_title: string;
  educator_id: string;
  educator_name: string;
  completed_at: string;
}

export interface AssessmentResultPayload {
  assessment_id: string;
  attempt_id: string;
  assessment_type: string;
  enrollment_id: string;
  learner_id: string;
  learner_email: string;
  learner_name: string;
  course_id: string;
  course_title: string;
  educator_id: string;
  educator_name: string;
  score: number;
  passed: boolean;
}

export interface CertificateIssuedPayload {
  certificate_id: string;
  certificate_uid: string;
  enrollment_id: string;
  learner_id: string;
  learner_email: string;
  learner_name: string;
  course_id: string;
  course_title: string;
  verify_url: string;
}

export interface PayoutPayload {
  payout_id: string;
  payee_id: string;
  payee_type: OwnerType;
  payee_email: string;
  gross_amount_etb: number;
  platform_fee_etb: number;
  net_amount_etb: number;
}

export interface RefundDecisionPayload {
  refund_request_id: string;
  payment_id: string;
  tx_ref: string;
  learner_id: string;
  learner_email: string;
  course_id: string;
  course_title: string;
  amount_etb: number;
  reason: string;
}

/** Emitted when a refund lands in the manual-review band and needs an admin. */
export interface RefundRequestedPayload {
  refund_request_id: string;
  payment_id: string;
  learner_id: string;
  learner_email: string;
  course_id: string;
  course_title: string;
  amount_etb: number;
  reason: string; // the rule that routed it to manual review
}

/** Emitted when an EXISTING account is added as an institution instructor
 *  (learner upgraded to educator, or an independent educator affiliated). */
export interface InstructorLinkedPayload {
  user_id: string;
  email: string;
  name: string;
  institution_id: string;
  institution_name: string;
  /** true when the account was a learner and has just been upgraded to educator. */
  upgraded_from_learner: boolean;
}

export interface FraudFlagPayload {
  flag_id: string;
  subject_type: string;
  subject_id: string;
  signal_type: string;
  /** payee whose payouts must be held/released; null when not payout-related */
  payee_id: string | null;
  detail: string;
}

export interface TrustTierChangedPayload {
  educator_id: string;
  previous_tier: TrustTier;
  new_tier: TrustTier;
}
