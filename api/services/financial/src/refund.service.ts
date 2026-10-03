import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventBusService, InternalHttpClient, internalPath, isUniqueViolation, UserContext } from '@ethiopialearn/common';
import { PaymentStatus, RefundDecisionPayload, RefundRequestedPayload, RefundStatus, Role } from '@ethiopialearn/contracts';
import { PaymentMethod, PaymentPurpose } from '@ethiopialearn/contracts';
import { Payment, RefundRequest } from './entities';

const REFUND_WINDOW_DAYS = 7; // spec §10.4
const ALREADY_OPEN = 'A refund is already open for this payment';

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @InjectRepository(RefundRequest) private readonly refunds: Repository<RefundRequest>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  /** Rule engine per spec §10.4: auto-approve / manual review / deny. */
  async request(ctx: UserContext, paymentId: string, reason: string) {
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.learner_id !== ctx.id) throw new ForbiddenException('Not your payment');
    if (payment.status !== PaymentStatus.CONFIRMED) throw new BadRequestException('Only confirmed payments can be refunded');
    // Legacy rows predate the purpose column and are course purchases.
    if ((payment.purpose ?? PaymentPurpose.COURSE) !== PaymentPurpose.COURSE) {
      throw new BadRequestException('Gifts, sponsored seats, bulk orders and wallet top-ups are refunded by support — contact us from Help');
    }
    if (payment.method === PaymentMethod.WALLET || payment.method === PaymentMethod.COUPON) {
      throw new BadRequestException('Purchases settled with wallet credits or a 100% coupon are refunded by support — contact us from Help');
    }
    // A friendly early answer; the unique index on open requests is the guarantee.
    const existing = await this.refunds.findOne({ where: { payment_id: paymentId, status: In([RefundStatus.PENDING, RefundStatus.APPROVED]) } });
    if (existing) throw new BadRequestException(ALREADY_OPEN);

    const entitlement = await this.internal.get<{
      enrollment_id: string | null;
      enrolled_at: string | null;
      progress_percent: number;
    }>(internalPath`/api/v1/internal/entitlements?learner_id=${ctx.id}&course_id=${payment.course_id}`);

    let rule = '';
    let decision: RefundStatus = RefundStatus.PENDING;

    const daysSinceEnrollment = entitlement.enrolled_at
      ? (Date.now() - new Date(entitlement.enrolled_at).getTime()) / 86_400_000
      : Infinity;
    const progress = entitlement.progress_percent ?? 0;

    if (entitlement.enrollment_id) {
      const outcomes = await this.internal.get<{ certificate_issued: boolean; assessment_passed: boolean }>(
        internalPath`/api/v1/internal/enrollments/${entitlement.enrollment_id}/outcomes-status`,
      );
      if (outcomes.certificate_issued) {
        decision = RefundStatus.DENIED;
        rule = 'certificate_already_issued';
      } else if (outcomes.assessment_passed) {
        decision = RefundStatus.DENIED;
        rule = 'assessment_already_passed';
      }
    }

    if (!rule) {
      if (daysSinceEnrollment > REFUND_WINDOW_DAYS) {
        decision = RefundStatus.DENIED;
        rule = 'outside_7_day_window';
      } else if (progress < 20) {
        decision = RefundStatus.APPROVED;
        rule = 'auto_approve_under_20pct_within_7d';
      } else if (progress <= 50) {
        decision = RefundStatus.PENDING; // manual review at admin discretion
        rule = 'manual_review_20_to_50pct';
        // TODO(spec-open-question §14): exact partial-refund % is undecided —
        // admin decides; config constant PARTIAL_REFUND_PERCENT reserved.
      } else {
        // TODO(spec-open-question): >50% consumed within 7 days is not covered
        // by §10.4 — denying as the conservative default.
        decision = RefundStatus.DENIED;
        rule = 'over_50pct_consumed';
      }
    }

    let refund: RefundRequest;
    try {
      refund = await this.refunds.save(
        this.refunds.create({
          payment_id: paymentId,
          learner_id: ctx.id,
          reason,
          status: decision,
          decision_rule: rule,
          decided_at: decision === RefundStatus.PENDING ? null : new Date(),
          decided_by: null, // automated
        }),
      );
    } catch (err) {
      // A concurrent request for the same payment got in first.
      if (isUniqueViolation(err)) throw new BadRequestException(ALREADY_OPEN);
      throw err;
    }

    if (decision === RefundStatus.APPROVED) await this.finalizeApproval(refund, payment);
    if (decision === RefundStatus.DENIED) await this.emitDecision('RefundDenied', refund, payment);
    // Manual-review band: a platform admin must decide — notify them.
    if (decision === RefundStatus.PENDING) await this.emitRequested(refund, payment);
    return { refund_id: refund.id, status: refund.status, rule };
  }

  /** Admin decision for the 20-50% manual-review band. Decided once: a second or concurrent decision is refused. */
  async decide(adminId: string, refundId: string, approve: boolean) {
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException('Refund request not found');
    if (refund.status !== RefundStatus.PENDING) throw new BadRequestException('Already decided');
    const payment = await this.payments.findOne({ where: { id: refund.payment_id } });
    if (!payment) throw new NotFoundException('Payment not found');

    const decision = { status: approve ? RefundStatus.APPROVED : RefundStatus.DENIED, decided_at: new Date(), decided_by: adminId };
    const decided = await this.refunds.update({ id: refund.id, status: RefundStatus.PENDING }, decision);
    if (decided.affected !== 1) throw new BadRequestException('Already decided');
    Object.assign(refund, decision);

    if (approve) await this.finalizeApproval(refund, payment);
    else await this.emitDecision('RefundDenied', refund, payment);
    return refund;
  }

  async listMine(ctx: UserContext) {
    return this.refunds.find({ where: { learner_id: ctx.id }, order: { created_at: 'DESC' } });
  }

  async listPending(ctx: UserContext) {
    if (ctx.role !== Role.PLATFORM_ADMIN) throw new ForbiddenException();
    return this.refunds.find({ where: { status: RefundStatus.PENDING }, order: { created_at: 'ASC' } });
  }

  /** Refunds the payment once: RefundApproved (which revokes access) goes out only for the request that refunded it. */
  private async finalizeApproval(refund: RefundRequest, payment: Payment) {
    const refunded = await this.payments.update({ id: payment.id, status: PaymentStatus.CONFIRMED }, { status: PaymentStatus.REFUNDED });
    if (refunded.affected !== 1) {
      this.logger.warn(`refund ${refund.id} approved, but payment ${payment.id} is no longer confirmed: not refunding it again`);
      return;
    }
    payment.status = PaymentStatus.REFUNDED;
    // TODO(spec-open-question): initiate the actual Chapa refund API call here
    // when live credentials are configured; ledger + entitlement revocation
    // (via RefundApproved) are the authoritative MVP behavior.
    await this.emitDecision('RefundApproved', refund, payment);
    this.logger.log(`refund approved for payment ${payment.id} (${refund.decision_rule})`);
  }

  private async emitRequested(refund: RefundRequest, payment: Payment) {
    let learnerEmail = '';
    try {
      const learner = await this.internal.get<{ email: string }>(internalPath`/api/v1/internal/users/${payment.learner_id}`);
      learnerEmail = learner.email;
    } catch {
      /* enrichment best-effort */
    }
    await this.bus.publish<RefundRequestedPayload>('RefundRequested', {
      refund_request_id: refund.id,
      payment_id: payment.id,
      learner_id: payment.learner_id,
      learner_email: learnerEmail,
      course_id: payment.course_id,
      course_title: payment.course_title,
      amount_etb: Number(payment.amount_etb),
      reason: refund.decision_rule,
    });
    this.logger.log(`refund ${refund.id} awaiting admin decision (${refund.decision_rule})`);
  }

  private async emitDecision(event: 'RefundApproved' | 'RefundDenied', refund: RefundRequest, payment: Payment) {
    let learnerEmail = '';
    try {
      const learner = await this.internal.get<{ email: string }>(internalPath`/api/v1/internal/users/${payment.learner_id}`);
      learnerEmail = learner.email;
    } catch {
      /* enrichment best-effort */
    }
    await this.bus.publish<RefundDecisionPayload>(event, {
      refund_request_id: refund.id,
      payment_id: payment.id,
      tx_ref: payment.chapa_tx_ref,
      learner_id: payment.learner_id,
      learner_email: learnerEmail,
      course_id: payment.course_id,
      course_title: payment.course_title,
      amount_etb: Number(payment.amount_etb),
      reason: refund.decision_rule,
    });
  }
}
