import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { env, EventBusService, InternalHttpClient } from '@ethiopialearn/common';
import { courseCategoryLabel } from '@ethiopialearn/contracts';
import {
  AssessmentResultPayload,
  BulkPurchaseActivatedPayload,
  CourseProgressMilestonePayload,
  CourseUpdatedPayload,
  LearnerInactivePayload,
  PayRequestCreatedPayload,
  PaymentAbandonedPayload,
  ReferralInviteSentPayload,
  SponsorshipGrantedPayload,
  SponsorshipInvitedPayload,
  WalletCreditedPayload,
  CertificateIssuedPayload,
  CourseAppealSubmittedPayload,
  CourseInstitutionReviewedPayload,
  CourseReviewedPayload,
  CourseRevisionClosedPayload,
  CourseRevisionReviewedPayload,
  CourseRevisionSubmittedPayload,
  CourseSubmittedToInstitutionPayload,
  CourseCompletedPayload,
  CoursePublishedPayload,
  CourseStatus,
  CourseStatusPayload,
  CourseSubmittedPayload,
  EnrollmentCreatedPayload,
  FraudFlagPayload,
  InstructorLinkedPayload,
  PasswordResetRequestedPayload,
  PaymentConfirmedPayload,
  PaymentFailedPayload,
  PayoutPayload,
  QaDecisionAction,
  RefundDecisionPayload,
  RefundRequestedPayload,
  Role,
  StaffInvitedPayload,
  UserRegisteredPayload,
} from '@ethiopialearn/contracts';
import { EMAIL_PROVIDER, EmailProvider } from './email.provider';
import { InboxNotification, NotificationLog, NotificationPreference } from './entities';
import { html, SafeHtml } from './email-html';
import { revisionSubmittedBody } from './revision-messages';

/**
 * Every email body goes through here. The body must be SafeHtml (built with
 * the `html` tag, which escapes each interpolated value), and the heading is
 * escaped, so no user text reaches an email as markup.
 */
function layout(title: string, body: SafeHtml): string {
  return html`<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <h2 style="color:#0f766e;margin-bottom:4px">EthiopiaLearn</h2>
  <h3 style="margin-top:0">${title}</h3>
  ${body}
  <p style="color:#6b7280;font-size:12px;margin-top:32px">EthiopiaLearn · Addis Ababa, Ethiopia · This is a transactional email.</p>
</div>`.value;
}

/** User text (reviewer notes, a gift message) as an email quote block; nothing when empty. */
function quote(text: string | null | undefined): SafeHtml {
  return text ? html`<blockquote style="border-left:3px solid #0f766e;margin:12px 0;padding:6px 12px;color:#374151">${text}</blockquote>` : html``;
}

/** The teal call-to-action button used in most emails. */
function button(href: string, label: string): SafeHtml {
  return html`<p><a href="${href}" style="background:#0f766e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${label}</a></p>`;
}

interface OwnerMessage {
  /** inbox */
  type: string;
  title: string;
  body: string;
  /** email */
  subject: string;
  heading: string;
  html: SafeHtml;
}

/** Approved courses: re-reviews and revisions never take them out of these states. */
const LIVE_STATUSES = new Set<string>([CourseStatus.PUBLISHED, CourseStatus.UNLISTED]);

interface InboxInput {
  user_id?: string | null;
  role?: string | null;
  type: string;
  title: string;
  body?: string;
  link?: string;
}

/**
 * The ONLY service that sends email (spec §0.5 rule 5), and the owner of the
 * in-app notification inbox. Subscribes to the full fanout exchange and reacts
 * with role-appropriate transactional email AND an in-app notification.
 */
@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private readonly adminEmail = env('PLATFORM_ADMIN_EMAIL', 'admin@ethiopialearn.et');
  private readonly webUrl = env('WEB_URL', 'http://localhost:3000');

  constructor(
    @InjectRepository(NotificationLog) private readonly log: Repository<NotificationLog>,
    @InjectRepository(InboxNotification) private readonly inboxRepo: Repository<InboxNotification>,
    @InjectRepository(NotificationPreference) private readonly prefs: Repository<NotificationPreference>,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  onModuleInit() {
    this.bus.subscribe<UserRegisteredPayload>('UserRegistered', (p) =>
      this.deliver('UserRegistered', p.user_id, p.email, 'Verify your EthiopiaLearn account',
        layout('Welcome to EthiopiaLearn!', html`<p>Hi ${p.name},</p><p>Confirm your email address to activate your account:</p>
        ${button(p.verification_url, 'Verify my email')}
        <p>Or open this link: ${p.verification_url}</p><p>The link expires in 24 hours.</p>`)));

    this.bus.subscribe<PasswordResetRequestedPayload>('PasswordResetRequested', (p) =>
      this.deliver('PasswordResetRequested', p.user_id, p.email, 'Reset your EthiopiaLearn password',
        layout('Password reset', html`<p>Hi ${p.name},</p><p>Use this link to set a new password (valid for 30 minutes):</p>
        <p><a href="${p.reset_url}">${p.reset_url}</a></p><p>If you didn't ask for this, ignore this email.</p>`)));

    // Staff / instructor invite — email a one-time link where they set their own
    // password. No password is ever generated by an admin or sent by email.
    this.bus.subscribe<StaffInvitedPayload>('StaffInvited', (p) =>
      this.deliver('StaffInvited', p.user_id, p.email, `You've been invited as ${p.role.replace('_', ' ')} on EthiopiaLearn`,
        layout('Set up your account', html`<p>Hi ${p.name},</p><p>You've been invited to join EthiopiaLearn as a <strong>${p.role.replace('_', ' ')}</strong>.</p>
        <p>Click below to choose your password and get started — no temporary password needed:</p>
        ${button(p.invite_url, 'Set my password')}
        <p>Or open this link: ${p.invite_url}</p><p style="color:#6b7280;font-size:13px">This invitation expires in 7 days.</p>`)));

    // An existing account was added as an institution instructor.
    this.bus.subscribe<InstructorLinkedPayload>('InstructorLinked', (p) => {
      this.inbox({ user_id: p.user_id, type: 'instructor_added', title: `You're now an instructor at ${p.institution_name}`, body: p.upgraded_from_learner ? 'Your account was upgraded to educator — sign in again to open your teaching dashboard.' : 'New courses you create go through your institution’s review; your independent courses are unchanged.', link: '/teach' });
      this.deliver('InstructorLinked', p.user_id, p.email, `You're now an instructor at ${p.institution_name}`,
        layout('Welcome to the teaching team', html`<p>Hi ${p.name},</p><p>You've been added as an instructor at <strong>${p.institution_name}</strong> on EthiopiaLearn.</p>
        ${p.upgraded_from_learner ? html`<p>Your account has been upgraded so you can now create and manage courses — <strong>sign in again</strong> to see your teaching dashboard. Your existing enrollments and learning are unchanged.</p>` : html`<p>New courses you create will go through your institution’s internal review; any courses you already own as an independent educator stay exactly as they are.</p>`}
        ${button(`${this.webUrl}/teach`, 'Go to teaching dashboard')}`));
    });

    // Course submitted → notify QOs in their queue (in-app; no email needed).
    this.bus.subscribe<CourseSubmittedPayload>('CourseSubmitted', (p) =>
      this.inbox({ role: Role.QUALITY_OFFICER, type: 'course_submitted', title: 'New course awaiting review', body: `"${p.title}" was submitted for quality review.`, link: '/qa' }));

    this.bus.subscribe<CourseAppealSubmittedPayload>('CourseAppealSubmitted', (p) =>
      this.inbox({ role: Role.QUALITY_OFFICER, type: 'course_appeal', title: 'Course appeal to review', body: `"${p.course_title}" was appealed: ${p.appeal_note.slice(0, 140)}`, link: '/qa' }));

    // Instructor submitted → notify the institution admin's internal review queue.
    // A revision_id means staged changes to a course that is already live.
    this.bus.subscribe<CourseSubmittedToInstitutionPayload>('CourseSubmittedToInstitution', (p) =>
      this.inbox(p.revision_id
        ? { user_id: p.institution_admin_user_id, type: 'institution_revision_review', title: 'Instructor update to review', body: `${p.instructor_name} submitted changes to the live course "${p.course_title}" for your review.`, link: '/institution/review' }
        : { user_id: p.institution_admin_user_id, type: 'institution_review', title: 'Instructor course to review', body: `${p.instructor_name} submitted "${p.course_title}" for your review.`, link: '/institution/review' }));

    // Institution approved/rejected → notify the instructor. For a revision the
    // live course is untouched either way, so say "update", not "course".
    this.bus.subscribe<CourseInstitutionReviewedPayload>('CourseInstitutionReviewed', (p) => {
      const approved = p.action === 'approve';
      const link = `/teach/courses/${p.course_id}`;
      if (p.revision_id) {
        return this.inbox({
          user_id: p.owner_user_id,
          type: 'institution_decision',
          title: approved ? 'Institution approved your update — forwarded to review' : 'Institution sent your update back',
          body: approved
            ? `Your changes to "${p.course_title}" were approved by your institution and sent to platform quality review.`
            : `Your changes to "${p.course_title}" need work: ${p.notes ?? 'see your institution.'} The live course is unchanged.`,
          link,
        });
      }
      return this.inbox({
        user_id: p.owner_user_id,
        type: 'institution_decision',
        title: approved ? 'Institution approved — forwarded to review' : 'Institution sent your course back',
        body: approved ? `"${p.course_title}" was approved by your institution and sent to platform quality review.` : `"${p.course_title}" needs changes: ${p.notes ?? 'see your institution.'}`,
        link,
      });
    });

    this.bus.subscribe<CourseReviewedPayload>('CourseReviewed', (p) => this.notifyCourseReviewed(p));

    // Staged changes to a live course → QO queue (in-app, like first submissions).
    this.bus.subscribe<CourseRevisionSubmittedPayload>('CourseRevisionSubmitted', (p) =>
      this.inbox({ role: Role.QUALITY_OFFICER, type: 'course_revision_submitted', title: 'Course update to review', body: revisionSubmittedBody(p.course_title, p.diff_summary), link: '/qa' }));

    this.bus.subscribe<CourseRevisionReviewedPayload>('CourseRevisionReviewed', (p) => this.notifyRevisionReviewed(p));
    this.bus.subscribe<CourseRevisionClosedPayload>('CourseRevisionClosed', (p) => this.notifyRevisionClosed(p));

    this.bus.subscribe<CoursePublishedPayload>('CoursePublished', (p) => {
      // The instructor's own "your course is live" confirmation.
      this.inbox({ user_id: p.owner_user_id, type: 'course_published', title: 'Course published', body: `"${p.title}" is now live in the catalog.`, link: `/teach/courses/${p.course_id}` });
      // Fan out to learners who follow this category or this instructor.
      void this.notifyNewCourseFollowers(p);
    });

    this.bus.subscribe<PaymentConfirmedPayload>('PaymentConfirmed', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'payment_confirmed', title: 'Enrollment confirmed', body: `You now have access to "${p.course_title}".`, link: `/learn/${p.course_id}` });
      this.deliver('PaymentConfirmed', p.learner_id, p.learner_email, 'Enrollment confirmed — receipt',
        layout('Payment received', html`<p>Hi ${p.learner_name},</p><p>Your payment of <strong>${p.amount_etb} ETB</strong> for "${p.course_title}" is confirmed. Your course is unlocked — happy learning!</p><p>Reference: ${p.tx_ref}</p>`));
    });

    this.bus.subscribe<PaymentFailedPayload>('PaymentFailed', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'payment_failed', title: 'Payment could not be processed', body: `Your payment for "${p.course_title}" did not go through.`, link: `/courses/${p.course_id}` });
      this.deliver('PaymentFailed', p.learner_id, p.learner_email, 'Your payment could not be processed',
        layout('Payment failed', html`<p>Your payment for "${p.course_title}" (${p.amount_etb} ETB) did not go through. No money was taken for this attempt — you can retry from the course page.</p>`));
    });

    this.bus.subscribe<EnrollmentCreatedPayload>('EnrollmentCreated', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'enrolled', title: `You're enrolled: ${p.course_title}`, body: `Start learning "${p.course_title}" from your dashboard.`, link: `/learn/${p.course_id}` });
      this.deliver('EnrollmentCreated', p.learner_id, p.learner_email, `You're enrolled: ${p.course_title}`,
        layout('Enrollment confirmed', html`<p>Hi ${p.learner_name},</p><p>You're enrolled in "${p.course_title}"${p.educator_name ? html` by ${p.educator_name}` : ''}. Start learning from your dashboard.</p>`));
    });

    this.bus.subscribe<CertificateIssuedPayload>('CertificateIssued', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'certificate', title: 'Your certificate is ready 🎓', body: `You completed "${p.course_title}".`, link: '/dashboard' });
      this.deliver('CertificateIssued', p.learner_id, p.learner_email, 'Your certificate is ready',
        layout('Certificate issued 🎓', html`<p>Congratulations ${p.learner_name}!</p><p>You completed "${p.course_title}". Your certificate is available in your dashboard, and anyone can verify it here:</p><p><a href="${p.verify_url}">${p.verify_url}</a></p>`));
    });

    this.bus.subscribe<PayoutPayload>('PayoutCompleted', (p) => {
      this.inbox({ user_id: p.payee_id, type: 'payout', title: 'Payout sent', body: `${p.net_amount_etb} ETB was disbursed to your account.`, link: '/teach' });
      if (p.payee_email) this.deliver('PayoutCompleted', p.payee_id, p.payee_email, 'Payout sent to your account',
        layout('Payout completed', html`<p>Your payout of <strong>${p.net_amount_etb} ETB</strong> (gross ${p.gross_amount_etb} ETB − platform fee ${p.platform_fee_etb} ETB) has been disbursed.</p>`));
    });

    this.bus.subscribe<FraudFlagPayload>('FraudFlagRaised', (p) => {
      this.inbox({ role: Role.PLATFORM_ADMIN, type: 'fraud', title: 'Fraud flag raised', body: `${p.signal_type} on ${p.subject_type}. ${p.detail}`, link: '/admin' });
      this.deliver('FraudFlagRaised', null, this.adminEmail, 'Fraud flag raised — action needed',
        layout('Fraud flag raised', html`<p>Signal <strong>${p.signal_type}</strong> on ${p.subject_type} <code>${p.subject_id}</code>.</p><p>${p.detail}</p><p>Payouts for the related payee are on hold until resolved in the admin console.</p>`));
    });

    this.bus.subscribe<FraudFlagPayload>('FraudFlagResolved', (p) =>
      this.deliver('FraudFlagResolved', null, this.adminEmail, 'Fraud flag resolved',
        layout('Fraud flag resolved', html`<p>Flag <code>${p.flag_id}</code> (${p.signal_type}) has been resolved. Any payout holds have been released.</p>`)));

    // A refund needs an admin decision (manual-review band) → actionable admin inbox.
    this.bus.subscribe<RefundRequestedPayload>('RefundRequested', (p) => {
      this.inbox({ role: Role.PLATFORM_ADMIN, type: 'refund_request', title: 'Refund awaiting your decision', body: `${p.amount_etb} ETB refund requested for "${p.course_title}" (${p.reason}).`, link: '/admin' });
      this.deliver('RefundRequested', null, this.adminEmail, 'Refund request awaiting review',
        layout('Refund awaiting decision', html`<p>A learner requested a ${p.amount_etb} ETB refund for "${p.course_title}".</p><p>Routing rule: <code>${p.reason}</code>. Approve or deny it in the admin console.</p>`));
    });

    this.bus.subscribe<RefundDecisionPayload>('RefundApproved', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'refund', title: 'Refund processed', body: `Your refund for "${p.course_title}" was approved.`, link: '/dashboard' });
      // Also record it in the admin inbox — many approvals are automatic (spec §10.4)
      // and never crossed an admin's desk, but they still move money.
      this.inbox({ role: Role.PLATFORM_ADMIN, type: 'refund', title: 'Refund approved', body: `${p.amount_etb} ETB refunded for "${p.course_title}".`, link: '/admin' });
      this.deliver('RefundApproved', p.learner_id, p.learner_email, 'Your refund has been processed',
        layout('Refund processed', html`<p>Your refund of ${p.amount_etb} ETB for "${p.course_title}" was approved. Access to the course has been revoked.</p>`));
    });

    this.bus.subscribe<RefundDecisionPayload>('RefundDenied', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'refund', title: 'Refund request declined', body: `Your refund for "${p.course_title}" was declined (${p.reason}).`, link: '/dashboard' });
      this.deliver('RefundDenied', p.learner_id, p.learner_email, 'Refund request decision',
        layout('Refund request declined', html`<p>Your refund request for "${p.course_title}" was declined (${p.reason}). Reply to this email if you believe this is a mistake.</p>`));
    });

    this.bus.subscribe<CourseCompletedPayload>('CourseCompleted', (p) =>
      this.deliver('CourseCompleted', p.learner_id, p.learner_email, `You finished ${p.course_title}!`,
        layout('Course completed', html`<p>Well done ${p.learner_name} — you finished every lesson in "${p.course_title}".</p>`)));

    this.bus.subscribe<AssessmentResultPayload>('AssessmentFailed', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'assessment', title: 'Assessment not passed', body: `Your ${p.assessment_type} for "${p.course_title}" scored ${p.score}.`, link: `/learn/${p.course_id}` });
      this.deliver('AssessmentFailed', p.learner_id, p.learner_email, 'Assessment result',
        layout('Assessment not passed', html`<p>Your ${p.assessment_type} attempt for "${p.course_title}" scored ${p.score}. You can try again from the course page.</p>`));
    });

    // ---- Growth & commerce ----

    this.bus.subscribe<SponsorshipGrantedPayload>('SponsorshipGranted', async (p) => {
      const what = p.source === 'bulk' ? `${p.organization_name || p.sponsor_name} enrolled you in` : p.source === 'gift' ? `${p.sponsor_name || 'Someone'} gifted you` : `${p.sponsor_name || 'Someone'} paid for`;
      this.inbox({ user_id: p.recipient_user_id, type: 'gift', title: `🎁 ${what} "${p.course_title}"`, body: p.message || 'The course is unlocked — start learning from your dashboard.', link: `/learn/${p.course_id}` });
      if (p.sponsor_id) {
        this.inbox({ user_id: p.sponsor_id, type: 'gift_delivered', title: `Delivered: "${p.course_title}"`, body: `${p.recipient_email} now has access. Follow their progress from your dashboard.`, link: '/dashboard' });
      }
      const user = await this.userInfo(p.recipient_user_id);
      const to = user.email || p.recipient_email;
      if (to) this.deliver('SponsorshipGranted', p.recipient_user_id, to, `${what} a course on EthiopiaLearn`,
        layout('A course was unlocked for you 🎁', html`<p>Hi ${user.name || 'there'},</p><p>${what} <strong>"${p.course_title}"</strong>.</p>${quote(p.message)}${button(`${this.webUrl}/learn/${p.course_id}`, 'Start learning')}`));
    });

    this.bus.subscribe<SponsorshipInvitedPayload>('SponsorshipInvited', (p) => {
      const who = p.source === 'bulk' ? (p.organization_name || p.sponsor_name) : p.sponsor_name || 'Someone';
      this.deliver('SponsorshipInvited', null, p.recipient_email, `${who} has enrolled you in "${p.course_title}"`,
        layout('You have a course waiting 🎁', html`<p>${who} bought <strong>"${p.course_title}"</strong> on EthiopiaLearn for you.</p>${quote(p.message)}<p>Create a free account with <strong>this email address</strong> and the course unlocks automatically:</p>${button(p.signup_url, 'Create my account')}<p style="color:#6b7280;font-size:12px">Or open: ${p.signup_url}</p>`));
    });

    this.bus.subscribe<PayRequestCreatedPayload>('PayRequestCreated', (p) => {
      this.inbox({ user_id: p.requester_id, type: 'pay_request', title: 'Payment request sent', body: `We emailed ${p.payer_email} asking them to pay for "${p.course_title}".`, link: '/dashboard' });
      this.deliver('PayRequestCreated', null, p.payer_email, `${p.requester_name} is asking you to pay for a course`,
        layout(`${p.requester_name} needs your help 🙏`, html`<p><strong>${p.requester_name}</strong> would like to take <strong>"${p.course_title}"</strong> on EthiopiaLearn (${p.amount_etb} ETB) and is asking you to cover it.</p>${quote(p.message)}${button(p.pay_url, 'View the course & pay')}<p style="color:#6b7280;font-size:12px">You pay securely with Chapa (Telebirr, CBE Birr and 18+ banks). ${p.requester_name} gets access the moment it clears.</p>`));
    });

    this.bus.subscribe<ReferralInviteSentPayload>('ReferralInviteSent', (p) => {
      const cta = p.existing_user
        ? html`<p>You already have an account — <a href="${this.webUrl}/login">log in</a> and browse the catalog.</p>`
        : html`${button(p.signup_url, 'Join EthiopiaLearn')}<p style="color:#6b7280;font-size:12px">Or open: ${p.signup_url}</p>`;
      this.deliver('ReferralInviteSent', null, p.to_email, `${p.referrer_name} invited you to EthiopiaLearn`,
        layout(`${p.referrer_name} thinks you'd like this`, html`<p><strong>${p.referrer_name}</strong> invited you to ${p.role_hint === 'educator' ? 'teach on' : 'learn on'} EthiopiaLearn — real skills from Ethiopian experts, verifiable certificates, pay with Telebirr or any Ethiopian bank.</p>${quote(p.message)}${cta}`));
    });

    this.bus.subscribe<PaymentAbandonedPayload>('PaymentAbandoned', (p) => {
      this.inbox({ user_id: p.learner_id, type: 'abandoned_cart', title: `Still want "${p.course_title}"?`, body: `Your checkout didn't complete. Your place is waiting — finish in one tap.`, link: `/courses/${p.course_id}` });
      if (p.learner_email) this.deliver('PaymentAbandoned', p.learner_id, p.learner_email, `Finish enrolling in "${p.course_title}"`,
        layout('Your course is waiting', html`<p>Hi ${p.learner_name || 'there'},</p><p>You started enrolling in <strong>"${p.course_title}"</strong> (${p.amount_etb} ETB) but the payment didn't complete. No money was taken.</p>${button(p.resume_url, 'Finish enrolling')}<p style="color:#6b7280;font-size:12px">Not interested any more? Just ignore this — we won't remind you again.</p>`));
    });

    this.bus.subscribe<WalletCreditedPayload>('WalletCredited', (p) => {
      const title = p.kind === 'referral_reward' ? `You earned ${p.amount_etb} ETB 🎉` : p.kind === 'cashback' ? `${p.amount_etb} ETB cashback added` : `${p.amount_etb} ETB added to your wallet`;
      this.inbox({ user_id: p.user_id, type: 'wallet', title, body: `${p.note}. Balance: ${p.balance_etb} ETB — spend it on any course.`, link: '/dashboard' });
    });

    this.bus.subscribe<BulkPurchaseActivatedPayload>('BulkPurchaseActivated', (p) => {
      this.inbox({ user_id: p.buyer_id, type: 'bulk', title: `${p.seats} seats ready: "${p.course_title}"`, body: 'Assign seats to your team by email from the Institution page.', link: '/institution' });
      if (p.buyer_email) this.deliver('BulkPurchaseActivated', p.buyer_id, p.buyer_email, `Your ${p.seats} seats for "${p.course_title}" are ready`,
        layout('Bulk purchase confirmed', html`<p>Payment of <strong>${p.total_etb} ETB</strong> for <strong>${p.seats} seats</strong> of "${p.course_title}" (${p.organization_name}) is confirmed.</p><p>Assign seats by entering your team's email addresses — people with an account get instant access, everyone else gets an invitation that unlocks the course when they sign up.</p>${button(`${this.webUrl}/institution`, 'Assign seats')}`));
    });

    // ---- Engagement ----

    this.bus.subscribe<CourseUpdatedPayload>('CourseUpdated', (p) => void this.notifyCourseUpdated(p));

    this.bus.subscribe<CourseProgressMilestonePayload>('CourseProgressMilestone', async (p) => {
      const cheer = p.percent === 25 ? 'Great start' : p.percent === 50 ? 'Halfway there' : 'Almost done';
      this.inbox({ user_id: p.learner_id, type: 'progress', title: `${cheer} — ${p.percent}% of "${p.course_title}"`, body: p.percent === 75 ? 'Finish the last lessons to earn your certificate.' : 'Keep the momentum going.', link: `/learn/${p.course_id}` });
      if (p.percent >= 50) {
        const pref = await this.prefs.findOne({ where: { user_id: p.learner_id } });
        if (pref?.progress_emails === false) return;
        const user = await this.userInfo(p.learner_id);
        const to = p.learner_email || user.email;
        if (to) this.deliver('CourseProgressMilestone', p.learner_id, to, `${cheer}! You're ${p.percent}% through "${p.course_title}"`,
          layout(`${cheer} 🚀`, html`<p>Hi ${user.name || 'there'},</p><p>You've completed <strong>${p.percent}%</strong> of "${p.course_title}".${p.percent === 75 ? ' A few more lessons and your verifiable certificate is yours.' : ''}</p>${button(`${this.webUrl}/learn/${p.course_id}`, 'Continue learning')}`));
      }
    });

    this.bus.subscribe<LearnerInactivePayload>('LearnerInactive', async (p) => {
      if (p.channel === 'in_app') {
        this.inbox({ user_id: p.learner_id, type: 'inactive', title: `Pick up "${p.course_title}" where you left off`, body: `It's been ${p.days_inactive} days. You're ${p.progress_percent}% through — a short lesson today keeps it going.`, link: `/learn/${p.course_id}` });
        return;
      }
      const pref = await this.prefs.findOne({ where: { user_id: p.learner_id } });
      if (pref?.inactivity_emails === false || pref?.marketing_opt_out) return;
      const user = await this.userInfo(p.learner_id);
      if (!user.email) return;
      this.deliver('LearnerInactive', p.learner_id, user.email, `We miss you in "${p.course_title}"`,
        layout('Your course is still here', html`<p>Hi ${user.name || 'there'},</p><p>It's been ${p.days_inactive} days since you last studied <strong>"${p.course_title}"</strong>. You're already <strong>${p.progress_percent}%</strong> through — pick a lesson and keep going.</p>${button(`${this.webUrl}/learn/${p.course_id}`, 'Resume the course')}<p style="color:#6b7280;font-size:12px">You can turn these reminders off in Account → Notification preferences.</p>`));
    });

    this.bus.subscribe<CourseStatusPayload>('CourseUnlisted', (p) => {
      this.inbox({ user_id: p.owner_user_id, type: 'course_unlisted', title: 'Your course was unlisted', body: `"${p.title}" was removed from the catalog.`, link: `/teach/courses/${p.course_id}` });
      if (p.owner_email) this.deliver('CourseUnlisted', p.owner_user_id, p.owner_email, 'Your course was unlisted',
        layout('Course unlisted', html`<p>"${p.title}" was temporarily removed from the catalog. You can re-publish it from your course page (or contact us if an admin unlisted it).</p>`));
    });
  }

  /**
   * When a course is published, notify every learner who follows its category
   * or its instructor — in-app and/or email, per each learner's preferences.
   * Best-effort: a failure for one recipient never blocks the others.
   */
  private async notifyNewCourseFollowers(p: CoursePublishedPayload) {
    let followers: NotificationPreference[];
    try {
      followers = await this.prefs
        .createQueryBuilder('pref')
        .where('(:category = ANY(pref.new_course_categories)) OR (:owner = ANY(pref.new_course_instructor_ids))', {
          category: p.category,
          owner: p.owner_user_id,
        })
        .limit(2000) // safety cap; batch/queue this if follower counts ever get huge
        .getMany();
    } catch (err) {
      this.logger.warn(`new-course fan-out query failed for ${p.course_id}: ${(err as Error).message}`);
      return;
    }
    // Don't notify the instructor about their own course (they get the owner ping).
    followers = followers.filter((f) => f.user_id !== p.owner_user_id);
    if (followers.length === 0) return;

    const instructorName = await this.userName(p.owner_user_id);
    const categoryLabel = courseCategoryLabel(p.category);
    const link = `/courses/${p.course_id}`;
    this.logger.log(`CoursePublished "${p.title}" → notifying ${followers.length} follower(s)`);

    for (const f of followers) {
      const followsInstructor = (f.new_course_instructor_ids ?? []).includes(p.owner_user_id);
      const reason = followsInstructor ? `${instructorName} just published a new course` : `New ${categoryLabel} course`;
      if (f.new_course_in_app !== false) {
        await this.inbox({ user_id: f.user_id, type: 'new_course', title: reason, body: `"${p.title}" is now available. Tap to explore.`, link });
      }
      if (f.new_course_email !== false) {
        const user = await this.userInfo(f.user_id);
        if (!user.email) continue;
        await this.deliver('NewCourseAlert', f.user_id, user.email, `${reason}: ${p.title}`,
          layout(reason, html`<p>Hi ${user.name || 'there'},</p>
          <p>${followsInstructor ? html`<strong>${instructorName}</strong> just published` : html`A new <strong>${categoryLabel}</strong> course just dropped`} on EthiopiaLearn:</p>
          <p style="font-size:16px"><strong>${p.title}</strong></p>
          ${button(`${this.webUrl}${link}`, 'View the course')}
          <p style="color:#6b7280;font-size:12px;margin-top:16px">You're getting this because you follow ${followsInstructor ? 'this instructor' : `the ${categoryLabel} category`}. Manage alerts in your account settings.</p>`));
      }
    }
  }

  /**
   * The QO decided a first submission, an appeal or a post-publish re-check.
   * Only approving a first submission publishes the course; `kind` tells the
   * three apart. Events published before `kind` existed keep the first-publish
   * wording on approve, and coaching falls back to the course's live status.
   * Follower fan-out hangs off CoursePublished, which the course service sends
   * on a first publish only.
   */
  private async notifyCourseReviewed(p: CourseReviewedPayload) {
    const link = p.course_id ? `/teach/courses/${p.course_id}` : '/teach';
    const notes = p.notes ? ` Reviewer notes: ${p.notes}` : '';
    let m: OwnerMessage;
    if (p.action === QaDecisionAction.APPROVE && p.kind === 'post_publish') {
      // The course was already approved; a passed re-check changes nothing, and it may be unlisted.
      m = {
        type: 'course_recheck_passed',
        title: 'Your course passed its quality re-check',
        body: `"${p.course_title}" was re-checked and nothing about it changes.${notes}`,
        subject: 'Your course passed its quality re-check',
        heading: 'Your course passed its re-check',
        html: html`<p>A quality officer re-checked "${p.course_title}" and it passed. Nothing about your course changes.</p>${quote(p.notes)}`,
      };
    } else if (p.action === QaDecisionAction.APPROVE && p.kind === 'appeal') {
      m = {
        type: 'course_appeal_accepted',
        title: 'Your appeal was accepted',
        body: `"${p.course_title}" passed review after your appeal and is published.${notes}`,
        subject: 'Your appeal was accepted',
        heading: 'Your appeal was accepted',
        html: html`<p>A quality officer reviewed your appeal for "${p.course_title}" and approved the course. It is published and learners can find it in the catalog.</p>${quote(p.notes)}`,
      };
    } else if (p.action === QaDecisionAction.APPROVE) {
      m = {
        type: 'course_approved',
        title: 'Your course is live! 🎉',
        body: `"${p.course_title}" passed review and is now published.`,
        subject: 'Your course is live!',
        heading: 'Your course is live! 🎉',
        html: html`<p>"${p.course_title}" passed quality review and is now discoverable by learners.</p>`,
      };
    } else if (p.action === QaDecisionAction.COACH && (await this.coachesLiveCourse(p))) {
      // A post-publish re-review coaches a course that stays in the catalog;
      // only a first submission or an appeal goes back to draft.
      m = {
        type: 'course_coached',
        title: 'Feedback on your live course',
        body: `"${p.course_title}" stays live.${notes}`,
        subject: 'Feedback on your live course',
        heading: 'Feedback on your course',
        html: html`<p>A quality officer re-reviewed "${p.course_title}" and left this feedback:</p>${quote(p.notes)}<p>Your course stays live. Address the feedback in your next update; changes to a live course are reviewed before learners see them.</p>`,
      };
    } else if (p.action === QaDecisionAction.COACH) {
      m = {
        type: 'course_coached',
        title: 'Feedback on your course',
        body: `"${p.course_title}": ${p.notes ?? 'changes requested'}`,
        subject: 'Feedback on your submitted course',
        heading: 'Feedback on your course',
        html: html`<p>"${p.course_title}" needs some changes before it can go live:</p>${quote(p.notes)}<p>The course is back in draft — update it and resubmit.</p>`,
      };
    } else {
      m = {
        type: 'course_flagged',
        title: 'Your course was flagged',
        body: `"${p.course_title}" was flagged. You can appeal from the course page.`,
        subject: 'Your course has been flagged',
        heading: 'Course flagged',
        html: html`<p>"${p.course_title}" was flagged during review for a policy concern. You can submit an appeal from the course page.</p>`,
      };
    }
    await this.inbox({ user_id: p.owner_user_id, type: m.type, title: m.title, body: m.body, link });
    if (p.owner_email) await this.deliver('CourseReviewed', p.owner_user_id, p.owner_email, m.subject, layout(m.heading, m.html));
  }

  /** Whether a coach decision leaves the course live (a post-publish re-check) rather than sending it back to draft. */
  private async coachesLiveCourse(p: CourseReviewedPayload): Promise<boolean> {
    if (p.kind) return p.kind === 'post_publish';
    return LIVE_STATUSES.has((await this.courseStatus(p.course_id)) ?? '');
  }

  /**
   * The QO decided a revision of a live course. A revision never changes the
   * course's status or re-publishes it, so none of these say "your course is
   * live" and none reach followers.
   *
   * Approve and reject send nothing here. The course service acts on a
   * decision only if the revision still holds the content the officer
   * reviewed (a decision about an earlier submission is ignored), so "your
   * update is live" / "was not approved" wait for CourseRevisionClosed
   * (applied / rejected). When an approval
   * cannot be applied, the course service returns the revision with a coach
   * decision of its own that explains why, so the coach wording stays neutral
   * about who sent it back.
   */
  private async notifyRevisionReviewed(p: CourseRevisionReviewedPayload) {
    if (p.action === 'approve' || p.action === 'reject') return;
    const notes = p.notes ? ` Notes: ${p.notes}` : '';
    const unchanged = 'Your course stays live exactly as learners see it now.';
    let m: OwnerMessage;
    if (p.action === 'coach') {
      const title = `Your update to '${p.course_title}' needs another look`;
      m = {
        type: 'revision_coached',
        title,
        body: `Your changes are kept; review them and submit again.${notes}`,
        subject: title,
        heading: 'Your update needs another look',
        html: html`<p>Your changes to "${p.course_title}" were sent back to you before going live:</p>${quote(p.notes)}<p>${unchanged} Your changes are kept; review them and submit again.</p>`,
      };
    } else {
      this.logger.warn(`CourseRevisionReviewed for ${p.course_id} has unknown action "${String(p.action)}"; no notification sent`);
      return;
    }
    await this.notifyRevisionOwner('CourseRevisionReviewed', p, m);
  }

  /**
   * The course service closed a revision. 'applied' and 'rejected' are the
   * points where the decision really took effect (course_title is the
   * post-apply title); a discard was the educator's own action.
   */
  private async notifyRevisionClosed(p: CourseRevisionClosedPayload) {
    if (p.outcome === 'rejected') {
      const title = `Your update to '${p.course_title}' was not approved`;
      await this.notifyRevisionOwner('CourseRevisionClosed', p, {
        type: 'revision_rejected',
        title,
        body: `Your changes were discarded; the live course is unchanged.${p.notes ? ` Notes: ${p.notes}` : ''}`,
        subject: title,
        heading: 'Your update was not approved',
        html: html`<p>A quality officer did not approve your changes to "${p.course_title}":</p>${quote(p.notes)}<p>Your changes were discarded. Your course stays live exactly as learners see it now. You can make new changes and submit them for review.</p>`,
      });
      return;
    }
    if (p.outcome !== 'applied') return;
    const title = `Your update to '${p.course_title}' is live`;
    await this.notifyRevisionOwner('CourseRevisionClosed', p, {
      type: 'revision_approved',
      title,
      body: `Learners now see your changes.${p.notes ? ` Reviewer notes: ${p.notes}` : ''}`,
      subject: title,
      heading: 'Your update is live',
      html: html`<p>A quality officer approved your changes to "${p.course_title}". Learners now see the updated course.</p>${quote(p.notes)}`,
    });
  }

  /** Inbox item + email (with a button to the course) for the owner of a revised course. */
  private async notifyRevisionOwner(
    eventType: string,
    p: { course_id: string; owner_user_id: string; owner_email: string },
    m: OwnerMessage,
  ) {
    const link = `/teach/courses/${p.course_id}`;
    await this.inbox({ user_id: p.owner_user_id, type: m.type, title: m.title, body: m.body, link });
    // Older review items may lack the owner's email; the auth service has it.
    const to = p.owner_email || (p.owner_user_id ? (await this.userInfo(p.owner_user_id)).email : '');
    if (to) await this.deliver(eventType, p.owner_user_id, to, m.subject, layout(m.heading, html`${m.html}${button(`${this.webUrl}${link}`, 'Open your course')}`));
  }

  /** Major course update → every active learner gets an inbox item, and an email unless they opted out. */
  private async notifyCourseUpdated(p: CourseUpdatedPayload) {
    let learnerIds: string[] = [];
    try {
      learnerIds = (await this.internal.get<{ learner_ids: string[] }>(`/api/v1/internal/courses/${p.course_id}/learners`)).learner_ids;
    } catch (err) {
      this.logger.warn(`course-updated fan-out: could not list learners for ${p.course_id}: ${(err as Error).message}`);
      return;
    }
    learnerIds = learnerIds.filter((id) => id !== p.owner_user_id).slice(0, 5000);
    if (!learnerIds.length) return;
    this.logger.log(`CourseUpdated "${p.course_title}" → ${learnerIds.length} learner(s)`);
    for (const learnerId of learnerIds) {
      await this.inbox({ user_id: learnerId, type: 'course_updated', title: `Updated: "${p.course_title}"`, body: p.summary, link: `/learn/${p.course_id}?changelog=1` });
      const pref = await this.prefs.findOne({ where: { user_id: learnerId } });
      if (pref?.course_updates_email === false) continue;
      const user = await this.userInfo(learnerId);
      if (!user.email) continue;
      await this.deliver('CourseUpdated', learnerId, user.email, `"${p.course_title}" has new content`,
        layout('Your course was updated', html`<p>Hi ${user.name || 'there'},</p><p>The instructor updated <strong>"${p.course_title}"</strong>:</p>${quote(p.summary)}${button(`${this.webUrl}/learn/${p.course_id}?changelog=1`, 'See what changed')}`));
    }
  }

  /** Current course status, or null when the course service can't be reached. */
  private async courseStatus(courseId: string): Promise<string | null> {
    try {
      return (await this.internal.get<{ status: string }>(`/api/v1/internal/courses/${courseId}`)).status;
    } catch {
      return null;
    }
  }

  private async userInfo(userId: string): Promise<{ email: string; name: string }> {
    try {
      return await this.internal.get<{ email: string; name: string }>(`/api/v1/internal/users/${userId}`);
    } catch {
      return { email: '', name: '' };
    }
  }

  private async userName(userId: string): Promise<string> {
    return (await this.userInfo(userId)).name || 'An instructor you follow';
  }

  private async inbox(input: InboxInput) {
    if (!input.user_id && !input.role) return;
    try {
      await this.inboxRepo.save(
        this.inboxRepo.create({
          user_id: input.user_id ?? null,
          target_role: input.role ?? null,
          type: input.type,
          title: input.title,
          body: input.body ?? '',
          link: input.link ?? null,
          read_at: null,
        }),
      );
    } catch (err) {
      this.logger.warn(`inbox write failed (${input.type}): ${(err as Error).message}`);
    }
  }

  private async deliver(eventType: string, userId: string | null, to: string, subject: string, html: string) {
    if (!to) {
      this.logger.warn(`skipping ${eventType}: no recipient`);
      return;
    }
    try {
      const { message_id } = await this.email.send({ to, subject, html });
      await this.log.save(
        this.log.create({ user_id: userId, event_type: eventType, channel: 'email', recipient: to, subject, status: 'sent', provider_message_id: message_id }),
      );
      await this.bus.publish('NotificationSent', { user_id: userId, event_type: eventType, channel: 'email' });
    } catch (err) {
      this.logger.error(`email failed for ${eventType} -> ${to}: ${(err as Error).message}`);
      await this.log.save(
        this.log.create({ user_id: userId, event_type: eventType, channel: 'email', recipient: to, subject, status: 'failed', provider_message_id: null }),
      );
    }
  }
}
