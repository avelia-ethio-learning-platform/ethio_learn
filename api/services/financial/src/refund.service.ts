import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { EventBusService, InternalHttpClient, internalPath, isUniqueViolation, UserContext } from '@ethiopialearn/common';
import { EntitlementStatus, PaymentStatus, RefundDecisionPayload, RefundRequestedPayload, RefundStatus, Role } from '@ethiopialearn/contracts';
import { PaymentMethod, PaymentPurpose } from '@ethiopialearn/contracts';
import { Payment, RefundRequest } from './entities';
import { GrowthService } from './growth.service';

const REFUND_WINDOW_DAYS = 7; // spec §10.4
const DAY_MS = 86_400_000;
const ALREADY_OPEN = 'A refund is already open for this payment';
/** A payment already in a payout is refunded by support: there is no clawback from the educator here. */
const PAID_OUT = 'This payment has already been paid out to the educator. Contact support from Help to request a refund.';

/** When the payment was confirmed (COALESCE(webhook_received_at, created_at)): the clock of the refund window and of its credits' hold. */
const purchasedAt = (p: Payment): Date => p.webhook_received_at ?? p.created_at;

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @InjectRepository(RefundRequest) private readonly refunds: Repository<RefundRequest>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly growth: GrowthService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Rule engine per spec §10.4: auto-approve / manual review / deny. The rules
   * run first, so a late request gets its denial whatever else is true. A
   * denial touches only the request row, so the payment stays claimable by a
   * payout. A request the rules accept (manual review or auto-approve) marks
   * the payment and is filed in one transaction, and an auto-approval
   * refunds it in that transaction too (see approveWith).
   */
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
    // A friendly early answer; the payment mark (and behind it the unique index on open requests) is the guarantee.
    const existing = await this.refunds.findOne({ where: { payment_id: paymentId, status: In([RefundStatus.PENDING, RefundStatus.APPROVED]) } });
    if (existing) throw new BadRequestException(ALREADY_OPEN);

    const entitlement = await this.internal.get<{
      entitlement_status: EntitlementStatus;
      enrollment_id: string | null;
      progress_percent: number;
    }>(internalPath`/api/v1/internal/entitlements?learner_id=${ctx.id}&course_id=${payment.course_id}`);

    let rule = '';
    let decision: RefundStatus = RefundStatus.PENDING;

    // The window runs from the payment's confirmation, the same clock its
    // pending cashback and referral reward are held on, so a re-purchase gets
    // a window of its own. Only an active entitlement is judged on it. With
    // none, or one still refunded (a re-purchase whose grant isn't consumed
    // yet), the window stays closed, as before: a refund approved then could
    // be followed by the grant, which would activate access on a refunded
    // payment.
    const granted = entitlement.entitlement_status === EntitlementStatus.ACTIVE;
    const daysSincePurchase = granted ? (Date.now() - purchasedAt(payment).getTime()) / DAY_MS : Infinity;
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
      if (daysSincePurchase > REFUND_WINDOW_DAYS) {
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

    const draft: Partial<RefundRequest> = {
      payment_id: paymentId,
      learner_id: ctx.id,
      reason,
      status: decision,
      decision_rule: rule,
      decided_at: decision === RefundStatus.PENDING ? null : new Date(),
      decided_by: null, // automated
    };

    if (decision === RefundStatus.DENIED) {
      const refund = await this.file(this.refunds, draft);
      await this.emitDecision('RefundDenied', refund, payment);
      return { refund_id: refund.id, status: refund.status, rule };
    }

    const filed = await this.dataSource.transaction(async (m) => {
      // UPDATE through query() resolves to [rows, rowCount].
      const [, marked]: [unknown[], number] = await m.query(
        `UPDATE ${this.paymentsTable(m)} SET refund_requested_at = now() WHERE id = $1 AND status = 'confirmed' AND payout_id IS NULL AND refund_requested_at IS NULL`,
        [paymentId],
      );
      // Nothing written yet, so the transaction just ends; why is worked out below.
      if (marked !== 1) return null;
      const refund = await this.file(m.getRepository(RefundRequest), draft);
      const voided = decision === RefundStatus.APPROVED ? await this.approveWith(m, refund, payment) : null;
      return { refund, voided };
    });
    if (!filed) throw await this.unmarkable(paymentId);

    const { refund, voided } = filed;
    if (decision === RefundStatus.APPROVED) await this.finalizeApproval(refund, payment, voided);
    // Manual-review band: a platform admin must decide — notify them.
    else await this.emitRequested(refund, payment);
    return { refund_id: refund.id, status: refund.status, rule };
  }

  /**
   * Admin decision for the 20-50% manual-review band. Decided once: a second or
   * concurrent decision is refused. The decision and its effect on the payment
   * are one transaction: an approval refunds the payment (approveWith); a
   * denial clears the payment's refund mark, so payouts can claim it again and
   * its pending credits release when they mature.
   */
  async decide(adminId: string, refundId: string, approve: boolean) {
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException('Refund request not found');
    if (refund.status !== RefundStatus.PENDING) throw new BadRequestException('Already decided');
    const payment = await this.payments.findOne({ where: { id: refund.payment_id } });
    if (!payment) throw new NotFoundException('Payment not found');

    const decision = { status: approve ? RefundStatus.APPROVED : RefundStatus.DENIED, decided_at: new Date(), decided_by: adminId };
    const outcome = await this.dataSource.transaction(async (m) => {
      const decided = await m.getRepository(RefundRequest).update({ id: refund.id, status: RefundStatus.PENDING }, decision);
      // Another decision got in first. Nothing written, so the transaction just ends.
      if (decided.affected !== 1) return { decided: false as const };
      if (approve) return { decided: true as const, voided: await this.approveWith(m, refund, payment) };
      await m.query(`UPDATE ${this.paymentsTable(m)} SET refund_requested_at = NULL WHERE id = $1`, [payment.id]);
      return { decided: true as const, voided: null };
    });
    if (!outcome.decided) throw new BadRequestException('Already decided');
    Object.assign(refund, decision);

    if (approve) await this.finalizeApproval(refund, payment, outcome.voided);
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

  /** Inserts the request row. A concurrent open request for the payment trips the unique index: ALREADY_OPEN. */
  private async file(repo: Repository<RefundRequest>, draft: Partial<RefundRequest>): Promise<RefundRequest> {
    try {
      return await repo.save(repo.create(draft));
    } catch (err) {
      if (isUniqueViolation(err)) throw new BadRequestException(ALREADY_OPEN);
      throw err;
    }
  }

  /** Why an accepted request couldn't mark its payment, read after the fact. */
  private async unmarkable(paymentId: string): Promise<Error> {
    const current = await this.payments.findOne({ where: { id: paymentId } });
    if (!current) return new NotFoundException('Payment not found');
    if (current.payout_id) return new BadRequestException(PAID_OUT);
    // Marked by a request that got in first (a decision may have settled it since).
    if (current.refund_requested_at || current.status === PaymentStatus.CONFIRMED) return new BadRequestException(ALREADY_OPEN);
    return new BadRequestException('Only confirmed payments can be refunded');
  }

  /**
   * An approval's writes, in its transaction (after the request row is
   * approved): the payment flips confirmed → refunded, then its pending
   * cashback and referral reward are voided. The flip runs once per payment,
   * so the void does too.
   * - A payment already in a payout throws the support message, which rolls
   *   the whole decision back (a legacy request filed before the mark).
   * - A payment no longer confirmed for another reason is left alone, and so
   *   are its credits: the decision stands, and nothing is announced.
   * Returns how many credits were voided, or null when nothing was refunded.
   */
  private async approveWith(m: EntityManager, refund: RefundRequest, payment: Payment): Promise<number | null> {
    const [, flipped]: [unknown[], number] = await m.query(
      `UPDATE ${this.paymentsTable(m)} SET status = 'refunded' WHERE id = $1 AND status = 'confirmed' AND payout_id IS NULL`,
      [payment.id],
    );
    if (flipped === 1) return this.growth.voidPurchaseCredits(m, payment.id);
    const current = await m.getRepository(Payment).findOne({ where: { id: payment.id } });
    if (current?.payout_id) {
      this.logger.warn(`refund ${refund.id}: payment ${payment.id} is already in payout ${current.payout_id}, so it goes to support`);
      throw new BadRequestException(PAID_OUT);
    }
    this.logger.warn(`refund ${refund.id} approved, but payment ${payment.id} is no longer confirmed: not refunding it again`);
    return null;
  }

  /** After the approval commits: RefundApproved (which revokes access) goes out only for the approval that refunded the payment. */
  private async finalizeApproval(refund: RefundRequest, payment: Payment, voided: number | null) {
    if (voided === null) return;
    payment.status = PaymentStatus.REFUNDED;
    // TODO(spec-open-question): initiate the actual Chapa refund API call here
    // when live credentials are configured; ledger + entitlement revocation
    // (via RefundApproved) are the authoritative MVP behavior.
    await this.emitDecision('RefundApproved', refund, payment);
    this.logger.log(`refund approved for payment ${payment.id} (${refund.decision_rule}); ${voided} pending credit(s) voided`);
  }

  private paymentsTable(m: EntityManager): string {
    return m.getRepository(Payment).metadata.tablePath;
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
