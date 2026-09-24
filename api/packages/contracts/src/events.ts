import { OwnerType, PricingType, QaDecisionAction, QaItemKind, TrustTier } from './enums';

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
  // Growth & commerce (financial service):
  'SponsorshipGranted', // a gift / paid request / bulk seat is paid → enrollment grants access
  'SponsorshipInvited', // sponsored seat for an email with no account yet → invite email
  'PayRequestCreated', // learner asked someone to pay for a course → email the payer
  'ReferralInviteSent', // user invited friends by email → invite emails
  'PaymentAbandoned', // checkout started, never completed → "finish your purchase" nudge
  'WalletCredited', // referral reward / cashback landed in a wallet → in-app ping
  'BulkPurchaseActivated', // corporate bulk purchase paid → buyer can assign seats
  // Engagement (enrollment + course services):
  'CourseUpdated', // educator posted a MAJOR change log entry → tell enrolled learners
  'CourseProgressMilestone', // learner crossed 25/50/75% → progress ping
  'LearnerInactive', // no activity for N days → in-app first, email later
  // Post-approval re-review (staged revisions of a live course):
  'CourseRevisionSubmitted', // educator submitted staged changes to a live course → QO queue
  'CourseReviewWithdrawn', // a submission or revision was pulled back → close its QA item
  'CourseRevisionReviewed', // QO decided a revision (approve | coach | reject)
  'CourseRevisionClosed', // revision applied / rejected / discarded → outcomes, enrollment, notification react
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
  category: string;
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
  /**
   * What the QA item was reviewing. Optional for events published before it
   * existed: 'post_publish' / 'appeal' approvals must not be announced as a
   * first publish ("Your course is live").
   */
  kind?: QaItemKind;
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
  /** Set when this is a revision of a live course rather than a first submission. */
  revision_id?: string | null;
}

export interface CourseInstitutionReviewedPayload {
  course_id: string;
  course_title: string;
  owner_user_id: string; // the instructor
  action: 'approve' | 'reject';
  notes: string | null;
  /** Set when the institution decided a revision of a live course. */
  revision_id?: string | null;
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

// ---- Growth & commerce -------------------------------------------------------

export type SponsorshipSource = 'gift' | 'pay_request' | 'bulk';

/** Access paid for by someone other than the learner. The ONLY non-payment path to entitlement. */
export interface SponsorshipGrantedPayload {
  sponsorship_id: string;
  source: SponsorshipSource;
  sponsor_id: string | null;
  sponsor_name: string;
  recipient_user_id: string;
  recipient_email: string;
  course_id: string;
  course_title: string;
  message: string;
  /** e.g. the organization for a bulk seat */
  organization_name: string | null;
}

export interface SponsorshipInvitedPayload {
  sponsorship_id: string;
  source: SponsorshipSource;
  sponsor_name: string;
  recipient_email: string;
  course_id: string;
  course_title: string;
  message: string;
  organization_name: string | null;
  /** signup link that claims the seat once the account exists */
  signup_url: string;
}

export interface PayRequestCreatedPayload {
  sponsorship_id: string;
  requester_id: string;
  requester_name: string;
  requester_email: string;
  payer_email: string;
  course_id: string;
  course_title: string;
  amount_etb: number;
  message: string;
  pay_url: string;
}

export interface ReferralInviteSentPayload {
  referrer_id: string;
  referrer_name: string;
  to_email: string;
  message: string;
  signup_url: string;
  /** true when the address already has an account (email says "log in" instead of "sign up") */
  existing_user: boolean;
  role_hint: string;
}

export interface PaymentAbandonedPayload {
  payment_id: string;
  learner_id: string;
  learner_email: string;
  learner_name: string;
  course_id: string;
  course_title: string;
  amount_etb: number;
  resume_url: string;
}

export interface WalletCreditedPayload {
  user_id: string;
  amount_etb: number;
  balance_etb: number;
  kind: 'referral_reward' | 'cashback' | 'topup' | 'admin_adjust';
  note: string;
}

export interface BulkPurchaseActivatedPayload {
  bulk_purchase_id: string;
  buyer_id: string;
  buyer_email: string;
  organization_name: string;
  course_id: string;
  course_title: string;
  seats: number;
  total_etb: number;
}

// ---- Engagement --------------------------------------------------------------

export interface CourseUpdatedPayload {
  course_id: string;
  course_title: string;
  owner_user_id: string;
  summary: string;
  changelog_id: string;
}

export interface CourseProgressMilestonePayload {
  enrollment_id: string;
  learner_id: string;
  learner_email: string;
  course_id: string;
  course_title: string;
  percent: 25 | 50 | 75;
}

export interface LearnerInactivePayload {
  enrollment_id: string;
  learner_id: string;
  course_id: string;
  course_title: string;
  days_inactive: number;
  progress_percent: number;
  /** escalation step: in-app first, email when still inactive later */
  channel: 'in_app' | 'email';
}


// ---- Post-approval re-review (staged revisions) ------------------------------

/** Deterministic, cheap summary of a revision — shown as chips in the QA queue. */
export interface RevisionDiffSummary {
  /** course-level fields that change, e.g. ['title','description','thumbnail_url','category','pricing_type','price_etb'] */
  fields_changed: string[];
  sections_added: number;
  sections_removed: number;
  sections_changed: number;
  lessons_added: number;
  lessons_removed: number;
  lessons_changed: number;
  videos_replaced: number;
  price_from: number | null;
  price_to: number | null;
  pricing_type_from: string | null;
  pricing_type_to: string | null;
  /** an added or changed section becomes free-preview (content becomes public) */
  new_free_preview_section: boolean;
  knowledge_added: number;
  assessments_added: number;
}

export interface CourseRevisionSubmittedPayload {
  course_id: string;
  revision_id: string;
  /** LIVE title (the pending title, if any, is in changed_text / diff) */
  course_title: string;
  owner_id: string;
  owner_type: OwnerType;
  owner_user_id: string;
  owner_email: string;
  owner_name: string;
  diff_summary: RevisionDiffSummary;
  /** new/changed learner-facing text only (titles, descriptions, lesson summaries, note excerpts), ≤ 8000 chars — for the AI screen */
  changed_text: string;
  changelog_summary: string | null;
  major: boolean;
  /**
   * Hash of the staged content frozen at submit. Quality echoes it back on
   * CourseRevisionReviewed so an approval can only apply the exact content
   * the officer reviewed (a revision id is reused across resubmissions).
   */
  content_hash: string;
  /** Pending assessment ids the reviewer is shown; only these go live on approve. */
  assessment_ids: string[];
}

export interface CourseReviewWithdrawnPayload {
  course_id: string;
  /** null = a first-time submission (course status) was withdrawn, not a revision */
  revision_id: string | null;
}

export interface CourseRevisionReviewedPayload {
  course_id: string;
  revision_id: string;
  review_item_id: string;
  action: 'approve' | 'coach' | 'reject';
  notes: string | null;
  qo_id: string;
  owner_user_id: string;
  owner_email: string;
  course_title: string;
  /** content_hash from the CourseRevisionSubmitted this item was created from */
  content_hash: string;
}

export interface CourseRevisionClosedPayload {
  course_id: string;
  revision_id: string;
  outcome: 'applied' | 'rejected' | 'discarded';
  /** ISO time the revision was submitted (null if discarded before submit) */
  submitted_at: string | null;
  added_lesson_ids: string[];
  removed_lesson_ids: string[];
  replaced_video_lesson_ids: string[];
  changelog_summary: string | null;
  major: boolean;
  owner_user_id: string;
  owner_email: string;
  course_title: string;
  /** reviewer notes (coach/reject); null when applied without notes */
  notes: string | null;
  /**
   * applied/rejected: the pending assessment ids frozen at submit (the ones the
   * reviewer saw) — outcomes activates or deletes exactly these.
   * discarded: empty; outcomes deletes pending assessments created before closed_at.
   */
  assessment_ids: string[];
  /** ISO time the revision was closed */
  closed_at: string;
}
